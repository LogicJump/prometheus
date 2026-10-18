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
      assert.equal(loaded.tools.length, 1);
      const tool = loaded.tools[0];
      assert.equal(tool.name, "mcp__fake__echo");
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
