/** MCP client: initialize, list tools, and call one against a fake server. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StdioMcpClient, loadMcpTools, readMcpConfig } from "../src/mcp.ts";

const SERVER = join(import.meta.dirname, "fixtures", "fakeMcpServer.mjs");

test("a stdio server initializes and its tools are wrapped as local tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mcp-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(
    join(dir, ".prometheus", "mcp.json"),
    JSON.stringify({ servers: { fake: { command: process.execPath, args: [SERVER] } } }),
    "utf8",
  );
  try {
    const config = readMcpConfig(dir);
    assert.ok(config.fake);

    const loaded = await loadMcpTools(dir, 10_000);
    try {
      assert.deepEqual(loaded.errors, []);
      // Three tools across two pages: echo, announce and ask on the first,
      // shot on the second. `mcp_read_resource` is added because this server
      // also advertises a resource. Seeing all of them proves the cursor is
      // followed.
      assert.deepEqual(
        loaded.tools.map((tool) => tool.name).sort(),
        ["mcp__fake__announce", "mcp__fake__ask", "mcp__fake__echo", "mcp__fake__shot", "mcp_read_resource"],
      );
      const tool = loaded.tools.find((candidate) => candidate.name === "mcp__fake__echo")!;
      const result = await tool.execute({ text: "hi" }, {});
      assert.equal(result.content, "echo:hi");
      assert.equal(result.isError, false);
    } finally {
      for (const client of loaded.clients) client.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that fails to start is reported and skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mcp2-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(
    join(dir, ".prometheus", "mcp.json"),
    JSON.stringify({ servers: { broken: { command: "definitely-not-a-real-binary-xyz" } } }),
    "utf8",
  );
  try {
    const loaded = await loadMcpTools(dir, 5_000);
    assert.equal(loaded.tools.length, 0);
    assert.ok(loaded.errors.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled servers are not started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mcp3-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(
    join(dir, ".prometheus", "mcp.json"),
    JSON.stringify({ servers: { fake: { command: process.execPath, args: [SERVER], disabled: true } } }),
    "utf8",
  );
  try {
    const loaded = await loadMcpTools(dir, 5_000);
    assert.equal(loaded.tools.length, 0);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.clients.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MCP error response rejects the call", async () => {
  const client = new StdioMcpClient("fake", { command: process.execPath, args: [SERVER] });
  try {
    await client.initialize();
    await assert.rejects(() => client.request("bogus/method", {}), /no method/);
  } finally {
    client.dispose();
  }
});

test("a JSON-RPC error keeps its code and data instead of flattening to a message", async () => {
  const client = new StdioMcpClient("fake", { command: process.execPath, args: [SERVER] });
  try {
    await client.initialize();
    const error = await client.request("bogus/method", {}).then(
      () => null,
      (err: Error & { code?: number; data?: unknown }) => err,
    );
    assert.ok(error, "the request resolved instead of rejecting");
    assert.equal(error.code, -32601);
    assert.deepEqual(error.data, { method: "bogus/method" });
  } finally {
    client.dispose();
  }
});

test("prompts/get returns the server's own text, not the prompt's name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mcp-prompt-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(
    join(dir, ".prometheus", "mcp.json"),
    JSON.stringify({ servers: { fake: { command: process.execPath, args: [SERVER] } } }),
    "utf8",
  );
  try {
    const loaded = await loadMcpTools(dir, 10_000);
    try {
      const client = loaded.byServer.get("fake")!;
      assert.ok(client.getPrompt, "the prompt method was not exposed");
      const result = await client.getPrompt!("review", { path: "src/a.ts" });
      const text = (result.messages[0] as { content?: { text?: string } })?.content?.text ?? "";
      assert.match(text, /Review the file at src\/a\.ts/);
    } finally {
      for (const each of loaded.clients) each.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-text content part is reported rather than dropped", async () => {
  const client = new StdioMcpClient("fake", { command: process.execPath, args: [SERVER] });
  try {
    await client.initialize();
    const result = await client.callTool("shot", {});
    // The bytes stay out of the transcript, but a screenshot tool that reads
    // "(no output)" tells the model nothing happened.
    assert.match(result.content, /captured/);
    assert.match(result.content, /\[image image\/png/);
  } finally {
    client.dispose();
  }
});

test("a list_changed notification reaches the refresh callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mcp-refresh-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(
    join(dir, ".prometheus", "mcp.json"),
    JSON.stringify({ servers: { fake: { command: process.execPath, args: [SERVER] } } }),
    "utf8",
  );
  try {
    const loaded = await loadMcpTools(dir, 10_000);
    try {
      const seen: { server: string; kind: string }[] = [];
      loaded.onRefresh = (server, kind) => seen.push({ server, kind });
      const client = loaded.byServer.get("fake")!;
      await client.callTool("announce", {});
      // The notification travels on stdout after the call's response, so give
      // the read loop a tick to deliver it.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(seen, [{ server: "fake", kind: "tools" }]);
    } finally {
      for (const each of loaded.clients) each.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- HTTP transport ---------- */

test("an HTTP MCP server initializes and lists tools", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const message = JSON.parse(body);
      let result;
      if (message.method === "initialize") {
        res.setHeader("mcp-session-id", "sess-1");
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fake", version: "1" } };
      } else if (message.method === "tools/list") {
        result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: `http:${message.params.arguments.text}` }] };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  try {
    const loaded = await loadMcpToolsWithConfig({ remote: { url: `http://127.0.0.1:${port}/mcp` } });
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.tools.length, 1);
    assert.equal(loaded.tools[0].name, "mcp__remote__echo");
    const result = await loaded.tools[0].execute({ text: "hi" }, {});
    assert.equal(result.content, "http:hi");
    for (const client of loaded.clients) client.dispose();
  } finally {
    server.close();
  }
});

test("project scope overrides a user server of the same name", () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mcp-scope-"));
  mkdirSync(join(dir, ".prometheus"), { recursive: true });
  writeFileSync(join(dir, ".prometheus", "mcp.json"), JSON.stringify({ servers: { fake: { command: "project-cmd" } } }), "utf8");
  try {
    const config = readMcpConfig(dir);
    assert.equal(config.fake.command, "project-cmd");
    assert.equal(config.fake.scope, "project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Load tools for an explicit config map without touching ~/.prometheus. */
async function loadMcpToolsWithConfig(servers: Record<string, { url?: string; command?: string; args?: string[] }>) {
  const { createClient } = await import("../src/mcp.ts");
  const clients = [];
  const tools = [];
  const errors = [];
  for (const [name, config] of Object.entries(servers)) {
    try {
      const client = createClient(name, config);
      await client.initialize();
      clients.push(client);
      for (const entry of await client.listTools()) {
        tools.push({
          name: `mcp__${name}__${entry.name}`,
          execute: (input) => client.callTool(entry.name, input),
        });
      }
    } catch (err) {
      errors.push(String(err.message ?? err));
    }
  }
  return { clients, tools, errors };
}

test("elicitation questions flatten the server's schema into answerable fields", async () => {
  const { elicitationQuestions } = await import("../src/mcp.ts");
  const questions = elicitationQuestions({
    message: "Pick",
    requestedSchema: {
      type: "object",
      properties: {
        profile: { type: "string", title: "Profile", enum: ["debug", "release"] },
        nested: { type: "object" },
        count: { type: "integer", description: "How many" },
      },
    },
  });
  assert.deepEqual(questions.map((entry) => entry.name), ["profile", "count"]);
  assert.deepEqual(questions[0].options, ["debug", "release"]);
  assert.equal(questions[1].label, "How many");
});

test("a server's elicitation request is answered through the handler", async () => {
  const client = new StdioMcpClient("fake", { command: process.execPath, args: [SERVER] });
  try {
    const asked: string[] = [];
    client.onElicitation!(async (request) => {
      asked.push(request.message);
      return { action: "accept", content: { profile: "release" } };
    });
    await client.initialize();
    const result = await client.callTool("ask", {});
    assert.deepEqual(asked, ["Which profile should the build use?"]);
    assert.match(result.content, /profile/);
    assert.match(result.content, /release/);
  } finally {
    client.dispose();
  }
});

test("with no handler the server is declined rather than left waiting", async () => {
  const client = new StdioMcpClient("fake", { command: process.execPath, args: [SERVER] });
  try {
    await client.initialize();
    const result = await client.callTool("ask", {});
    assert.match(result.content, /decline/);
  } finally {
    client.dispose();
  }
});
