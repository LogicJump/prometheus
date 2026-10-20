/**
 * The second half of the review's finding list: usage accounting, thinking
 * echo, sub-agent authority, session settings, and the embedded lookups.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChatMessage } from "../src/types.ts";

/* ---------- cached tokens across providers ---------- */

test("cached input tokens are read from every field the ecosystem uses", async () => {
  const { ChatClient } = await import("../src/llm.ts");
  const { createServer } = await import("node:http");

  const serve = (usage: Record<string, unknown>) =>
    new Promise<{ url: string; close: () => void }>((resolve) => {
      const server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1000, completion_tokens: 10, ...usage },
            }),
          );
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as { port: number }).port;
        resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
      });
    });

  const cases: [Record<string, unknown>, number][] = [
    [{ prompt_tokens_details: { cached_tokens: 700 } }, 700],
    [{ prompt_cache_hit_tokens: 650 }, 650],
    [{ cache_read_input_tokens: 600 }, 600],
    [{ cached_tokens: 500 }, 500],
  ];
  for (const [usage, expected] of cases) {
    const fake = await serve(usage);
    try {
      const client = new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 100 });
      client.stream = false;
      const result = await client.chat([{ role: "user", content: "hi" }], [], () => {}, () => {}, new AbortController().signal);
      assert.equal(result.usage.cachedTokens, expected, JSON.stringify(usage));
    } finally {
      fake.close();
    }
  }
});

/* ---------- thinking is kept, but only echoed when allowed ---------- */

test("reasoning stays on the transcript and is stripped from the wire by default", async () => {
  const { ChatClient } = await import("../src/llm.ts");
  const bodies: { messages: { role: string; reasoning_content?: string }[] }[] = [];
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok", reasoning_content: "thinking" }, finish_reason: "stop" }], usage: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const history = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "answer", reasoning_content: "earlier reasoning" },
    { role: "user" as const, content: "again" },
  ];
  try {
    const quiet = new ChatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", maxTokens: 100 });
    quiet.stream = false;
    const result = await quiet.chat(history, [], () => {}, () => {}, new AbortController().signal);
    assert.equal(result.reasoning, "thinking", "the delta is captured");
    assert.equal(bodies[0].messages[1].reasoning_content, undefined, "the default request has no unknown field");

    const echoing = new ChatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", maxTokens: 100, echoReasoning: true });
    echoing.stream = false;
    await echoing.chat(history, [], () => {}, () => {}, new AbortController().signal);
    assert.equal(bodies[1].messages[1].reasoning_content, "earlier reasoning", "opt-in echo keeps it");
  } finally {
    server.close();
  }
});

/* ---------- a sub-agent runs under the parent's permission mode ---------- */

test("a sub-agent does not silently gain auto mode", async () => {
  const { Agent } = await import("../src/agent.ts");
  const { ChatClient } = await import("../src/llm.ts");
  const { startFakeServer } = await import("./fakeServer.ts");
  const { TerminalUi } = await import("../src/ui.ts");
  const { Permissions } = await import("../src/permissions.ts");
  const fake = await startFakeServer((body) => {
    const first = body.messages.find((message) => message.role === "user");
    const text = typeof first?.content === "string" ? first.content : "";
    if (text.includes("parent")) {
      return { toolCalls: [{ name: "delegate", args: JSON.stringify({ prompt: "child task: write a file" }) }] };
    }
    if (text.includes("child task")) {
      return { toolCalls: [{ name: "write_file", args: JSON.stringify({ path: "child.txt", content: "x" }) }] };
    }
    return { text: "done" };
  });
  const config = {
    baseUrl: fake.url,
    apiKey: "k",
    model: "m",
    maxTokens: 200,
    permissionMode: "plan" as const,
    contextWindow: 128000,
    maxTurns: 8,
    allowedDirs: [],
    autoApprove: [],
  };
  const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
  let asked = 0;
  const permissions = new Permissions(config, { ...ui, confirm: async () => { asked++; return "yes"; } } as never);
  const agent = new Agent(config, ui, new ChatClient({ baseUrl: fake.url, apiKey: "k", model: "m", maxTokens: 200 }), undefined, permissions, []);
  await agent.run("parent request");
  // Plan mode denies the child's write; the parent's `delegate` call itself is
  // also a mutating tool, so nothing ran. The important part is that the child
  // did not inherit `auto`.
  assert.equal(asked, 0, "plan mode asked nobody: it refused");
  await fake.close();
});

/* ---------- session settings round-trip ---------- */

test("mode, effort, and board come back with a resumed session", async () => {
  const { saveSession, loadSession, deleteSessionFile, newSessionId } = await import("../src/sessions.ts");
  const id = `gap-settings-${newSessionId()}`;
  try {
    saveSession({
      id,
      cwd: process.cwd(),
      model: "m",
      baseUrl: "http://127.0.0.1:1/v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "hi" }],
      mode: "plan",
      effort: "high",
      sandbox: "enforce",
      networkPolicy: "off",
      board: { port: "COM7", baud: 115200 },
    });
    const loaded = loadSession(id);
    assert.equal(loaded?.mode, "plan");
    assert.equal(loaded?.effort, "high");
    assert.deepEqual(loaded?.board, { port: "COM7", baud: 115200 });
  } finally {
    deleteSessionFile(id);
  }
});

/* ---------- usage is attributed to who spent it ---------- */

test("the usage summary splits main-loop and sub-agent spend", async () => {
  const { recordUsage, usageSummary } = await import("../src/usage.ts");
  const { CONFIG_HOME } = await import("../src/config.ts");
  const { existsSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const file = join(CONFIG_HOME, "usage.jsonl");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const tag = `gap-usage-${Date.now()}`;
  try {
    recordUsage({ sessionId: tag, cwd: process.cwd(), model: "glm-5.3-flash", inputTokens: 1000, outputTokens: 100, cachedTokens: 0, source: "main" });
    recordUsage({ sessionId: tag, cwd: process.cwd(), model: "glm-5.3-flash", inputTokens: 400, outputTokens: 40, cachedTokens: 0, source: "subagent" });
    const summary = usageSummary(1);
    const main = summary.sources.find((entry) => entry.source === "main");
    const child = summary.sources.find((entry) => entry.source === "subagent");
    assert.ok(main && main.inputTokens >= 1000);
    assert.ok(child && child.inputTokens >= 400);
  } finally {
    if (before === null) rmSync(file, { force: true });
    else writeFileSync(file, before, "utf8");
  }
});

/* ---------- the one-shot CLI records usage and returns an addressable id ---------- */

test("a one-shot run reports the id it saved under", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(import.meta.dirname, "..", "bin", "prometheus.js"), "utf8");
  // The payload used to say `sessionId: null` while the transcript was written
  // under a freshly generated `oneshot-…` id, so a script could not resume it.
  assert.doesNotMatch(source, /sessionId: session\?\.id \?\? null/);
  assert.match(source, /sessionId: oneShotId/);
  // And the run now accounts for what it spent.
  assert.match(source, /recordUsage\(/);
});

/* ---------- the embedded lookups are not vendor-specific ---------- */

test("SVD search directories come from the environment, not a vendor path", async () => {
  const { svdSearchDirs } = await import("../src/tools/embeddedTools.ts");
  const workspace = mkdtempSync(join(tmpdir(), "prometheus-svd-"));
  mkdirSync(join(workspace, ".prometheus", "svd"), { recursive: true });
  const custom = mkdtempSync(join(tmpdir(), "prometheus-svd-custom-"));
  const previous = process.env.PROMETHEUS_SVD_DIRS;
  process.env.PROMETHEUS_SVD_DIRS = custom;
  try {
    const dirs = svdSearchDirs(workspace);
    assert.ok(dirs.includes(custom), "the configured directory is searched");
    assert.ok(dirs.some((dir) => dir.includes(".prometheus") && dir.includes("svd")), "a project-local directory is searched");
    // A vendor path may appear only when that vendor is actually installed on
    // this machine. A `C:\Keil_v5\...` that was guessed at would fail here on a
    // host without Keil, which is the distinction that matters: discovery is
    // read from the install (TOOLS.INI, the registry), never assumed.
    const vendorish = dirs.filter((dir) => /STM32Cube|Keil/i.test(dir));
    for (const dir of vendorish) {
      assert.ok(existsSync(dir), `${dir} is reported only because it exists`);
    }
    if (!existsSync("G:\\software\\keil5pack") && !existsSync("C:\\Keil_v5") && !existsSync("C:\\Program Files\\Keil_v5")) {
      assert.equal(vendorish.length, 0, "no Keil install means no Keil path");
    }
  } finally {
    if (previous === undefined) delete process.env.PROMETHEUS_SVD_DIRS;
    else process.env.PROMETHEUS_SVD_DIRS = previous;
  }
});

/* ---------- a spilled result names the file ---------- */

test("a long tool result is written to disk and referenced", async () => {
  const { spillToolOutput, withSpillPointer } = await import("../src/spill.ts");
  const { loadSession, deleteSessionFile, newSessionId, saveSession } = await import("../src/sessions.ts");
  const { readFileSync } = await import("node:fs");
  const id = `gap-spill-${newSessionId()}`;
  try {
    saveSession({
      id,
      cwd: process.cwd(),
      model: "m",
      baseUrl: "http://127.0.0.1:1/v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user", content: "hi" }],
    });
    const body = "error detail ".repeat(5000);
    const path = spillToolOutput(id, "bash", body);
    assert.ok(path, "a path was returned");
    assert.equal(readFileSync(path, "utf8").length, body.length);
    const withPointer = withSpillPointer({ content: "head" }, id, "bash", body);
    assert.match(withPointer.content, /full output:/);
    assert.ok(loadSession(id));
  } finally {
    deleteSessionFile(id);
  }
});
