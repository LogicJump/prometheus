/**
 * Turning `@path` references into the text the model sees.
 *
 * The blocks were joined with a literal two-character `\n\n` — an escaped
 * backslash in the template, not a newline — so every referenced file was
 * pasted into the prompt separated by `\n\n` as text. The model read it as
 * content, which is exactly what a file block must not look like.
 */

/**
 * The message with each mentioned file inlined as a `<file>` block.
 *
 * @param {string} text
 * @param {{path: string, content: string, bytes?: number, binary?: boolean, tooLarge?: boolean}[]} files
 * @returns {string}
 */
export function withMentionedFiles(text, files) {
  if (!Array.isArray(files) || files.length === 0) return text;
  const blocks = files.map((file) => {
    if (file.tooLarge) return `<file path="${file.path}" bytes="${file.bytes ?? 0}">too large to inline; read it with read_file</file>`;
    if (file.binary) return `<file path="${file.path}">binary file; not inlined</file>`;
    return `<file path=${JSON.stringify(file.path)}>${file.content}</file>`;
  });
  if (blocks.length === 0) return text;
  return `${blocks.join("\n\n")}\n\n${text}`;
}
