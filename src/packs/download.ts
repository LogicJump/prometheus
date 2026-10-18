/**
 * Fetching an archive, and proving it is the one we asked for.
 *
 * Two properties matter more than speed:
 *
 *   The bytes on disk are the bytes that were hashed. Hashing in a second pass
 *   leaves a window where the file can change between the two reads; hashing as
 *   the stream is written closes it.
 *
 *   The hash is checked before anything is extracted. A corrupt or substituted
 *   archive fails here, with both hashes named, rather than surfacing as a
 *   strange error during extraction or, worse, as a binary that runs.
 *
 * Redirects are followed, but the host that finally answers must be one the
 * catalog named. Vendor download URLs redirect to CDNs constantly; an open
 * redirect to somewhere else is the case this guards against.
 */

import { createHash } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PackSource } from "./manifest.ts";

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadProgress {
  received: number;
  total?: number;
}

export interface DownloadOptions {
  destination: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Download `source` to `destination`, hashing as it goes, and verify.
 *
 * The file is removed on any failure, so a caller never has to distinguish
 * "absent" from "partial".
 */
export async function downloadVerified(source: PackSource, options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hash = createHash("sha256");
  let received = 0;

  const abort = options.signal;
  if (abort?.aborted) throw new DownloadError("cancelled before starting");

  try {
    const response = await fetchImpl(source.url, {
      redirect: "follow",
      signal: abort,
      headers: { "user-agent": "Prometheus toolchain packs" },
    });

    if (!response.ok) {
      throw new DownloadError(`${source.url} returned HTTP ${response.status} ${response.statusText}`);
    }

    // `response.url` is the final URL after redirects. Its host must be one the
    // catalog listed; a redirect elsewhere means the artifact is not ours.
    const finalHost = safeHost(response.url);
    if (finalHost && !source.hosts.some((host) => host.toLowerCase() === finalHost.toLowerCase())) {
      throw new DownloadError(
        `redirected to ${finalHost}, which is not an approved host for this pack (expected one of ${source.hosts.join(", ")})`,
      );
    }

    if (!response.body) throw new DownloadError(`${source.url} returned no body`);

    const declared = Number(response.headers.get("content-length") ?? 0);
    const total = declared > 0 ? declared : source.bytes > 0 ? source.bytes : undefined;

    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      options.onProgress?.({ received, ...(total ? { total } : {}) });
    });

    await pipeline(body, createWriteStream(options.destination));

    if (total && received < total) {
      throw new DownloadError(`download ended at ${received} of ${total} bytes`);
    }
    if (source.bytes > 0 && received !== source.bytes) {
      throw new DownloadError(`expected ${source.bytes} bytes, received ${received}`);
    }

    const sha256 = hash.digest("hex");
    if (sha256 !== source.sha256.toLowerCase()) {
      throw new DownloadError(
        `checksum mismatch for ${source.url}\n  expected ${source.sha256}\n  received ${sha256}\n` +
          `The file was not installed. It may be a partial download, or the publisher replaced the release.`,
      );
    }

    return { bytes: received, sha256 };
  } catch (error) {
    // Never leave a partial file behind: the next attempt must start clean, and
    // a stray archive is exactly the disk clutter this feature avoids.
    try {
      rmSync(options.destination, { force: true });
    } catch {
      /* already gone */
    }
    if (error instanceof DownloadError) throw error;
    if (abort?.aborted) throw new DownloadError("cancelled");
    throw new DownloadError(error instanceof Error ? error.message : String(error));
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
