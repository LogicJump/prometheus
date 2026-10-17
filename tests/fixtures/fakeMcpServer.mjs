/** A tiny stdio MCP server used by tests: one echo tool. */

import { stdin, stdout } from "node:process";

let buffer = "";
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
    if (message.id === undefined) continue;
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
    } else if (message.method === "tools/list") {
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo the text back",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      };
    } else if (message.method === "tools/call") {
      const text = String(message.params?.arguments?.text ?? "");
      result = { content: [{ type: "text", text: `echo:${text}` }] };
    } else {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no method" } })}\n`);
      continue;
    }
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }
});
stdin.on("end", () => process.exit(0));
