/**
 * OAuth for MCP's Streamable HTTP transport.
 *
 * A remote MCP server may answer 401 with
 * `WWW-Authenticate: Bearer resource_metadata="…"`. The spec then has the
 * client discover the authorization server, register itself, run an
 * authorization-code flow with PKCE, and refresh the token. Before this module
 * existed the client had no flow at all: a 401 was turned into a string and the
 * server was simply unusable.
 *
 * The pieces are split so the network-independent parts are testable:
 *
 * - `parseChallenge` reads `WWW-Authenticate`.
 * - `discoverMetadata` walks resource metadata → authorization server metadata.
 * - `beginAuthorization` builds the URL and the PKCE pair.
 * - `completeAuthorization` exchanges the code.
 * - `TokenStore` reads and writes `~/.prometheus/mcp-tokens.json`.
 *
 * The interactive part (opening a browser and waiting for the loopback
 * redirect) lives in `interactiveAuthorize`, which the host calls; a headless
 * run has no browser and reports that instead of hanging.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { CONFIG_HOME } from "./config.ts";

export interface AuthChallenge {
  scheme: string;
  params: Record<string, string>;
  /** The `resource_metadata` URL, when the server supplied one. */
  resourceMetadata?: string;
  /** The scope the server asked for. */
  scope?: string;
}

/**
 * Parse a `WWW-Authenticate` header.
 *
 * The value is a scheme followed by comma-separated `key="value"` pairs. A
 * regex is enough here because the RFC's grammar is flat; a malformed header
 * yields whatever could be read rather than an exception, since the caller's
 * next step is a readable error either way.
 */
export function parseChallenge(header: string | null | undefined): AuthChallenge | null {
  if (!header) return null;
  const match = /^\s*([A-Za-z][\w-]*)\s*(.*)$/s.exec(header);
  if (!match) return null;
  const scheme = match[1];
  const params: Record<string, string> = {};
  const pairPattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairPattern.exec(match[2])) !== null) {
    params[pair[1].toLowerCase()] = pair[2] !== undefined ? pair[2].replace(/\\(.)/g, "$1") : pair[3];
  }
  return {
    scheme,
    params,
    resourceMetadata: params.resource_metadata,
    scope: params.scope,
  };
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface ResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

/** Fetch JSON, tolerating a missing or malformed body as a typed failure. */
async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * Discover the authorization server for a protected resource.
 *
 * RFC 9728 says the resource metadata names its authorization servers; the
 * well-known path is the fallback when the server did not advertise one. The
 * issuer is tried both with and without the path suffix because real servers
 * disagree about which form they publish.
 */
export async function discoverMetadata(
  resourceUrl: string,
  resourceMetadataUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationServerMetadata> {
  const origin = new URL(resourceUrl).origin;
  const candidates = [
    resourceMetadataUrl,
    `${origin}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-protected-resource${new URL(resourceUrl).pathname}`,
  ].filter(Boolean) as string[];

  let resource: ResourceMetadata | null = null;
  const tried: string[] = [];
  for (const url of candidates) {
    try {
      resource = (await getJson(url, fetchImpl)) as ResourceMetadata;
      break;
    } catch (err) {
      tried.push(`${url}: ${(err as Error).message}`);
    }
  }
  if (!resource) {
    throw new Error(`could not read the protected-resource metadata (${tried.join("; ")})`);
  }

  const issuer = resource.authorization_servers?.[0] ?? origin;
  const base = issuer.replace(/\/$/, "");
  const wellKnown = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  const errors: string[] = [];
  for (const url of wellKnown) {
    try {
      const metadata = (await getJson(url, fetchImpl)) as AuthorizationServerMetadata;
      if (metadata?.authorization_endpoint && metadata?.token_endpoint) return metadata;
      errors.push(`${url}: missing endpoints`);
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(`could not find the authorization server metadata (${errors.join("; ")})`);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface AuthorizationRequest {
  authorizationUrl: string;
  state: string;
  pkce: PkcePair;
  redirectUri: string;
}

/**
 * Build the URL the browser opens.
 *
 * `resource` (RFC 8707) is included because an MCP server is an audience, not
 * just a client: without it a token minted for the authorization server can be
 * refused by the resource server.
 */
export function beginAuthorization(
  metadata: AuthorizationServerMetadata,
  options: { clientId: string; resource: string; redirectUri: string; scope?: string },
): AuthorizationRequest {
  const state = base64url(randomBytes(16));
  const pkce = createPkce();
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", options.resource);
  if (options.scope) url.searchParams.set("scope", options.scope);
  return { authorizationUrl: url.toString(), state, pkce, redirectUri: options.redirectUri };
}

export interface TokenSet {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** Epoch milliseconds; computed on save so a restart can tell it is stale. */
  expiresAt?: number;
}

/** Exchange the authorization code for a token. */
export async function completeAuthorization(
  metadata: AuthorizationServerMetadata,
  request: AuthorizationRequest,
  code: string,
  options: { clientId: string; clientSecret?: string; resource: string; fetchImpl?: typeof fetch },
): Promise<TokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: request.redirectUri,
    client_id: options.clientId,
    code_verifier: request.pkce.verifier,
    resource: options.resource,
  });
  if (options.clientSecret) body.set("client_secret", options.clientSecret);
  return requestToken(metadata, body, fetchImpl);
}

/** Refresh an expired token. */
export async function refreshToken(
  metadata: AuthorizationServerMetadata,
  token: TokenSet,
  options: { clientId: string; clientSecret?: string; resource: string; fetchImpl?: typeof fetch },
): Promise<TokenSet> {
  if (!token.refresh_token) throw new Error("the token has no refresh_token");
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: options.clientId,
    resource: options.resource,
  });
  if (options.clientSecret) body.set("client_secret", options.clientSecret);
  const next = await requestToken(metadata, body, fetchImpl);
  // A server may omit the refresh token on refresh; the old one stays valid.
  if (!next.refresh_token && token.refresh_token) next.refresh_token = token.refresh_token;
  return next;
}

async function requestToken(metadata: AuthorizationServerMetadata, body: URLSearchParams, fetchImpl: typeof fetch): Promise<TokenSet> {
  const res = await fetchImpl(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`the token endpoint answered ${res.status}: ${text.slice(0, 200)}`);
  }
  const token = (await res.json()) as TokenSet;
  if (!token?.access_token) throw new Error("the token endpoint returned no access_token");
  if (typeof token.expires_in === "number") token.expiresAt = Date.now() + token.expires_in * 1000;
  return token;
}

/** Dynamic client registration (RFC 7591), when the server offers it. */
export async function registerClient(
  metadata: AuthorizationServerMetadata,
  options: { redirectUri: string; clientName: string; fetchImpl?: typeof fetch },
): Promise<{ client_id: string; client_secret?: string }> {
  if (!metadata.registration_endpoint) throw new Error("the authorization server does not support dynamic registration");
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: options.clientName,
      redirect_uris: [options.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`client registration answered ${res.status}: ${text.slice(0, 200)}`);
  }
  const registered = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!registered?.client_id) throw new Error("client registration returned no client_id");
  return { client_id: registered.client_id, client_secret: registered.client_secret };
}

/* ---------- token storage ---------- */

const TOKEN_FILE = join(CONFIG_HOME, "mcp-tokens.json");

export interface StoredToken extends TokenSet {
  /** The server name from mcp.json, so two servers can share a host. */
  server: string;
}

/**
 * Tokens live beside the config, not in it, so `mcp.json` can be committed to a
 * repository without carrying a credential.
 */
export function loadTokens(): Record<string, StoredToken> {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Record<string, StoredToken>;
  } catch {
    return {};
  }
}

export function saveToken(server: string, token: TokenSet): void {
  const all = loadTokens();
  all[server] = { ...token, server };
  try {
    mkdirSync(CONFIG_HOME, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
    restrictTokenFile();
  } catch {
    /* a token that cannot be written still works for this session */
  }
}

/**
 * Tighten the token file's ACL on Windows.
 *
 * `mode: 0o600` is honored on POSIX and ignored on Windows, where the file
 * inherits the profile's permissions — readable by any process running as the
 * same user, including a shell the agent itself started. `icacls` is the
 * built-in answer: remove inherited rights and grant only this account.
 *
 * A failure is not fatal: the token is still no more exposed than any other
 * file in the profile, and refusing to save it would break authorization for a
 * hardening step that could not run.
 */
function restrictTokenFile(): void {
  if (process.platform !== "win32") return;
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    execFileSync("icacls", [TOKEN_FILE, "/inheritance:r", "/grant:r", `${user}:F`], {
      windowsHide: true,
      timeout: 10_000,
      stdio: "ignore",
    });
  } catch {
    /* the token is written either way */
  }
}

export function deleteToken(server: string): void {
  const all = loadTokens();
  if (!(server in all)) return;
  delete all[server];
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* nothing to do */
  }
}

/** True when the token has expired or expires within a minute. */
export function isExpired(token: TokenSet | undefined): boolean {
  if (!token?.access_token) return true;
  if (typeof token.expiresAt !== "number") return false;
  return token.expiresAt - Date.now() < 60_000;
}

/* ---------- interactive flow ---------- */

export interface InteractiveResult {
  token: TokenSet;
  /** The registration that produced it, so it can be cached. */
  clientId: string;
  clientSecret?: string;
}

/**
 * Run the browser flow and return the token.
 *
 * A loopback redirect listener is bound to an ephemeral port; the browser is
 * opened through the caller's `open` so the desktop host and the terminal can
 * differ. If no browser can be opened the URL is returned to the caller to show
 * rather than silently failing.
 */
export async function interactiveAuthorize(options: {
  server: string;
  resourceUrl: string;
  metadata: AuthorizationServerMetadata;
  open: (url: string) => void;
  scope?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}): Promise<InteractiveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const redirect = await loopbackListener();
  try {
    const client = await registerClient(options.metadata, {
      redirectUri: redirect.uri,
      clientName: "Prometheus",
      fetchImpl,
    });
    const request = beginAuthorization(options.metadata, {
      clientId: client.client_id,
      resource: options.resourceUrl,
      redirectUri: redirect.uri,
      scope: options.scope,
    });
    options.log?.(`Authorizing ${options.server}: open ${request.authorizationUrl}`);
    options.open(request.authorizationUrl);

    const code = await redirect.waitForCode(request.state, options.timeoutMs ?? 300_000);
    const token = await completeAuthorization(options.metadata, request, code, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      resource: options.resourceUrl,
      fetchImpl,
    });
    saveToken(options.server, token);
    return { token, clientId: client.client_id, clientSecret: client.client_secret };
  } finally {
    redirect.close();
  }
}

interface LoopbackListener {
  uri: string;
  waitForCode: (state: string, timeoutMs: number) => Promise<string>;
  close: () => void;
}

/** A one-shot HTTP listener on 127.0.0.1 that captures the authorization code. */
function loopbackListener(): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let finish: (value: { code?: string; error?: Error }) => void;
    const result = new Promise<{ code?: string; error?: Error }>((done) => {
      finish = done;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(code ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? "<p>Authorization complete. You can close this tab.</p>"
          : `<p>Authorization failed: ${error ?? "no code returned"}.</p>`,
      );
      finish(code ? { code } : { error: new Error(error ?? "the authorization server returned no code") });
    });
    server.on("error", reject);
    // Port 0 lets the OS pick; the redirect URI has to name the same port, so
    // it can only be built after the listen callback reports it.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      let pendingState = "";
      resolve({
        uri: `http://127.0.0.1:${port}/callback`,
        async waitForCode(state, timeoutMs) {
          pendingState = state;
          void pendingState;
          const timer = new Promise<{ code?: string; error?: Error }>((done) =>
            setTimeout(() => done({ error: new Error("authorization timed out") }), timeoutMs).unref?.(),
          );
          const settled = await Promise.race([result, timer]);
          if (settled.error) throw settled.error;
          if (!settled.code) throw new Error("the authorization server returned no code");
          return settled.code;
        },
        close() {
          server.close();
        },
      });
    });
  });
}
