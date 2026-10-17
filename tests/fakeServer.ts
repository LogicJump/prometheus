/** Deterministic fake OpenAI-compatible server for end-to-end tests. */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Scenario = (body: {
  messages: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
}) => { text?: string; toolCalls?: { name: string; args: string }[] };

export async function startFakeServer(scenario: Scenario): Promise<{ url: string; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests++;
      const body = JSON.parse(raw || "{}");
      const step = scenario(body);
      const toolCalls = (step.toolCalls ?? []).map((call, i) => ({
        id: `call_${requests}_${i}`,
        type: "function",
        function: { name: call.name, arguments: call.args },
      }));

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ choices: [{ delta: { role: "assistant" }, index: 0 }] });
      for (const ch of (step.text ?? "").match(/[\s\S]{1,4}/g) ?? []) {
        send({ choices: [{ delta: { content: ch }, index: 0 }] });
      }
      toolCalls.forEach((call, index) => {
        send({
          choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }, index: 0 }],
        });
        send({
          choices: [{ delta: { tool_calls: [{ index, function: { arguments: call.function.arguments } }] }, index: 0 }],
        });
      });
      send({
        choices: [{ delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop", index: 0 }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 0 },
          total_tokens: 120,
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
