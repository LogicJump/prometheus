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
 * A project server with the same name overrides the user server. A remote
 * server that answers 401 is authorized through OAuth (`src/oauth.ts`): the
 * browser flow runs once and the token is kept in `~/.prometheus/mcp-tokens.json`.
 * A server whose credentials are supplied as headers or environment variables
 * never reaches that path.
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";
import {
  discoverMetadata,
  isExpired,
  loadTokens,
  parseChallenge,
  refreshToken,
  saveToken,
  type AuthorizationServerMetadata,
  type AuthChallenge,
  type InteractiveResult,
} from "./oauth.ts";
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

/**
 * One part of a `tools/call` result.
 *
 * MCP allows text, images, audio, embedded resources and a typed
 * `structuredContent`. The old code kept only `type: "text"`, so a screenshot
 * tool returned "(no output)".
 */
export interface McpContentPart {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
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
  /** Ask for update notifications about one resource. */
  subscribeResource?(uri: string): Promise<void>;
  readResource?(uri: string): Promise<string>;
  listPrompts?(): Promise<McpPrompt[]>;
  /** Fetch one prompt with its messages. Servers that list prompts usually have it. */
  getPrompt?(name: string, args: Record<string, string>): Promise<{ description?: string; messages: unknown[] }>;
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  /**
   * Called for every server-initiated notification. List-change notifications
   * are the reason this exists: the tool list was loaded once at startup and
   * never refreshed, so a server that added a tool kept advertising the stale
   * set until the app restarted.
   */
  onNotification?(handler: (method: string, params: unknown) => void): void;
  /**
   * Answer an `elicitation/create` request. Returning a value here sends it
   * back to the server; returning null declines. When no handler is installed
   * the client answers "declined", which is the protocol's way of saying the
   * user was not asked.
   */
  onElicitation?(handler: (request: ElicitationRequest) => Promise<ElicitationResult | null>): void;
  dispose(): void;
}

/** A server asking the user for input. */
export interface ElicitationRequest {
  message: string;
  /** A JSON Schema for the form; the client renders what it understands. */
  requestedSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; title?: string; description?: string; enum?: string[]; default?: unknown }>;
    required?: string[];
  };
}

export interface ElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** What the host needs to run the browser flow for one server. */
export interface AuthorizeOptions {
  server: string;
  resourceUrl: string;
  metadata: AuthorizationServerMetadata;
  scope?: string;
}

/**
 * Turn a server's schema into a flat list of questions the UI can ask.
 *
 * Only scalar fields are asked. A nested object or an array is left at its
 * default and reported, because inventing a way to render arbitrary JSON in a
 * terminal prompt would produce a form the user cannot check.
 */
export function elicitationQuestions(request: ElicitationRequest): { name: string; label: string; options?: string[]; default?: unknown }[] {
  const properties = request.requestedSchema?.properties ?? {};
  const required = new Set(request.requestedSchema?.required ?? []);
  const out: { name: string; label: string; options?: string[]; default?: unknown }[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    if (!schema) continue;
    const scalar = schema.type === "string" || schema.type === "number" || schema.type === "integer" || schema.type === "boolean";
    if (!scalar && !schema.enum) continue;
    out.push({
      name,
      label: schema.title ?? schema.description ?? name,
      ...(schema.enum ? { options: schema.enum } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
    });
    void required;
  }
  return out;
}

/** Notifications a client should route to its handler. */
const INTERESTING_NOTIFICATIONS = new Set([
  "notifications/tools/list_changed",
  "notifications/resources/list_changed",
  "notifications/prompts/list_changed",
  "notifications/resources/updated",
  "notifications/message",
]);

/** Map a JSON-RPC error object to an Error that keeps the code and data. */
function rpcError(error: { code?: number; message?: string; data?: unknown }): Error {
  const err = new Error(error.message ?? "MCP error") as Error & { code?: number; data?: unknown };
  err.code = error.code;
  err.data = error.data;
  return err;
}

/**
 * Follow `nextCursor` until the server stops returning one.
 *
 * The old code sent one request and ignored the cursor, so a server with more
 * tools than fit in one page silently lost the rest. The cap guards against a
 * server that echoes the same cursor forever.
 */
async function paginate<T>(
  request: (method: string, params: unknown) => Promise<unknown>,
  method: string,
  key: string,
  limit = 50,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < limit; page++) {
    const result = (await request(method, cursor ? { cursor } : {})) as Record<string, unknown>;
    const items = result?.[key];
    if (Array.isArray(items)) out.push(...(items as T[]));
    const next = result?.nextCursor;
    if (typeof next !== "string" || !next) break;
    cursor = next;
  }
  return out;
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

  private settle(message: { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown }; method?: string; params?: unknown }): void {
    // A notification has no id. The old code returned here, which discarded
    // every `list_changed` the servers sent.
    if (message.method && message.id === undefined) {
      if (INTERESTING_NOTIFICATIONS.has(message.method)) this.notificationHandler?.(message.method, message.params);
      return;
    }
    // A server-initiated request carries an id we never issued. Ignoring it
    // would leave the server waiting forever, so answer it: elicitation is
    // routed to the user when a handler exists, and every other method gets an
    // explicit "not implemented" rather than silence.
    if (typeof message.id === "number" && !this.pending.has(message.id) && message.method) {
      const id = message.id;
      if (message.method === "elicitation/create") {
        void this.answerElicitation(id, message.params as ElicitationRequest);
        return;
      }
      this.child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `prometheus does not implement ${message.method}` },
        })}\n`,
      );
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(rpcError(message.error));
    else pending.resolve(message.result);
  }

  private notificationHandler: ((method: string, params: unknown) => void) | null = null;

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  private elicitationHandler: ((request: ElicitationRequest) => Promise<ElicitationResult | null>) | null = null;

  onElicitation(handler: (request: ElicitationRequest) => Promise<ElicitationResult | null>): void {
    this.elicitationHandler = handler;
  }

  /** Ask the user (when there is one) and answer the server either way. */
  private async answerElicitation(id: number, request: ElicitationRequest): Promise<void> {
    let result: ElicitationResult | null = null;
    try {
      result = this.elicitationHandler ? await this.elicitationHandler(request ?? { message: "" }) : null;
    } catch {
      result = null;
    }
    // A client with no user must not accept on its own: declining is the
    // protocol's signal that the request was seen and refused.
    const payload = result ?? { action: "decline" as const };
    try {
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: payload })}\n`);
    } catch {
      /* the server went away while the user was thinking */
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
      // Declaring elicitation is what makes a server ask at all. Listing the
      // capability without a handler would turn every prompt into a timeout.
      capabilities: this.elicitationHandler ? { elicitation: {} } : {},
      clientInfo: { name: "prometheus", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
    return paginate((method, params) => this.request(method, params), "tools/list", "tools");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, 120_000)) as {
      content?: McpContentPart[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    return toToolResult(result);
  }


  async listResources(): Promise<McpResource[]> {
    return paginate((method, params) => this.request(method, params), "resources/list", "resources");
  }

  /**
   * Ask the server to push `notifications/resources/updated`.
   *
   * The notification was already routed to the handler; without the
   * subscription the server has no reason to send one, so the channel existed
   * and was never opened.
   */
  async subscribeResource(uri: string): Promise<void> {
    await this.request("resources/subscribe", { uri });
  }

  async readResource(uri: string): Promise<string> {
    const result = (await this.request("resources/read", { uri }, 60_000)) as {
      contents?: { text?: string; uri?: string; blob?: string; mimeType?: string }[];
    };
    return (result?.contents ?? [])
      .map((entry) => {
        if (typeof entry.text === "string") return entry.text;
        // A binary resource has a `blob` (base64) and no text. Reporting it is
        // better than an empty string that reads as "the document is blank".
        if (entry.blob) return `[binary resource ${entry.uri ?? uri}${entry.mimeType ? ` (${entry.mimeType})` : ""}, ${Math.ceil((entry.blob.length * 3) / 4 / 1024)} KiB]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return paginate((method, params) => this.request(method, params), "prompts/list", "prompts");
  }

  /**
   * Fetch one prompt's messages. The host used to render a prompt as a string
   * template of its name and arguments; the server's own text was never
   * requested, so a prompt with a body (a code review checklist, a commit
   * format) arrived empty.
   */
  async getPrompt(name: string, args: Record<string, string>): Promise<{ description?: string; messages: unknown[] }> {
    const result = (await this.request("prompts/get", { name, arguments: args })) as {
      description?: string;
      messages?: unknown[];
    };
    return { description: result?.description, messages: Array.isArray(result?.messages) ? result.messages : [] };
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
  private elicitationHandler: ((request: ElicitationRequest) => Promise<ElicitationResult | null>) | null = null;
  /** Server name from mcp.json, used as the token-store key. */
  private readonly serverName: string;
  private bearer = "";
  private clientId = "";
  private authorize: ((options: AuthorizeOptions) => Promise<InteractiveResult | null>) | null = null;

  constructor(config: McpServerConfig, serverName = config.url ?? "mcp") {
    if (!config.url) throw new Error("MCP HTTP server has no url");
    this.url = config.url;
    this.serverName = serverName;
    this.headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...config.headers };
    const stored = loadTokens()[serverName];
    if (stored && !isExpired(stored)) this.bearer = stored.access_token;
  }

  /** Install the browser-flow runner; without one a 401 is just an error. */
  onAuthorize(handler: (options: AuthorizeOptions) => Promise<InteractiveResult | null>): void {
    this.authorize = handler;
  }

  onElicitation(handler: (request: ElicitationRequest) => Promise<ElicitationResult | null>): void {
    this.elicitationHandler = handler;
  }

  /** Ask the user, then POST the answer back as a JSON-RPC response. */
  private async answerElicitation(id: number, request: ElicitationRequest): Promise<void> {
    let result: ElicitationResult | null = null;
    try {
      result = this.elicitationHandler ? await this.elicitationHandler(request ?? { message: "" }) : null;
    } catch {
      result = null;
    }
    const payload = result ?? { action: "decline" as const };
    // A response is a bare JSON-RPC message with no method; the server
    // correlates it by id.
    await this.post({ jsonrpc: "2.0", id, result: payload }, 10_000).catch(() => {});
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers, "MCP-Protocol-Version": "2025-06-18" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    return headers;
  }

  private notificationHandler: ((method: string, params: unknown) => void) | null = null;

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
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

  /**
   * Renew the bearer token after a 401.
   *
   * A stored refresh token is used first; when there is none, the caller's
   * authorization handler runs the browser flow. Both paths end with a token
   * in memory and on disk, so the next process start does not repeat the
   * browser step.
   */
  private async renewToken(challenge: AuthChallenge | null): Promise<boolean> {
    const metadata = await discoverMetadata(this.url, challenge?.resourceMetadata);
    const stored = loadTokens()[this.serverName];
    if (stored?.refresh_token) {
      const refreshed = await refreshToken(metadata, stored, { clientId: this.clientId, resource: this.url });
      saveToken(this.serverName, refreshed);
      this.bearer = refreshed.access_token;
      return true;
    }
    if (!this.authorize) return false;
    const result = await this.authorize({
      server: this.serverName,
      resourceUrl: this.url,
      metadata,
      scope: challenge?.scope,
    });
    if (!result) return false;
    this.clientId = result.clientId;
    this.bearer = result.token.access_token;
    return true;
  }

  async request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    let res: Response;
    try {
      res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    } catch (err) {
      throw new Error(`MCP HTTP request failed: ${(err as Error).message}`);
    }
    // A remote server that answers 401 is asking for OAuth, not reporting a
    // bug. Renew once and replay the same request; a second 401 is a real
    // failure and falls through to the error below.
    if (res.status === 401) {
      const challenge = parseChallenge(res.headers.get("www-authenticate"));
      let renewed = false;
      try {
        renewed = await this.renewToken(challenge);
      } catch (err) {
        throw new Error(`MCP: ${this.serverName} needs authorization, and the flow failed: ${(err as Error).message}`);
      }
      if (renewed) {
        try {
          res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
        } catch (err) {
          throw new Error(`MCP HTTP request failed: ${(err as Error).message}`);
        }
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 ? " (this server requires authorization; see docs/reference.md#mcp-servers)" : "";
      throw new Error(`MCP HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
    }
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return this.readSse(res, id);
    }
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    if (body.error) throw rpcError(body.error);
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
          let message: {
            id?: number;
            result?: unknown;
            error?: { code?: number; message?: string; data?: unknown };
            method?: string;
            params?: unknown;
          };
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          // Notifications and server-initiated requests share this stream. The
          // old code dropped both because it only matched its own id.
          if (message.method && message.id === undefined) {
            if (INTERESTING_NOTIFICATIONS.has(message.method)) this.notificationHandler?.(message.method, message.params);
            continue;
          }
          if (message.method && typeof message.id === "number" && message.id !== id) {
            if (message.method === "elicitation/create") {
              void this.answerElicitation(message.id, message.params as ElicitationRequest);
            } else {
              void this.post(
                { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `prometheus does not implement ${message.method}` } },
                10_000,
              ).catch(() => {});
            }
            continue;
          }
          if (message.id !== id) continue;
          if (message.error) throw rpcError(message.error);
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
      // Declaring elicitation is what makes a server ask at all. Listing the
      // capability without a handler would turn every prompt into a timeout.
      capabilities: this.elicitationHandler ? { elicitation: {} } : {},
      clientInfo: { name: "prometheus", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: Record<string, unknown> }[]> {
    return paginate((method, params) => this.request(method, params), "tools/list", "tools");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await this.request("tools/call", { name, arguments: args }, 120_000)) as {
      content?: McpContentPart[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    return toToolResult(result);
  }


  async listResources(): Promise<McpResource[]> {
    return paginate((method, params) => this.request(method, params), "resources/list", "resources");
  }

  /**
   * Ask the server to push `notifications/resources/updated`.
   *
   * The notification was already routed to the handler; without the
   * subscription the server has no reason to send one, so the channel existed
   * and was never opened.
   */
  async subscribeResource(uri: string): Promise<void> {
    await this.request("resources/subscribe", { uri });
  }

  async readResource(uri: string): Promise<string> {
    const result = (await this.request("resources/read", { uri }, 60_000)) as {
      contents?: { text?: string; uri?: string; blob?: string; mimeType?: string }[];
    };
    return (result?.contents ?? [])
      .map((entry) => {
        if (typeof entry.text === "string") return entry.text;
        // A binary resource has a `blob` (base64) and no text. Reporting it is
        // better than an empty string that reads as "the document is blank".
        if (entry.blob) return `[binary resource ${entry.uri ?? uri}${entry.mimeType ? ` (${entry.mimeType})` : ""}, ${Math.ceil((entry.blob.length * 3) / 4 / 1024)} KiB]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return paginate((method, params) => this.request(method, params), "prompts/list", "prompts");
  }

  /**
   * Fetch one prompt's messages. The host used to render a prompt as a string
   * template of its name and arguments; the server's own text was never
   * requested, so a prompt with a body (a code review checklist, a commit
   * format) arrived empty.
   */
  async getPrompt(name: string, args: Record<string, string>): Promise<{ description?: string; messages: unknown[] }> {
    const result = (await this.request("prompts/get", { name, arguments: args })) as {
      description?: string;
      messages?: unknown[];
    };
    return { description: result?.description, messages: Array.isArray(result?.messages) ? result.messages : [] };
  }
  dispose(): void {
    /* nothing to close; the server owns the session */
  }
}

function toToolResult(result: {
  content?: McpContentPart[];
  isError?: boolean;
  structuredContent?: unknown;
}): ToolResult {
  const parts: string[] = [];
  for (const part of result?.content ?? []) {
    if (!part) continue;
    switch (part.type) {
      case "text":
        if (typeof part.text === "string") parts.push(part.text);
        break;
      case "image":
      case "audio": {
        // The bytes stay out of the transcript, but the model has to know the
        // tool produced one; silently returning "(no output)" for a screenshot
        // is worse than a line saying what was there.
        const kind = part.type === "image" ? "image" : "audio";
        const size = typeof part.data === "string" ? `, ${Math.ceil((part.data.length * 3) / 4 / 1024)} KiB` : "";
        parts.push(`[${kind} ${part.mimeType ?? "unknown type"}${size}]`);
        break;
      }
      case "resource": {
        const resource = part.resource;
        if (resource?.text) parts.push(resource.text);
        else if (resource?.uri) parts.push(`[resource ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`);
        break;
      }
      default:
        // A part type this client does not know about is reported, not dropped.
        if (typeof part.text === "string") parts.push(part.text);
        break;
    }
  }
  if (result?.structuredContent !== undefined && parts.length === 0) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return { content: parts.filter(Boolean).join("\n") || "(no output)", isError: Boolean(result?.isError) };
}

/** User scope first, then project scope (project overrides by name). */
export function readMcpConfig(cwd: string): Record<string, McpServerConfig & { scope: McpScope; pending?: boolean }> {
  const merged: Record<string, McpServerConfig & { scope: McpScope; pending?: boolean }> = {};
  // `.mcp.json` is the format Claude Code and other clients write, so a
  // repository that already declares servers should not need a second copy.
  // It is read from the project scope only, and its servers start disabled:
  // opening a cloned repository must not execute a command it names.
  const scopes: [McpScope, string, boolean][] = [
    ["user", join(CONFIG_HOME, "mcp.json"), false],
    ["project", join(cwd, ".prometheus", "mcp.json"), false],
    ["project", join(cwd, ".mcp.json"), true],
  ];
  const approved = readApprovedProjectServers(cwd);
  for (const [scope, file, needsApproval] of scopes) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as McpConfigFile;
      for (const [name, server] of Object.entries(parsed.servers ?? {})) {
        if (!server) continue;
        if (typeof server.command !== "string" && typeof server.url !== "string") continue;
        const pending = needsApproval && !approved.has(name);
        merged[name] = { ...server, scope, ...(pending ? { pending: true } : {}) };
      }
    } catch {
      /* an unreadable config file should not stop the session */
    }
  }
  return merged;
}

/** The `.mcp.json` servers the user has enabled for this folder. */
function approvedFile(cwd: string): string {
  return join(cwd, ".prometheus", "mcp-approved.json");
}

export function readApprovedProjectServers(cwd: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(approvedFile(cwd), "utf8")) as { servers?: unknown };
    return new Set(Array.isArray(parsed.servers) ? parsed.servers.filter((name) => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

/** Enable or disable one of the repository's `.mcp.json` servers. */
export function setProjectServerApproved(cwd: string, name: string, approved: boolean): void {
  const current = readApprovedProjectServers(cwd);
  if (approved) current.add(name);
  else current.delete(name);
  mkdirSync(join(cwd, ".prometheus"), { recursive: true });
  writeFileSync(approvedFile(cwd), JSON.stringify({ servers: [...current].sort() }, null, 2), "utf8");
}

export function createClient(name: string, config: McpServerConfig): McpClient {
  return transportOf(config) === "http" ? new HttpMcpClient(config, name) : new StdioMcpClient(name, config);
}

export interface LoadedMcp {
  clients: McpClient[];
  tools: Tool[];
  errors: string[];
  /** Prompts advertised by servers, exposed as slash commands by the host. */
  prompts: { server: string; prompt: McpPrompt }[];
  /** Resources advertised by servers, readable through mcp_read_resource. */
  resources: { server: string; resource: McpResource }[];
  /** The client for each server name, so a resource is read from its owner. */
  byServer: Map<string, McpClient>;
  /**
   * Called when any server announces that its tool, resource or prompt list
   * changed. The host re-lists and replaces the tools it had added; without
   * this a server that gained a tool kept advertising the old set until the app
   * restarted.
   */
  onRefresh?: (server: string, kind: "tools" | "resources" | "prompts") => void;
  /** A subscribed resource changed. */
  onResourceUpdated?: (server: string) => void;
  /** True when the tool set was large enough to defer; `tool_search` unlocks them. */
  deferred?: boolean;
}

/** Wrap one server's advertised tools as local tools. */
function wrapServerTools(
  server: string,
  client: McpClient,
  listed: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[],
  deferred = false,
): Tool[] {
  const tools: Tool[] = [];
  for (const entry of listed) {
    if (!entry?.name) continue;
    const toolName = `mcp__${server}__${entry.name}`;
    tools.push({
      name: toolName,
      description: entry.description ?? `MCP tool ${entry.name} from ${server}`,
      // MCP tools can have side effects the schema does not describe, so they
      // prompt in ask mode and are unavailable in plan mode.
      readonly: false,
      parameters: entry.inputSchema ?? { type: "object", properties: {} },
      ...(deferred ? { deferred: true } : {}),
      summarize: (input) => {
        const first = Object.values(input).find((value) => typeof value === "string");
        return String(first ?? entry.name).slice(0, 120);
      },
      execute: (input) => client.callTool(entry.name as string, input),
    });
  }
  return tools;
}

/**
 * Tools to keep in the request no matter how many servers are attached.
 *
 * A handful of MCP tools costs less than the round trip of a `tool_search`, so
 * deferral only kicks in once the set is big enough to matter. The threshold is
 * on the whole MCP set, not per server, because the cost is the sum.
 */
const DEFER_ABOVE = 10;

/** Re-list one server's tools after it announced a change. */
export async function refreshServerTools(
  server: string,
  client: McpClient,
  timeoutMs = 15_000,
  deferred = false,
): Promise<Tool[]> {
  const listed = await withTimeout(client.listTools(), timeoutMs, `MCP server "${server}" did not list tools`);
  return wrapServerTools(server, client, listed, deferred);
}

/**
 * Start every configured server, initialize it, and wrap its tools as local
 * tools. A server that fails is reported and skipped; the others still load.
 *
 * `elicitation` is answered through this callback, which the host supplies.
 * Without one every request is declined, which is the honest answer for a
 * runtime with no user behind it.
 */
export async function loadMcpTools(
  cwd: string,
  timeoutMs = 15_000,
  elicitation?: (server: string, request: ElicitationRequest) => Promise<ElicitationResult | null>,
  authorize?: (options: AuthorizeOptions) => Promise<InteractiveResult | null>,
): Promise<LoadedMcp> {
  const configs = readMcpConfig(cwd);
  const clients: McpClient[] = [];
  const byServer = new Map<string, McpClient>();
  const tools: Tool[] = [];
  const errors: string[] = [];
  const prompts: { server: string; prompt: McpPrompt }[] = [];
  const resources: { server: string; resource: McpResource }[] = [];
  const pendingWrapping: { name: string; client: McpClient; listed: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[] }[] = [];

  const result: LoadedMcp = { clients, tools, errors, prompts, resources, byServer };

  await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      if (config.disabled) return;
      // A server declared by the repository itself starts only after the user
      // enables it: opening a cloned folder must not run a command it names.
      if ((config as { pending?: boolean }).pending) {
        errors.push(`${name}: declared in .mcp.json; enable it in Settings to start it`);
        return;
      }
      let client: McpClient;
      try {
        client = createClient(name, config);
      } catch (err) {
        errors.push((err as Error).message);
        return;
      }
      try {
        // Both handlers are installed before `initialize`: the capability
        // declaration depends on the elicitation one, and a list_changed sent
        // during the handshake must not be dropped.
        client.onNotification?.((method) => {
          const kind =
            method === "notifications/tools/list_changed" ? "tools"
            : method === "notifications/resources/list_changed" ? "resources"
            : method === "notifications/prompts/list_changed" ? "prompts"
            : null;
          if (kind) result.onRefresh?.(name, kind);
          if (method === "notifications/resources/updated") result.onResourceUpdated?.(name);
        });
        if (elicitation) client.onElicitation?.((request) => elicitation(name, request));
        // OAuth is installed before initialize for the same reason: the first
        // request may be the one the server protects.
        if (authorize && "onAuthorize" in client) {
          (client as HttpMcpClient).onAuthorize(authorize);
        }
        await withTimeout(client.initialize(), timeoutMs, `MCP server "${name}" did not initialize`);
        const listed = await withTimeout(client.listTools(), timeoutMs, `MCP server "${name}" did not list tools`);
        clients.push(client);
        byServer.set(name, client);
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
        pendingWrapping.push({ name, client, listed });
      } catch (err) {
        client.dispose();
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }),
  );

  // Deferral is decided on the total, not per server: what costs tokens is the
  // sum of every schema in the request, and a single server can carry forty.
  const totalListed = pendingWrapping.reduce((count, entry) => count + entry.listed.length, 0);
  const deferred = totalListed > DEFER_ABOVE;
  for (const entry of pendingWrapping) {
    tools.push(...wrapServerTools(entry.name, entry.client, entry.listed, deferred));
  }
  result.deferred = deferred;

  // Subscribing is best effort: a server that does not implement
  // `resources/subscribe` answers with an error, and the read tool still works.
  for (const entry of resources) {
    const client = byServer.get(entry.server);
    void client?.subscribeResource?.(entry.resource.uri).catch(() => {});
  }
  if (resources.length > 0) {
    tools.push(resourceTool(byServer, resources));
    // More than one page means the description cannot hold the catalogue, so
    // the paging tool is the only way to reach the rest.
    if (resources.length > 20) tools.push(resourceListTool(resources));
  }
  return result;
}

/**
 * One read-only tool for every advertised resource. Listing them as a single
 * tool keeps the tool schema small while still letting the model open a
 * document the server offered.
 *
 * The resource names its server, and that name — not a list position — picks
 * the client. The old code used the resource's index into a `clients` array
 * that only held servers which had finished loading, in completion order:
 * with two servers the read could go to the wrong one, which is a privacy bug
 * (a document from server A requested from server B) and not merely a miss.
 */
function resourceTool(
  byServer: Map<string, McpClient>,
  resources: { server: string; resource: McpResource }[],
): Tool {
  // The catalogue used to be the first sixty entries glued into the tool
  // description: past that the rest were invisible, and every request paid for
  // the text whether or not it read a resource. The description now names the
  // count and a page of the list; `mcp_list_resources` pages through all of it.
  const page = resources
    .slice(0, 20)
    .map((entry) => `${entry.resource.uri} — ${entry.resource.name ?? entry.resource.description ?? entry.server}`)
    .join("\n");
  const more =
    resources.length > 20 ? `\n... and ${resources.length - 20} more; use mcp_list_resources with offset.` : "";
  return {
    name: "mcp_read_resource",
    description: `Read a resource exposed by an MCP server (${resources.length} available). First page:\n${page}${more}`,
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
      const client = byServer.get(entry.server);
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

/**
 * Page through the resource catalogue.
 *
 * The read tool carries a first page so the model can act without a second
 * call; this tool exists for the case where what it wants is past that page.
 */
function resourceListTool(resources: { server: string; resource: McpResource }[]): Tool {
  return {
    name: "mcp_list_resources",
    description: `List MCP resources (${resources.length} total), paged. Each entry is "<uri> — <name> (<server>)".`,
    readonly: true,
    parameters: {
      type: "object",
      properties: {
        offset: { type: "integer", description: "0-based index to start from", minimum: 0 },
        limit: { type: "integer", description: "How many to return (default 50, max 100)", minimum: 1, maximum: 100 },
        server: { type: "string", description: "Only resources from this server" },
      },
      additionalProperties: false,
    },
    summarize: (input) => `resources from ${String(input.offset ?? 0)}`,
    async execute(input) {
      const filtered = input.server
        ? resources.filter((entry) => entry.server === String(input.server))
        : resources;
      const offset = Math.max(0, Number(input.offset ?? 0));
      const limit = Math.min(100, Math.max(1, Number(input.limit ?? 50)));
      const slice = filtered.slice(offset, offset + limit);
      if (slice.length === 0) {
        return { content: `No resources at offset ${offset} (${filtered.length} total).`, display: "0" };
      }
      const lines = slice.map(
        (entry) => `${entry.resource.uri} — ${entry.resource.name ?? entry.resource.description ?? ""} (${entry.server})`,
      );
      const next = offset + slice.length;
      return {
        content:
          lines.join("\n") +
          (next < filtered.length ? `\n\n[next offset ${next} of ${filtered.length}]` : `\n\n[end of ${filtered.length}]`),
        display: `${slice.length}/${filtered.length}`,
      };
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
