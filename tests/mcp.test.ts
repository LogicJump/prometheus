/** MCP client: initialize, list tools, and call one against a fake server. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpClient, loadMcpTools, readMcpConfig } from "../src/mcp.ts";

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
  const client = new McpClient("fake", { command: process.execPath, args: [SERVER] });
  try {
    await client.initialize();
    await assert.rejects(() => client.request("bogus/method", {}), /no method/);
  } finally {
    client.dispose();
  }
});
