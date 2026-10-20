/**
 * Reasoning levels are per model, not a fixed four.
 *
 * The four-value enum (`auto|low|medium|high`) is what OpenAI's first
 * `reasoning_effort` accepted. Gateways now advertise their own sets per
 * model — this build's own gateway reports `low/high/max` for one model,
 * `high/xhigh` for another, `low/medium/high/xhigh/max` for a third, and a
 * fixed `medium` for a fourth — and sending a level a model does not list is
 * a 400 on a strict gateway. The picker therefore has to be built from
 * `GET /models`, and `auto` has to mean "the endpoint's own default".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A temp config home: `discoverModels` caches per base URL under it, and
// `loadConfig` reads it. Both are import-time constants.
const home = mkdtempSync(join(tmpdir(), "prometheus-effort-"));
process.env.PROMETHEUS_HOME = home;
process.env.PROMETHEUS_API_KEY = "test-key";

const { discoverModels } = await import("../src/models.ts");
const { validEffort, loadConfig } = await import("../src/config.ts");

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Serve `/models` with the reasoning fields this gateway uses. */
async function withModelServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/models")) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "space-bunny",
            context_length: 1_000_000,
            supports_tool_calls: true,
            reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
            reasoning_default_effort: "max",
            reasoning_can_disable: false,
          },
          {
            id: "glm-5.2",
            supports_tool_calls: true,
            reasoning_efforts: ["high", "xhigh"],
            reasoning_default_effort: "high",
          },
          {
            id: "glm-5.1",
            supports_tool_calls: true,
            reasoning_fixed_effort: "medium",
          },
          {
            // No reasoning metadata at all: a plain chat model.
            id: "plain-chat",
            supports_tool_calls: true,
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the levels a model advertises are carried through discovery, in the endpoint's order", async () => {
  await withModelServer(async (baseUrl) => {
    const catalog = await discoverModels(baseUrl, "k", { force: true });
    const bunny = catalog.models.find((model) => model.id === "space-bunny");
    assert.deepEqual(bunny?.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(bunny?.reasoningDefault, "max");
    assert.equal(bunny?.reasoningCanDisable, false);

    // Alphabetical sorting would put `xhigh` before `high`; the endpoint's
    // order is the one that means "low to high".
    const glm = catalog.models.find((model) => model.id === "glm-5.2");
    assert.deepEqual(glm?.reasoningEfforts, ["high", "xhigh"]);
  });
});

test("a model with a fixed level advertises no list, so the picker cannot offer a choice it ignores", async () => {
  await withModelServer(async (baseUrl) => {
    const catalog = await discoverModels(baseUrl, "k", { force: true });
    const fixed = catalog.models.find((model) => model.id === "glm-5.1");
    assert.equal(fixed?.reasoningFixed, "medium");
    assert.equal(fixed?.reasoningEfforts, undefined);

    const plain = catalog.models.find((model) => model.id === "plain-chat");
    assert.equal(plain?.reasoningEfforts, undefined);
    assert.equal(plain?.reasoningFixed, undefined);
  });
});

test("a default the model does not list is replaced by its highest advertised level", async () => {
  // A gateway that says `default: minimal` while only offering `low/high` would
  // make "auto" send a level the model rejects. The highest level is the honest
  // reading of "auto" when the advertised default is unusable.
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "mismatched",
            supports_tool_calls: true,
            reasoning_efforts: ["low", "high"],
            reasoning_default_effort: "minimal",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const catalog = await discoverModels(`http://127.0.0.1:${port}/v1`, "k", { force: true });
    const model = catalog.models.find((entry) => entry.id === "mismatched");
    assert.equal(model?.reasoningDefault, "high");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("configured levels accept a gateway's own spelling and reject a malformed value", () => {
  // The old validator knew four names and dropped everything else, so a user
  // whose model offers `max` could not select it from a file or a flag.
  assert.equal(validEffort("max"), "max");
  assert.equal(validEffort("xhigh"), "xhigh");
  assert.equal(validEffort("minimal"), "minimal");
  assert.equal(validEffort("auto"), "auto");
  assert.equal(validEffort("  high  "), "high");
  // Not a level: empty, whitespace, punctuation, or something that would go on
  // the wire as a malformed parameter.
  assert.equal(validEffort(""), undefined);
  assert.equal(validEffort("   "), undefined);
  assert.equal(validEffort("very high"), undefined);
  assert.equal(validEffort("1e5"), undefined);
  assert.equal(validEffort("../../etc"), undefined);
  assert.equal(validEffort("x".repeat(40)), undefined);
});

test("a config file's reasoning level survives loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "prometheus-effort-cfg-"));
  const previous = process.cwd();
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model: "m" }));
    writeFileSync(
      join(dir, ".prometheus-config.json"),
      JSON.stringify({ thinkingEffort: "xhigh" }),
    );
    mkdirSync(join(dir, ".prometheus"), { recursive: true });
    writeFileSync(join(dir, ".prometheus", "config.json"), JSON.stringify({ thinkingEffort: "xhigh" }));
    process.chdir(dir);
    const config = loadConfig();
    assert.equal(config.thinkingEffort, "xhigh");
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
