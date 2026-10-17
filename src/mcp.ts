/**
 * Minimal MCP (Model Context Protocol) client over stdio.
 *
 * One server process speaks newline-delimited JSON-RPC 2.0 on stdin/stdout:
 * `initialize`, `tools/list`, then `tools/call`. Only stdio servers are
 * supported; HTTP/SSE transports are a separate concern.
 *
 * Configure in ~/.prometheus/mcp.json (or <workspace>/.prometheus/mcp.json):
 *
 *   { "servers": { "files": { "command": "npx", "args": ["-y", "@scope/server"] } } }
 *
 * Tool names are prefixed with the server name (`files__read`) so two servers
 * can expose the same tool without colliding.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import type { Tool, ToolResult } from "./types.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Skip loading this server without deleting its entry. */
  disabled?: boolean;
}

export interface McpConfigFile {
  servers?: Record<string, McpServerConfig>;
}

export function readMcpConfig(cwd: string): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  for (const file of [join(CONFIG_HOME, "mcp.json"), join(cwd, ".prometheus", "mcp.json")]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as McpConfigFile;
      for (const [name, server] of Object.entries(parsed.servers ?? {})) {
        if (server && typeof server.command === "string") merged[name] = server;
      }
    } catch {
      /* an unreadable config file should not stop the session */
    }
  }
  return merged;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private readonly child;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  /** Set when the process could not be spawned at all. */
  private spawnError: Error | null = null;

  constructor(name: string, config: McpServerConfig) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // On Windows, .cmd/.bat shims (npx, uvx) need a shell; real executables
      // must not have one, or the shell mangles the arguments.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(config.command),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Servers often log to stderr; keep it from filling the pipe.
    this.child.stderr.on("data", () => {});
    this.child.on("error", (err) => {
      this.spawnError = err;
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
    });
    this.child.on("exit", () => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server "${name}" exited`));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "MCP error"));
      else pending.resolve(message.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (this.spawnError) return Promise.reject(this.spawnError);
    if (this.closed) return Promise.reject(new Error("MCP server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "prometheus", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
    const result = (await this.request("tools/list", {})) as { tools?: unknown[] };
    return Array.isArray(result?.tools) ? (result.tools as never[]) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, 120_000)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result?.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    return { content: text || "(no output)", isError: Boolean(result?.isError) };
  }

  dispose(): void {
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

export interface LoadedMcp {
  clients: McpClient[];
  tools: Tool[];
  errors: string[];
}

/**
 * Start every configured server, initialize it, and wrap its tools as local
 * tools. A server that fails is reported and skipped; the others still load.
 */
export async function loadMcpTools(cwd: string, timeoutMs = 15_000): Promise<LoadedMcp> {
  const configs = readMcpConfig(cwd);
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  const errors: string[] = [];

  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      if (config.disabled) return;
      const client = new McpClient(name, config);
      try {
        await withTimeout(client.initialize(), timeoutMs, `MCP server "${name}" did not initialize`);
        const listed = await withTimeout(client.listTools(), timeoutMs, `MCP server "${name}" did not list tools`);
        clients.push(client);
        for (const entry of listed) {
          if (!entry?.name) continue;
          const toolName = `mcp__${name}__${entry.name}`;
          tools.push({
            name: toolName,
            description: entry.description ?? `MCP tool ${entry.name} from ${name}`,
            // MCP tools can have side effects the schema does not describe, so
            // they prompt in ask mode and are unavailable in plan mode.
            readonly: false,
            parameters: entry.inputSchema ?? { type: "object", properties: {} },
            summarize: (input) => {
              const first = Object.values(input).find((value) => typeof value === "string");
              return String(first ?? entry.name).slice(0, 120);
            },
            execute: (input) => client.callTool(entry.name, input),
          });
        }
      } catch (err) {
        client.dispose();
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  return { clients, tools, errors };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
