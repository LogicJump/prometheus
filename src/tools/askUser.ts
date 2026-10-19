/**
 * Structured questions the model can ask the user.
 *
 * A model that needs a decision could only write a paragraph and wait: the
 * desktop could not render options, the terminal could not offer keys, and the
 * answer came back as free text that had to be parsed. This tool asks one to
 * four questions, each with two to four options, and returns the chosen
 * values as a map. `multiSelect` and per-option `preview` cover the two shapes
 * that a plain list cannot express: "pick any of these" and "compare these
 * before choosing".
 *
 * The tool is safe in plan mode: it changes nothing, it only asks.
 */

import type { Tool, ToolResult } from "../types.ts";

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  question: string;
  /** Selected labels, in the order the user chose them. */
  selected: string[];
}

/** Validate the tool's raw input; returns a message on the first problem. */
export function parseQuestions(input: Record<string, unknown>): AskQuestion[] | string {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return "questions must be a non-empty array";
  if (raw.length > 4) return "at most four questions can be asked at once";
  const questions: AskQuestion[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index] as Record<string, unknown> | undefined;
    if (!entry || typeof entry.question !== "string" || !entry.question.trim()) {
      return `question ${index + 1} needs a "question" string`;
    }
    const options = Array.isArray(entry.options) ? entry.options : [];
    if (options.length < 2 || options.length > 4) {
      return `question ${index + 1} needs two to four options`;
    }
    const parsedOptions: AskOption[] = [];
    for (const option of options) {
      const value = option as Record<string, unknown>;
      if (typeof value?.label !== "string" || !value.label.trim()) {
        return `question ${index + 1} has an option without a label`;
      }
      parsedOptions.push({
        label: value.label.trim().slice(0, 120),
        ...(typeof value.description === "string" ? { description: value.description.slice(0, 2_000) } : {}),
        ...(typeof value.preview === "string" ? { preview: value.preview.slice(0, 20_000) } : {}),
      });
    }
    questions.push({
      question: entry.question.trim().slice(0, 2_000),
      ...(typeof entry.header === "string" ? { header: entry.header.slice(0, 40) } : {}),
      options: parsedOptions,
      ...(entry.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

/**
 * Format an answer for the model.
 *
 * Plain text rather than JSON: the model reads it in the same turn, and a
 * labelled list survives being quoted back to the user.
 */
export function formatAnswers(answers: AskAnswer[]): string {
  return answers
    .map((answer) => `${answer.question}\n${answer.selected.map((value) => `- ${value}`).join("\n")}`)
    .join("\n\n");
}

/**
 * A terminal answer for environments with no option UI.
 *
 * The terminal asks the question as a numbered list and reads a line; this
 * keeps the tool usable in the REPL without a new interaction model. A
 * cancelled read returns the first option, which is the least surprising
 * default for a question the model considered worth blocking on.
 */
export async function askInTerminal(
  questions: AskQuestion[],
  ask: (question: string, options: { value: string; label: string }[]) => Promise<string>,
): Promise<AskAnswer[]> {
  const answers: AskAnswer[] = [];
  for (const question of questions) {
    const choice = await ask(
      question.question,
      question.options.map((option) => ({
        value: option.label,
        label: option.description ? `${option.label} — ${option.description}` : option.label,
      })),
    );
    answers.push({ question: question.question, selected: [choice] });
  }
  return answers;
}

export const askUserTool: Tool = {
  name: "ask_user",
  description:
    "Ask the user to choose between options when you need a decision you cannot make from the code. " +
    "Ask one to four questions, each with two to four options. Use it instead of writing a paragraph of questions and stopping. " +
    "The user can always answer something else, so do not treat the options as exhaustive.",
  readonly: true,
  parallelSafe: false,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The full question" },
            header: { type: "string", description: "Short label (max ~12 chars)" },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string", description: "What choosing this means" },
                  preview: { type: "string", description: "Monospace content to compare (code, layout)" },
                },
                required: ["label"],
                additionalProperties: false,
              },
            },
            multiSelect: { type: "boolean", description: "Allow more than one answer" },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  summarize: (input) => {
    const questions = Array.isArray(input.questions) ? input.questions.length : 0;
    return `${questions} question${questions === 1 ? "" : "s"}`;
  },
  async execute(input, ctx): Promise<ToolResult> {
    const parsed = parseQuestions(input);
    if (typeof parsed === "string") return { isError: true, content: parsed };

    // A UI that can render a preview uses the richer channel; the terminal and
    // the headless JsonUi keep `ask`, which only needs values and labels.
    const rich = (ctx.ui as { askWithOptions?: (q: string, o: unknown, extra?: unknown) => Promise<string> })
      .askWithOptions;
    const fallback = ctx.ui.ask?.bind(ctx.ui);
    // Normalise the two channels to one shape. Without the typed signature the
    // call site cannot pass the extra argument, so the adapter is explicit.
    const ask: ((q: string, o: { value: string; label: string; preview?: string }[], extra?: unknown) => Promise<string>) | undefined = rich
      ? (q, o, extra) => rich.call(ctx.ui, q, o, extra)
      : fallback
        ? (q, o) => fallback(q, o.map((option) => ({ value: option.value, label: option.label })))
        : undefined;
    if (!ask) {
      return {
        isError: true,
        content:
          "this run has no way to ask a question. Decide using your best judgement, and say which assumption you made.",
      };
    }
    try {
      // One call per question through the same channel the permission bar
      // uses, so the desktop renders buttons and the terminal a numbered list
      // without a second protocol.
      const answers: AskAnswer[] = [];
      for (const question of parsed) {
        const options = question.options.map((option) => ({
          value: option.label,
          label: option.description ? `${option.label} — ${option.description}` : option.label,
          ...(option.preview ? { preview: option.preview } : {}),
        }));
        if (question.multiSelect) {
          const answer = await ask(
            `${question.question}\n(multi-select: separate several choices with commas)`,
            options,
            { multiSelect: true, header: question.header },
          );
          const selected = answer
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          answers.push({ question: question.question, selected: selected.length > 0 ? selected : [answer] });
        } else {
          const answer = await ask(question.question, options, { header: question.header });
          answers.push({ question: question.question, selected: [answer] });
        }
      }
      return {
        content: formatAnswers(answers),
        display: answers.map((answer) => answer.selected.join(", ")).join("; ").slice(0, 80),
        data: answers,
      };
    } catch (err) {
      return { isError: true, content: `the question could not be asked: ${(err as Error).message}` };
    }
  },
};
