/** End-to-end: agent loop -> tool call -> file write, against a fake server. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeServer } from "./fakeServer.ts";

async function makeAgent(workspace: string, scenario: Parameters<typeof startFakeServer>[0]) {
  const { Agent } = await import("../src/agent.ts");
  const { TerminalUi } = await import("../src/ui.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { Permissions } = await import("../src/permissions.ts");
  const fake = await startFakeServer(scenario);

  const config = {
    baseUrl: fake.url,
    apiKey: "test",
    model: "fake-model",
    maxTokens: 4000,
    permissionMode: "auto" as const,
    contextWindow: 128000,
    maxTurns: 10,
    allowedDirs: [],
    autoApprove: [],
  };
  const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
  const client = new ChatClient({ baseUrl: config.baseUrl, apiKey: "test", model: "fake-model", maxTokens: 4000 });
  const agent = new Agent(config, ui, client, undefined, new Permissions(config, ui), []);
  return { agent, fake, client };
}

test("agent writes a file through a tool call, then answers", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-e2e-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    let turn = 0;
    const { agent, fake } = await makeAgent(workspace, (body) => {
      turn++;
      const hasResult = body.messages.some((m) => m.role === "tool");
      if (!hasResult) {
        return {
          toolCalls: [{ name: "write_file", args: JSON.stringify({ path: "hello.txt", content: "from the agent\n" }) }],
        };
      }
      return { text: "Wrote hello.txt." };
    });

    await agent.run("create hello.txt");
    assert.ok(existsSync(join(workspace, "hello.txt")), "file should exist");
    assert.equal(readFileSync(join(workspace, "hello.txt"), "utf8"), "from the agent\n");

    const last = agent.messages[agent.messages.length - 1];
    assert.equal(last.role, "assistant");
    assert.match(String(last.content), /Wrote hello\.txt/);
    await fake.close();
  } finally {
    process.chdir(previous);
  }
});

test("edit_file replaces an exact match and refuses ambiguity", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-edit-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    writeFileSync(join(workspace, "a.txt"), "alpha\nbeta\nbeta\n");
    let turn = 0;
    const { agent, fake } = await makeAgent(workspace, (body) => {
      turn++;
      const toolResults = body.messages.filter((m) => m.role === "tool");
      if (turn === 1) {
        return { toolCalls: [{ name: "edit_file", args: JSON.stringify({ path: "a.txt", old_string: "beta", new_string: "gamma" }) }] };
      }
      if (turn === 2) {
        const first = toolResults[0];
        assert.match(String(first.content), /ambiguous/);
        return { toolCalls: [{ name: "edit_file", args: JSON.stringify({ path: "a.txt", old_string: "beta", new_string: "gamma", replace_all: true }) }] };
      }
      return { text: "done" };
    });

    await agent.run("replace beta with gamma");
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "alpha\ngamma\ngamma\n");
    await fake.close();
  } finally {
    process.chdir(previous);
  }
});

test("bash tool runs a command and reports failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-bash-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    let turn = 0;
    const { agent, fake } = await makeAgent(workspace, () => {
      turn++;
      if (turn === 1) {
        return { toolCalls: [{ name: "bash", args: JSON.stringify({ command: "echo hi && exit 3" }) }] };
      }
      return { text: "saw the failure" };
    });

    await agent.run("run it");
    const toolMessage = agent.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "tool result present");
    assert.match(String(toolMessage.content), /Error:/);
    assert.match(String(toolMessage.content), /exit code 3/);
    assert.match(String(toolMessage.content), /hi/);
    await fake.close();
  } finally {
    process.chdir(previous);
  }
});

test("path escapes are rejected", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-safe-"));
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    let turn = 0;
    const { agent, fake } = await makeAgent(workspace, () => {
      turn++;
      if (turn === 1) {
        return { toolCalls: [{ name: "read_file", args: JSON.stringify({ path: "../../etc/passwd" }) }] };
      }
      return { text: "blocked" };
    });
    await agent.run("read outside");
    const toolMessage = agent.messages.find((m) => m.role === "tool");
    assert.match(String(toolMessage.content), /escapes the workspace/);
    await fake.close();
  } finally {
    process.chdir(previous);
  }
});
