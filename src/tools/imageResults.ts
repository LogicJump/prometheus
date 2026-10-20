/**
 * Images on a tool result.
 *
 * A tool result is a text message in the chat protocol; the OpenAI-compatible
 * shape has no image slot on a `tool` message. `browser_screenshot` produced a
 * PNG and told the model its path, so the next turn could reason about a file
 * it had never seen — the tool description even promised "the image you
 * receive".
 *
 * The image travels beside the text and is delivered as a user message right
 * after the tool result, which is the one place a compatible endpoint accepts
 * image parts.
 */

import type { ImagePart, ToolResult } from "../types.ts";

/** Attach image data URLs to a result without touching its text. */
export function withImage(result: ToolResult & { images?: string[] }): ToolResult {
  return result;
}

/** The image parts the query loop should deliver for this result. */
export function imagePartsOf(result: unknown): ImagePart[] {
  const images = (result as { images?: unknown } | null | undefined)?.images;
  const urls = Array.isArray(images) ? images : [];
  return urls.filter((url) => typeof url === "string" && url.startsWith("data:image/")).map((url) => ({ type: "image_url", image_url: { url } }));
}
