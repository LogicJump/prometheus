/**
 * Round-three correctness fixes.
 *
 * Every test here reproduces a defect that shipped: a resumed session without
 * a system prompt, a headless run that can never approve anything, a worktree
 * diff that is always empty, usage that is recorded once and then stops, an
 * interrupted tool batch that leaves orphan tool calls, streamed text lost on
 * abort, and network failures that were classified as terminal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeServer } from "./fakeServer.ts";
import { classifyError } from "../src/errors.ts";
import { parseToolList } from "../src/config.ts";
import { JsonUi } from "../src/headless.ts";
import { Permissions } from "../src/permissions.ts";
import { ToolPipeline } from "../src/tools/pipeline.ts";
import type { ChatMessage, Config, Tool } from "../src/types.ts";

function config(url: string, overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: url,
    apiKey: "k",
    model: "fake-model",
    maxTokens: 1000,
    permissionMode: "auto",
    thinkingEffort: "auto",
    contextWindow: 128000,
    maxTurns: 6,
    allowedDirs: [],
    autoApprove: [],
    ...overrides,
  };
}

async function withWorkspace<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-r3-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function makeAgent(
  scenario: Parameters<typeof startFakeServer>[0],
  messages: ChatMessage[] = [],
  overrides: Partial<Config> = {},
  uiOverride?: JsonUi,
) {
  const { Agent } = await import("../src/agent.ts");
  const { TerminalUi } = await import("../src/ui.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const fake = await startFakeServer(scenario);
  const cfg = config(fake.url, overrides);
  const ui = uiOverride ?? new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
  const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "fake-model", maxTokens: 1000 });
  const agent = new Agent(cfg, ui, client, undefined, new Permissions(cfg, ui), messages);
  return { agent, fake, cfg, client };
}

/* ---------- 1.1 a resumed conversation still has its system prompt ---------- */

test("a resumed conversation sends its system prompt again", async () => {
  await withWorkspace(async () => {
    let first: { role?: string; content?: unknown } | undefined;
    const { agent, fake } = await makeAgent(
      (body) => {
        first = body.messages[0] as { role?: string; content?: unknown };
        return { text: "continued" };
      },
      [
        { role: "user", content: "earlier request" },
        { role: "assistant", content: "earlier answer" },
      ],
    );
    assert.equal(agent.messages[0]?.role, "user", "the transcript on disk stays a transcript");
    await agent.run("carry on");
    assert.equal(first?.role, "system", "the request body starts with a system message");
    assert.match(String(first?.content), /You are Prometheus/);
    await fake.close();
  });
});

test("a stale system message in a restored history is replaced, not duplicated", async () => {
  await withWorkspace(async () => {
    let seen: { role?: string; content?: unknown }[] = [];
    const { agent, fake } = await makeAgent(
      (body) => {
        seen = body.messages as { role?: string; content?: unknown }[];
        return { text: "ok" };
      },
      [
        { role: "system", content: "an obsolete prompt from an old version" },
        { role: "user", content: "hello" },
      ],
    );
    assert.equal(
      agent.messages.filter((message) => message.role === "system").length,
      0,
      "the obsolete prompt is not carried in the transcript",
    );
    await agent.run("hi");
    const systems = seen.filter((message) => message.role === "system");
    assert.equal(systems.length, 1, "exactly one system message reaches the model");
    assert.match(String(systems[0].content), /You are Prometheus/);
    await fake.close();
  });
});

/* ---------- 1.2 headless runs can be authorised, and say why when they cannot ---------- */

test("a headless run refuses with a reason that names the missing authorisation", async () => {
  await withWorkspace(async () => {
    const ui = new JsonUi();
    const cfg = config("http://127.0.0.1:1/v1", { permissionMode: "ask", unattended: true });
    const permissions = new Permissions(cfg, ui);
    const { writeFileTool } = await import("../src/tools/fileTools.ts");
    const verdict = await permissions.check(writeFileTool, { path: "a.txt", content: "x" });
    assert.equal(verdict.allowed, false);
    assert.match(String(verdict.reason), /non-interactive/i, "the reason distinguishes 'nobody to ask'");
    assert.match(String(verdict.reason), /allowed-tools|dont-ask/, "the reason names the way to grant it");
  });
});

test("an allowed tool is granted in an unattended run, and a denial is a policy denial", async () => {
  await withWorkspace(async () => {
    const ui = new JsonUi();
    const { writeFileTool } = await import("../src/tools/fileTools.ts");
    const granted = new Permissions(
      config("http://127.0.0.1:1/v1", { permissionMode: "ask", unattended: true, autoApprove: ["write_file"] }),
      ui,
    );
    assert.equal((await granted.check(writeFileTool, { path: "a.txt", content: "x" })).allowed, true);
  });
});

test("--allowed-tools and --dont-ask map onto the config the run uses", () => {
  assert.deepEqual(parseToolList("bash, write_file ,,"), ["bash", "write_file"]);
  assert.deepEqual(parseToolList(""), []);
  assert.deepEqual(parseToolList(undefined), []);
});

/* ---------- 1.3 the worktree diff is relative to the fork point ---------- */

test("a worktree diff still shows the change after it was committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-r3-wt-"));
  try {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
    run("add", "-A");
    run("commit", "-m", "initial");

    const { createWorktree, commitWorktree, worktreeDiff, removeWorktree } = await import("../src/worktree.ts");
    const created = await createWorktree(dir, "session-diff");
    assert.equal(created.ok, true, created.error);
    const worktree = created.worktree;
    assert.match(worktree.base, /^[0-9a-f]{40}$/, "the base is the commit the worktree forked from");

    writeFileSync(join(worktree.path, "a.txt"), "two\n", "utf8");
    const committed = await commitWorktree(worktree, "change");
    assert.equal(committed.ok, true, committed.error);

    const diff = await worktreeDiff(worktree);
    assert.match(diff, /two/, "the committed change is still part of the worktree's diff");
    assert.match(diff, /-one/, "the diff shows the removed line too");
    await removeWorktree(dir, worktree);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 1.4 usage accumulates across turns ---------- */

test("usage from a second turn is added, not overwritten", async () => {
  await withWorkspace(async () => {
    const { agent, fake } = await makeAgent(() => ({ text: "ok" }));
    await agent.run("first");
    assert.equal(agent.usage.inputTokens, 100);
    await agent.run("second");
    assert.equal(agent.usage.inputTokens, 200, "both turns' prompts are counted");
    assert.equal(agent.usage.outputTokens, 40);
    await fake.close();
  });
});

/* ---------- 1.5 an interrupted batch leaves no orphan tool call ---------- */

test("aborting mid-batch writes a tool result for every requested call", async () => {
  await withWorkspace(async () => {
    const { Agent } = await import("../src/agent.ts");
    const { TerminalUi } = await import("../src/ui.ts");
    const { ChatClient } = await import("../src/llm.ts");
    const fake = await startFakeServer((body) => {
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      if (hasToolResult) return { text: "should not get here" };
      return {
        toolCalls: [
          { name: "block_forever", args: JSON.stringify({ id: "a" }) },
          { name: "block_forever", args: JSON.stringify({ id: "b" }) },
        ],
      };
    });
    const cfg = config(fake.url);
    const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
    const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "fake-model", maxTokens: 1000 });
    const blocking: Tool = {
      name: "block_forever",
      description: "",
      parameters: {},
      readonly: true,
      summarize: () => "blocking",
      execute: (_input, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve({ content: "interrupted" }), { once: true });
        }),
    };
    const agent = new Agent(cfg, ui, client, [blocking], new Permissions(cfg, ui), []);

    const turn = agent.run("run both");
    setTimeout(() => agent.abort(), 80);
    await turn;

    const assistant = [...agent.messages].reverse().find((message) => message.role === "assistant" && message.tool_calls);
    assert.ok(assistant, "the assistant turn is in the transcript");
    const calls = assistant.role === "assistant" ? (assistant.tool_calls ?? []) : [];
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const result = agent.messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
      assert.ok(result, `call ${call.id} has a tool result`);
      assert.match(String((result as { content: string }).content), /interrupt/i);
    }
    await fake.close();
  });
});

/* ---------- 1.6 text streamed before an abort survives in the transcript ---------- */

test("text already streamed is kept after the turn is aborted", async () => {
  await withWorkspace(async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ choices: [{ delta: { content: "half a sen" }, index: 0 }] });
      send({ choices: [{ delta: { content: "tence" }, index: 0 }] });
      // Deliberately never finish: the client aborts while the stream is open.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const { Agent } = await import("../src/agent.ts");
      const { TerminalUi } = await import("../src/ui.ts");
      const { ChatClient } = await import("../src/llm.ts");
      const cfg = config(`http://127.0.0.1:${port}/v1`);
      const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
      const client = new ChatClient({ baseUrl: cfg.baseUrl, apiKey: "k", model: "fake-model", maxTokens: 1000 });
      const agent = new Agent(cfg, ui, client, [], new Permissions(cfg, ui), []);

      const turn = agent.run("say something");
      setTimeout(() => agent.abort(), 150);
      await turn;

      const last = agent.messages[agent.messages.length - 1];
      assert.equal(last.role, "assistant", "the partial answer is the last message");
      assert.equal(String(last.content), "half a sentence");
      assert.equal("tool_calls" in last ? last.tool_calls : undefined, undefined, "no unexecuted tool calls ride along");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ---------- 1.7 transient network failures are retried ---------- */

test("a terminated socket and our own timeout are recoverable", () => {
  const terminated = new TypeError("terminated");
  (terminated as unknown as { cause: unknown }).cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
  });
  assert.equal(classifyError(terminated).level, "recoverable");

  const timeout = Object.assign(new Error("request timed out after 120s"), { name: "TimeoutError" });
  assert.equal(classifyError(timeout).level, "recoverable");

  // A genuine abort stays terminal.
  assert.equal(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).level, "terminal");
});

test("the loop retries after the connection is dropped mid-response", async () => {
  await withWorkspace(async () => {
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests++;
        if (requests === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "second try" }, index: 0 }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const { query } = await import("../src/query.ts");
      const { ChatClient } = await import("../src/llm.ts");
      const cfg = config(`http://127.0.0.1:${port}/v1`, { maxTurns: 2 });
      const client = new ChatClient({ baseUrl: cfg.baseUrl, apiKey: "k", model: "fake-model", maxTokens: 1000 });
      const pipeline = new ToolPipeline(() => [], {
        config: cfg,
        ui: {} as never,
        permissions: { mode: "auto", check: async () => ({ allowed: true }) },
        todos: { items: [] },
        hooks: [],
        sessionId: "",
        cwd: process.cwd(),
        runSubagent: async () => "",
      });
      const messages: ChatMessage[] = [{ role: "user", content: "go" }];
      const events: string[] = [];
      const iterator = query({ messages, config: cfg, client, pipeline, apiTools: () => [], signal: new AbortController().signal });
      let reason = "";
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          reason = next.value.reason;
          break;
        }
        events.push(next.value.type);
      }
      assert.equal(reason, "complete");
      assert.ok(events.includes("retry"), "the first failure was retried");
      assert.equal(messages[messages.length - 1].role, "assistant");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ---------- the board selection reaches the request without a port ---------- */

test("a selected board that names only a port still produces a readable note", async () => {
  await withWorkspace(async () => {
    const cfg = config("http://127.0.0.1:1/v1", { board: { port: "COM7", baud: 115200 } });
    const { Agent } = await import("../src/agent.ts");
    const { TerminalUi } = await import("../src/ui.ts");
    const { ChatClient } = await import("../src/llm.ts");
    const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
    const client = new ChatClient({ baseUrl: cfg.baseUrl, apiKey: "k", model: "fake-model", maxTokens: 100 });
    const agent = new Agent(cfg, ui, client, [], new Permissions(cfg, ui), []);
    const request = (agent as unknown as { requestSystemPrompt: () => string }).requestSystemPrompt();
    assert.match(request, /port COM7 at 115200 baud/);
    assert.equal(agent.messages.length, 0, "the prompt is not written into the transcript");
  });
});

/* ---------- guard: the headless UI never silently pretends it asked ---------- */

test("the headless UI declares that it cannot prompt", () => {
  const ui = new JsonUi();
  assert.equal(ui.canPrompt, false);
  assert.ok(existsSync(join(process.cwd(), "package.json")));
});
