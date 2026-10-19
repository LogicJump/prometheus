/**
 * A tiny stdio MCP server used by tests.
 *
 * It covers the parts of the protocol the client has to get right: a tool, a
 * paginated `tools/list`, a prompt with a real body, and a `tools/call` that
 * can emit a non-text part. A tool named `announce` sends
 * `notifications/tools/list_changed` so the client's refresh path has something
 * to react to.
 */

import { stdin, stdout } from "node:process";

let buffer = "";
let announced = false;
let nextServerId = 1_000_000;
/** Server request id → the `tools/call` id waiting for its answer. */
const pendingElicitations = new Map();

function write(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // A response to a request this server issued has no method. That is the
    // elicitation answer; turn it into the result of the waiting tools/call.
    if (message.method === undefined) {
      const callId = pendingElicitations.get(message.id);
      if (callId !== undefined) {
        pendingElicitations.delete(message.id);
        const answer = message.error ? `error:${message.error.message}` : JSON.stringify(message.result ?? null);
        write({ jsonrpc: "2.0", id: callId, result: { content: [{ type: "text", text: `elicited:${answer}` }] } });
      }
      continue;
    }
    // A notification from the client has no id and expects no answer.
    if (message.id === undefined) continue;

    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true }, prompts: {} },
        serverInfo: { name: "fake", version: "1" },
      };
    } else if (message.method === "tools/list") {
      // Two pages, so the client's cursor handling is exercised.
      const cursor = message.params?.cursor;
      if (!cursor) {
        result = {
          tools: [
            {
              name: "echo",
              description: "Echo the text back",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            },
            { name: "announce", description: "Emit a list_changed notification", inputSchema: { type: "object", properties: {} } },
            { name: "ask", description: "Ask the user a question through elicitation", inputSchema: { type: "object", properties: {} } },
          ],
          nextCursor: "page-2",
        };
      } else {
        result = {
          tools: [{ name: "shot", description: "Return an image part", inputSchema: { type: "object", properties: {} } }],
        };
      }
    } else if (message.method === "tools/call") {
      const name = message.params?.name;
      if (name === "announce") {
        announced = true;
        write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        result = { content: [{ type: "text", text: "announced" }] };
      } else if (name === "ask") {
        // Server-initiated request: the client must answer this id with a
        // result, not with an error.
        const elicitationId = nextServerId++;
        pendingElicitations.set(elicitationId, message.id);
        write({
          jsonrpc: "2.0",
          id: elicitationId,
          method: "elicitation/create",
          params: {
            message: "Which profile should the build use?",
            requestedSchema: {
              type: "object",
              properties: { profile: { type: "string", title: "Profile", enum: ["debug", "release"] } },
              required: ["profile"],
            },
          },
        });
        continue;
      } else if (name === "shot") {
        result = {
          content: [
            { type: "text", text: "captured" },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ],
        };
      } else {
        const text = String(message.params?.arguments?.text ?? "");
        result = { content: [{ type: "text", text: `echo:${text}` }] };
      }
    } else if (message.method === "prompts/list") {
      result = {
        prompts: [
          {
            name: "review",
            description: "Review a file",
            arguments: [{ name: "path", required: true }],
          },
        ],
      };
    } else if (message.method === "prompts/get") {
      const path = String(message.params?.arguments?.path ?? "");
      result = {
        description: "Review a file",
        messages: [{ role: "user", content: { type: "text", text: `Review the file at ${path} and list defects.` } }],
      };
    } else if (message.method === "resources/list") {
      result = { resources: [{ uri: "file:///readme.md", name: "README", mimeType: "text/markdown" }] };
    } else if (message.method === "resources/read") {
      result = { contents: [{ uri: message.params?.uri, text: "# readme" }] };
    } else {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no method", data: { method: message.method } } });
      continue;
    }
    write({ jsonrpc: "2.0", id: message.id, result });
  }
});

void announced;
stdin.on("end", () => process.exit(0));
