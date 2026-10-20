/**
 * Round 9, batch 6: the browser pane the agent uses is the one the user sees,
 * and a screenshot the agent takes is an image the model can look at.
 *
 * U22 — `browser_open` opened a page in a hidden `WebContentsView` without
 * opening the pane, so the agent reported "opened" and nothing appeared.
 * U23 — `browser_screenshot` returned a file path in its text. The tool result
 * channel carries text only, so the model was told about an image it could not
 * see, and the tool's own description promised "the image you receive".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withImage, imagePartsOf } from "../src/tools/imageResults.ts";
import { browserTools, setBrowserBridge } from "../src/tools/browserTools.ts";
import { resolve } from "node:path";

const app = readFileSync("desktop/renderer/app.js", "utf8");
const host = readFileSync("desktop/host.js", "utf8");
const query = readFileSync("src/query.ts", "utf8");
const types = readFileSync("src/types.ts", "utf8");

/* ---------- U22 ---------- */

test("opening a page from the agent brings the pane to the front", () => {
  const start = app.indexOf('case "browser_request"');
  const body = app.slice(start, app.indexOf('case "tool_start"', start));
  assert.match(body, /request\.kind === "open"[\s\S]{0,600}openWorkbench\("browser"\)/, "the pane is opened");
  assert.match(body, /scheduleBrowserBounds/, "the view is told where the pane is");
});

/* ---------- U23 ---------- */

test("an image result travels as a message part, not as a path in text", () => {
  const outcome = withImage({ ok: true, content: "shot saved", images: ["data:image/png;base64,AAAA"] });
  assert.equal(outcome.content, "shot saved");
  assert.deepEqual(imagePartsOf(outcome), [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]);
});

test("a result without images yields no parts", () => {
  assert.deepEqual(imagePartsOf({ ok: true, content: "plain" }), []);
});

test("the tool result type can carry images", () => {
  assert.match(types, /images\?: string\[\]/);
});

test("the pipeline outcome passes them through", () => {
  const pipeline = readFileSync("src/tools/pipeline.ts", "utf8");
  assert.match(pipeline, /images: result\.images|images,/);
});

test("the query loop turns a tool's images into a user message the model can see", () => {
  // The OpenAI chat shape has no image slot on a tool message, so the images
  // follow as a user message naming the call they belong to.
  assert.match(query, /images/);
  assert.match(query, /imagePartsOf|image_url/);
});

test("the screenshot tool returns the image itself", async () => {
  setBrowserBridge({
    request: async () => ({ ok: true, url: "https://example.com", text: resolve("shot.png"), dataUrl: "data:image/png;base64,BBBB" }),
  });
  try {
    const shot = browserTools.find((tool) => tool.name === "browser_screenshot");
    const result = await shot.execute({}, undefined as never);
    assert.deepEqual(result.images, ["data:image/png;base64,BBBB"]);
    assert.match(result.content, /https:\/\/example\.com/);
  } finally {
    setBrowserBridge(null);
  }
});

test("a screenshot with no image data says so instead of claiming success", async () => {
  setBrowserBridge({ request: async () => ({ ok: true, url: "https://example.com", text: resolve("shot.png") }) });
  try {
    const shot = browserTools.find((tool) => tool.name === "browser_screenshot");
    const result = await shot.execute({}, {});
    assert.equal(result.isError, true);
  } finally {
    setBrowserBridge(null);
  }
});

test("the host answers the renderer with the image data, not only the path", () => {
  // The renderer reads `dataUrl` off the screenshot and puts it on the bridge
  // result; the host relays that result whole, so the image reaches the tool.
  assert.match(app, /dataUrl: shot\.dataUrl/);
  assert.match(host, /resolve\(cmd\.result/);
  const bridge = readFileSync("src/tools/browserTools.ts", "utf8");
  assert.match(bridge, /dataUrl\?: string/);
});
