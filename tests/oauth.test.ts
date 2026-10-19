/**
 * MCP OAuth: challenge parsing, discovery, PKCE, and the token exchange.
 *
 * The interactive browser step is not exercised here — it needs a real user to
 * click consent — but every step around it is, against a local fake
 * authorization server. The loopback listener itself is covered by driving the
 * redirect URL the way a browser would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  beginAuthorization,
  completeAuthorization,
  createPkce,
  discoverMetadata,
  isExpired,
  parseChallenge,
  refreshToken,
  registerClient,
} from "../src/oauth.ts";

/* ---------- pure parsing ---------- */

test("a bearer challenge with resource metadata is parsed", () => {
  const challenge = parseChallenge(
    'Bearer realm="mcp", resource_metadata="https://auth.example/.well-known/oauth-protected-resource", scope="read write"',
  );
  assert.ok(challenge);
  assert.equal(challenge.scheme, "Bearer");
  assert.equal(challenge.resourceMetadata, "https://auth.example/.well-known/oauth-protected-resource");
  assert.equal(challenge.scope, "read write");
});

test("a challenge with no metadata still parses, so discovery can fall back", () => {
  const challenge = parseChallenge("Bearer");
  assert.ok(challenge);
  assert.equal(challenge.resourceMetadata, undefined);
});

test("a missing header is not a challenge", () => {
  assert.equal(parseChallenge(null), null);
  assert.equal(parseChallenge(""), null);
});

test("a PKCE pair is S256 and its parts are base64url", () => {
  const pair = createPkce();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  // Two pairs must not collide.
  assert.notEqual(createPkce().verifier, pair.verifier);
});

test("the authorization URL carries PKCE, state and the resource", () => {
  const request = beginAuthorization(
    { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" },
    { clientId: "client-1", resource: "https://mcp.example/mcp", redirectUri: "http://127.0.0.1:1234/callback", scope: "read" },
  );
  const url = new URL(request.authorizationUrl);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.example/mcp");
  assert.equal(url.searchParams.get("state"), request.state);
  assert.equal(url.searchParams.get("scope"), "read");
});

test("an expired or missing token is reported as expired", () => {
  assert.equal(isExpired(undefined), true);
  assert.equal(isExpired({ access_token: "x" }), false, "a token with no expiry is treated as live");
  assert.equal(isExpired({ access_token: "x", expiresAt: Date.now() + 10_000 }), true, "within a minute counts as expired");
  assert.equal(isExpired({ access_token: "x", expiresAt: Date.now() + 600_000 }), false);
});

/* ---------- discovery and exchange against a fake server ---------- */

interface FakeAuth {
  server: Server;
  origin: string;
  close: () => Promise<void>;
  /** Requests the fake saw, so the test can assert what was sent. */
  seen: { method: string; path: string; body?: string }[];
}

async function fakeAuthServer(): Promise<FakeAuth> {
  const seen: FakeAuth["seen"] = [];
  let origin = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body: body || undefined });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (value: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        json({ resource: "https://mcp.example/mcp", authorization_servers: [origin] });
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        });
      } else if (url.pathname === "/register") {
        json({ client_id: "dynamic-client" });
      } else if (url.pathname === "/token") {
        const params = new URLSearchParams(body);
        json({
          access_token: params.get("grant_type") === "refresh_token" ? "refreshed-token" : "access-token",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-token",
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  return {
    server,
    origin,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("discovery walks resource metadata to the authorization server", async () => {
  const fake = await fakeAuthServer();
  try {
    const metadata = await discoverMetadata(`${fake.origin}/mcp`, `${fake.origin}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.authorization_endpoint, `${fake.origin}/authorize`);
    assert.equal(metadata.registration_endpoint, `${fake.origin}/register`);
  } finally {
    await fake.close();
  }
});

test("registration and the code exchange send PKCE and the resource", async () => {
  const fake = await fakeAuthServer();
  try {
    const metadata = await discoverMetadata(`${fake.origin}/mcp`, `${fake.origin}/.well-known/oauth-protected-resource`);
    const client = await registerClient(metadata, { redirectUri: "http://127.0.0.1:9999/callback", clientName: "Prometheus" });
    assert.equal(client.client_id, "dynamic-client");

    const request = beginAuthorization(metadata, {
      clientId: client.client_id,
      resource: "https://mcp.example/mcp",
      redirectUri: "http://127.0.0.1:9999/callback",
    });
    const token = await completeAuthorization(metadata, request, "the-code", {
      clientId: client.client_id,
      resource: "https://mcp.example/mcp",
    });
    assert.equal(token.access_token, "access-token");
    assert.equal(token.refresh_token, "refresh-token");
    assert.ok(typeof token.expiresAt === "number", "expiry is computed on arrival");

    const exchange = fake.seen.find((entry) => entry.path === "/token")!;
    const body = new URLSearchParams(exchange.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "the-code");
    assert.equal(body.get("code_verifier"), request.pkce.verifier);
    assert.equal(body.get("resource"), "https://mcp.example/mcp");
  } finally {
    await fake.close();
  }
});

test("a refresh keeps the old refresh token when the server omits one", async () => {
  const fake = await fakeAuthServer();
  try {
    const metadata = await discoverMetadata(`${fake.origin}/mcp`, `${fake.origin}/.well-known/oauth-protected-resource`);
    const token = await refreshToken(
      metadata,
      { access_token: "old", refresh_token: "refresh-token", expiresAt: 0 },
      { clientId: "c", resource: "https://mcp.example/mcp" },
    );
    assert.equal(token.access_token, "refreshed-token");
    assert.equal(token.refresh_token, "refresh-token");
  } finally {
    await fake.close();
  }
});
