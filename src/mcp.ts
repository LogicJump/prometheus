/**
 * MCP (Model Context Protocol) client with two transports and two scopes.
 *
 * Transports:
 *   stdio   a child process speaking newline-delimited JSON-RPC on stdio
 *           (the default; `command` + `args`)
 *   http    a Streamable HTTP endpoint (the `url` form); each JSON-RPC
 *           message is POSTed and the response is read from the body, with
 *           an SSE response parsed when the server streams it
 *
 * Scopes:
 *   user      ~/.prometheus/mcp.json                 available everywhere
 *   project   <workspace>/.prometheus/mcp.json       this repository only
 *
 * A project server with the same name overrides the user server. There is no
 * OAuth flow: credentials are environment variables or headers in the config
 * file, which keeps the trust boundary where the user put it.
 *
 * Config:
 *
 *   { "servers": {
 *       "files":  { "command": "npx", "args": ["-y", "@scope/server"] },
 *       "remote": { "url": "https://mcp.example.com/mcp",
 *                   "headers": { "Authorization": "Bearer ..." } },
 *       "off":    { "command": "...", "disabled": true }
 *   } }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import type { Tool, ToolResult } from "./types.ts";

export interface McpServerConfig {
  /** stdio: the executable to start. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http: the Streamable HTTP endpoint. */
  url?: string;
  headers?: Record<string, string>;
  /** Skip loading this server without deleting its entry. */
  disabled?: boolean;
  /** "stdio" or "http"; inferred from command/url when absent. */
  type?: string;
}

export type McpScope = "user" | "project";

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpConfigFile {
  servers?: Record<string, McpServerConfig>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpClient {
  initialize(): Promise<void>;
  listTools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Optional: servers that expose resources or prompts are not required to. */
  listResources?(): Promise<McpResource[]>;
  readResource?(uri: string): Promise<string>;
  listPrompts?(): Promise<McpPrompt[]>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  dispose(): void;
}

function transportOf(config: McpServerConfig): "stdio" | "http" {
  if (config.type === "http" || config.type === "sse") return "http";
  if (config.type === "stdio") return "stdio";
  return config.url ? "http" : "stdio";
}

export class StdioMcpClient implements McpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private spawnError: Error | null = null;

  constructor(name: string, config: McpServerConfig) {
    if (!config.command) throw new Error(`MCP server "${name}" has no command`);
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // On Windows, .cmd/.bat shims (npx, uvx) need a shell; real executables
      // must not have one, or the shell mangles the arguments.
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(config.command),
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    // Servers often log to stderr; keep it from filling the pipe.
    this.child.stderr?.on("data", () => {});
    this.child.on("error", (err) => {
      this.spawnError = err;
      this.failAll(err);
    });
    this.child.on("exit", () => this.failAll(new Error(`MCP server "${name}" exited`)));
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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
      this.settle(message);
    }
  }

  private settle(message: { id?: number; result?: unknown; error?: { message?: string } }): void {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "MCP error"));
    else pending.resolve(message.result);
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
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
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
    return toToolResult(result);
  }


  async listResources(): Promise<McpResource[]> {
    const result = (await this.request("resources/list", {})) as { resources?: McpResource[] };
    return Array.isArray(result?.resources) ? result.resources : [];
  }

  async readResource(uri: string): Promise<string> {
    const result = (await this.request("resources/read", { uri }, 60_000)) as {
      contents?: { text?: string; uri?: string }[];
    };
    return (result?.contents ?? [])
      .map((entry) => entry.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = (await this.request("prompts/list", {})) as { prompts?: McpPrompt[] };
    return Array.isArray(result?.prompts) ? result.prompts : [];
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

/** Streamable HTTP transport: POST each message, read JSON or SSE back. */
export class HttpMcpClient implements McpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private nextId = 1;
  private sessionId = "";

  constructor(config: McpServerConfig) {
    if (!config.url) throw new Error("MCP HTTP server has no url");
    this.url = config.url;
    this.headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...config.headers };
  }

  private requestHeaders(): Record<string, string> {
    return this.sessionId ? { ...this.headers, "Mcp-Session-Id": this.sessionId } : { ...this.headers };
  }

  private async post(payload: unknown, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.requestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const session = res.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    } catch (err) {
      throw new Error(`MCP HTTP request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return this.readSse(res, id);
    }
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "MCP error");
    return body.result;
  }

  /** Read an SSE stream until the response with our id arrives. */
  private async readSse(res: Response, id: number): Promise<unknown> {
    if (!res.body) throw new Error("MCP SSE response has no body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          let message: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          if (message.id !== id) continue;
          if (message.error) throw new Error(message.error.message ?? "MCP error");
          return message.result;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    throw new Error("MCP SSE stream ended without a response");
  }

  notify(method: string, params: unknown): void {
    // Notifications are fire-and-forget; failures are not actionable here.
    void this.post({ jsonrpc: "2.0", method, params }, 10_000).catch(() => {});
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
    return toToolResult(result);
  }


  async listResources(): Promise<McpResource[]> {
    const result = (await this.request("resources/list", {})) as { resources?: McpResource[] };
    return Array.isArray(result?.resources) ? result.resources : [];
  }

  async readResource(uri: string): Promise<string> {
    const result = (await this.request("resources/read", { uri }, 60_000)) as {
      contents?: { text?: string; uri?: string }[];
    };
    return (result?.contents ?? [])
      .map((entry) => entry.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = (await this.request("prompts/list", {})) as { prompts?: McpPrompt[] };
    return Array.isArray(result?.prompts) ? result.prompts : [];
  }
  dispose(): void {
    /* nothing to close; the server owns the session */
  }
}

function toToolResult(result: { content?: { type?: string; text?: string }[]; isError?: boolean }): ToolResult {
  const text = (result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return { content: text || "(no output)", isError: Boolean(result?.isError) };
}

/** User scope first, then project scope (project overrides by name). */
export function readMcpConfig(cwd: string): Record<string, McpServerConfig & { scope: McpScope }> {
  const merged: Record<string, McpServerConfig & { scope: McpScope }> = {};
  const scopes: [McpScope, string][] = [
    ["user", join(CONFIG_HOME, "mcp.json")],
    ["project", join(cwd, ".prometheus", "mcp.json")],
  ];
  for (const [scope, file] of scopes) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as McpConfigFile;
      for (const [name, server] of Object.entries(parsed.servers ?? {})) {
        if (!server) continue;
        if (typeof server.command !== "string" && typeof server.url !== "string") continue;
        merged[name] = { ...server, scope };
      }
    } catch {
      /* an unreadable config file should not stop the session */
    }
  }
  return merged;
}

export function createClient(name: string, config: McpServerConfig): McpClient {
  return transportOf(config) === "http" ? new HttpMcpClient(config) : new StdioMcpClient(name, config);
}

export interface LoadedMcp {
  clients: McpClient[];
  tools: Tool[];
  errors: string[];
  /** Prompts advertised by servers, exposed as slash commands by the host. */
  prompts: { server: string; prompt: McpPrompt }[];
  /** Resources advertised by servers, readable through mcp_read_resource. */
  resources: { server: string; resource: McpResource }[];
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
  const prompts: { server: string; prompt: McpPrompt }[] = [];
  const resources: { server: string; resource: McpResource }[] = [];

  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      if (config.disabled) return;
      let client: McpClient;
      try {
        client = createClient(name, config);
      } catch (err) {
        errors.push((err as Error).message);
        return;
      }
      try {
        await withTimeout(client.initialize(), timeoutMs, `MCP server "${name}" did not initialize`);
        const listed = await withTimeout(client.listTools(), timeoutMs, `MCP server "${name}" did not list tools`);
        clients.push(client);
        // Resources and prompts are optional; a server that does not implement
        // them answers with an error, which must not fail the whole server.
        if (client.listResources) {
          try {
            for (const resource of await client.listResources()) {
              if (resource?.uri) resources.push({ server: name, resource });
            }
          } catch {
            /* server has no resources */
          }
        }
        if (client.listPrompts) {
          try {
            for (const prompt of await client.listPrompts()) {
              if (prompt?.name) prompts.push({ server: name, prompt });
            }
          } catch {
            /* server has no prompts */
          }
        }
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

  if (resources.length > 0) tools.push(resourceTool(clients, resources));
  return { clients, tools, errors, prompts, resources };
}

/**
 * One read-only tool for every advertised resource. Listing them as a single
 * tool keeps the tool schema small while still letting the model open a
 * document the server offered.
 */
function resourceTool(
  clients: McpClient[],
  resources: { server: string; resource: McpResource }[],
): Tool {
  const catalogue = resources
    .slice(0, 60)
    .map((entry) => `${entry.resource.uri} — ${entry.resource.name ?? entry.resource.description ?? entry.server}`)
    .join("\n");
  return {
    name: "mcp_read_resource",
    description: `Read a resource exposed by an MCP server. Available resources:\n${catalogue}`,
    readonly: true,
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string", description: "The resource URI, exactly as listed" },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    summarize: (input) => String(input.uri ?? "").slice(0, 120),
    async execute(input) {
      const uri = String(input.uri ?? "");
      const entry = resources.find((candidate) => candidate.resource.uri === uri);
      if (!entry) return { isError: true, content: `no MCP resource with uri ${uri}` };
      const index = resources.indexOf(entry);
      const client = clients[index];
      if (!client?.readResource) return { isError: true, content: `${entry.server} cannot read resources` };
      try {
        const text = await client.readResource(uri);
        return { content: text || "(empty resource)" };
      } catch (err) {
        return { isError: true, content: `could not read ${uri}: ${(err as Error).message}` };
      }
    },
  };
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
