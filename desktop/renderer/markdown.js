/** Minimal, dependency-free markdown renderer shared by the transcript and previews. */

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/** Minimal, dependency-free markdown renderer (headings, lists, code, inline). */
export function renderMarkdown(source, copyLabel = "copy") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const inline = (text) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`);

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, "") || "text";
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre><div class="code-head"><span>${escapeHtml(lang)}</span>` +
          `<button class="code-copy" data-code>${escapeHtml(copyLabel)}</button></div>` +
          `<code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*])\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && (/^\s*([-*])\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return out.join("");
}

/**
 * Render a growing message one block at a time.
 *
 * Re-rendering the whole reply on every animation frame is O(n) per frame, so
 * a long answer got slower the more of it existed — the scroll stuttered
 * exactly while the user was waiting for it. A block is any run of markdown
 * separated by a blank line (or an open fence); completed blocks are rendered
 * once and cached, and only the block still receiving text is re-rendered.
 *
 * The cache is keyed by the block's source text rather than by index, so a
 * retry that discards the reply simply stops matching and starts over.
 */
export class IncrementalRenderer {
  constructor(copyLabel = "copy") {
    this.copyLabel = copyLabel;
    this.blocks = [];
    this.lastSignature = "";
  }

  reset() {
    this.blocks = [];
    this.lastSignature = "";
  }

  /** Split on blank lines, but never inside an unclosed fence. */
  static split(source) {
    const lines = source.replace(/\r?\n/g, "\n").split("\n");
    const blocks = [];
    let current = [];
    let fenced = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) fenced = !fenced;
      if (!fenced && line.trim() === "") {
        if (current.length > 0) blocks.push(current.join("\n"));
        current = [];
        continue;
      }
      current.push(line);
    }
    if (current.length > 0) blocks.push(current.join("\n"));
    return blocks;
  }

  /** The full HTML for the source so far. */
  render(source) {
    const blocks = IncrementalRenderer.split(source);
    const signature = blocks.join("\u0000");
    if (signature === this.lastSignature) return this.html();
    // Reuse the render of every block whose text did not change; only the
    // tail block is usually different.
    for (let index = 0; index < blocks.length; index++) {
      const cached = this.blocks[index];
      if (cached && cached.source === blocks[index]) continue;
      this.blocks[index] = { source: blocks[index], html: renderMarkdown(blocks[index], this.copyLabel) };
    }
    this.blocks.length = blocks.length;
    this.lastSignature = signature;
    return this.html();
  }

  html() {
    return this.blocks.map((block) => block.html).join("");
  }
}
