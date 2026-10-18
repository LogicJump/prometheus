/** Model fallback: which failures move to the next model, and the event trail. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, ChatClient } from "../src/llm.ts";
import { FallbackChatClient, buildFallbackClients, shouldFallBack } from "../src/fallback.ts";
import { startFakeServer } from "./fakeServer.ts";

test("only model-level failures trigger a fallback", () => {
  assert.equal(shouldFallBack(new ApiError(404, "model not found")), true);
  assert.equal(shouldFallBack(new ApiError(429, "rate limited")), true);
  assert.equal(shouldFallBack(new ApiError(503, "unavailable")), true);
  assert.equal(shouldFallBack(new ApiError(400, "model `x` does not exist")), true);
  assert.equal(shouldFallBack(new ApiError(401, "bad key")), false);
  assert.equal(shouldFallBack(new ApiError(400, "invalid messages")), false);
  assert.equal(shouldFallBack(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
});

test("a failing primary is retried on the fallback and the event is reported", async () => {
  const good = await startFakeServer(() => ({ text: "from the fallback" }));
  const events: string[] = [];
  // A primary pointing at a closed port fails with a connection error.
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const dead = createServer();
  dead.listen(0, "127.0.0.1");
  await once(dead, "listening");
  const deadPort = dead.address().port;
  dead.close();
  await once(dead, "close");
  const primary = new ChatClient({ baseUrl: `http://127.0.0.1:${deadPort}/v1`, apiKey: "k", model: "primary", maxTokens: 100, timeoutMs: 2_000 });
  const fallback = new ChatClient({ baseUrl: good.url, apiKey: "k", model: "fallback", maxTokens: 100 });
  const client = new FallbackChatClient({
    primary,
    fallbacks: () => [fallback],
    onFallback: (from, to, reason) => events.push(`${from}->${to}:${reason.includes("HTTP") ? "http" : "network"}`),
  });
  const result = await client.chat([{ role: "user", content: "hi" }], [], () => {}, () => {}, new AbortController().signal);
  assert.equal(result.content, "from the fallback");
  assert.deepEqual(events, ["primary->fallback:network"]);
  await good.close();
});

test("an auth failure is not retried on another model", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const server = createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const primary = new ChatClient({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "primary", maxTokens: 100 });
  let built = 0;
  const client = new FallbackChatClient({
    primary,
    fallbacks: () => {
      built++;
      return [];
    },
  });
  await assert.rejects(() => client.chat([{ role: "user", content: "hi" }], [], () => {}, () => {}, new AbortController().signal), /401/);
  assert.equal(built <= 1, true, "no needless round trip after a terminal failure");
  server.closeAllConnections();
  server.close();
});

test("fallback clients reuse the endpoint and drop a concrete effort", () => {
  const primary = new ChatClient({ baseUrl: "http://x/v1", apiKey: "k", model: "one", maxTokens: 10, reasoningEffort: "high" });
  const clients = buildFallbackClients(primary, ["one", "two", ""]);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].options.model, "two");
  assert.equal(clients[0].options.baseUrl, "http://x/v1");
  assert.equal(clients[0].options.reasoningEffort, "auto");
});
