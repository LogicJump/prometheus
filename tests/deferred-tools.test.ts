/**
 * Deferred tool schemas: the request carries less, `tool_search` unlocks what
 * the model actually needs.
 *
 * Every tool definition is part of every request. A handful of MCP tools costs
 * less than a search round trip, so deferral only starts above a threshold; the
 * tests pin both sides of that line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent } from "../src/agent.ts";
import { TerminalUi } from "../src/ui.ts";
import { Permissions } from "../src/permissions.ts";
import type { Config, Tool } from "../src/types.ts";

function makeAgent(tools: Tool[] = []): Agent {
  const config: Config = {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m",
    maxTokens: 100,
    permissionMode: "auto",
    contextWindow: 128000,
    maxTurns: 5,
    allowedDirs: [],
    autoApprove: [],
  } as Config;
  const ui = new TerminalUi({ write: () => true } as unknown as NodeJS.WriteStream);
  // The client is never called by these tests; the constructor only stores it.
  return new Agent(config, ui, { chat: async () => ({}) } as never, tools, new Permissions(config, ui), []);
}

function tool(name: string, deferred = false): Tool {
  return {
    name,
    description: `${name} does a thing`,
    readonly: true,
    ...(deferred ? { deferred: true } : {}),
    parameters: { type: "object", properties: {} },
    summarize: () => name,
    execute: async () => ({ content: "ok" }),
  };
}

test("no deferred tools means no search tool in the request", () => {
  const agent = makeAgent([tool("read_file"), tool("bash")]);
  const names = agent.testVisibleTools().map((entry) => entry.name);
  assert.deepEqual(names, ["read_file", "bash"]);
  assert.ok(!names.includes("tool_search"), "a search tool with nothing to search is noise");
});

test("a deferred tool is hidden until tool_search unlocks it", async () => {
  const agent = makeAgent([tool("read_file"), tool("mcp__files__read", true), tool("mcp__files__write", true)]);
  const before = agent.testVisibleTools().map((entry) => entry.name);
  assert.deepEqual(before, ["read_file", "tool_search"]);

  const search = agent.testVisibleTools().find((entry) => entry.name === "tool_search")!;
  const result = await search.execute({ query: "read" }, {} as never);
  assert.match(result.content, /Enabled 1 tool/);
  assert.match(result.content, /mcp__files__read/);

  const after = agent.testVisibleTools().map((entry) => entry.name);
  assert.ok(after.includes("mcp__files__read"), "the unlocked tool is callable");
  assert.ok(!after.includes("mcp__files__write"), "an unrelated deferred tool stays hidden");
});

test("an empty search lists everything still deferred", async () => {
  const agent = makeAgent([tool("mcp__a__one", true), tool("mcp__a__two", true)]);
  const search = agent.testVisibleTools().find((entry) => entry.name === "tool_search")!;
  const result = await search.execute({ query: "" }, {} as never);
  assert.match(result.content, /mcp__a__one/);
  assert.match(result.content, /mcp__a__two/);
  // Everything was unlocked, so the catalogue is empty afterwards.
  assert.deepEqual(agent.deferredCatalogue(), []);
});

test("removing the last deferred tool removes the search tool", () => {
  const agent = makeAgent([tool("read_file")]);
  agent.addTools([tool("mcp__late__x", true)]);
  assert.ok(agent.testVisibleTools().some((entry) => entry.name === "tool_search"));
  agent.replaceToolsByPrefix("mcp__late__", []);
  assert.ok(!agent.testVisibleTools().some((entry) => entry.name === "tool_search"));
});

test("the MCP loader defers only past the threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-defer-"));
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".prometheus"), { recursive: true });
    const server = join(import.meta.dirname, "fixtures", "fakeMcpServer.mjs");
    writeFileSync(
      join(dir, ".prometheus", "mcp.json"),
      JSON.stringify({ servers: { fake: { command: process.execPath, args: [server] } } }),
      "utf8",
    );
    const { loadMcpTools } = await import("../src/mcp.ts");
    const loaded = await loadMcpTools(dir, 10_000);
    try {
      // Three tools is under the threshold, so they stay in the request.
      assert.equal(loaded.deferred, false);
      assert.ok(loaded.tools.filter((entry) => entry.name.startsWith("mcp__")).every((entry) => !entry.deferred));
    } finally {
      for (const client of loaded.clients) client.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
