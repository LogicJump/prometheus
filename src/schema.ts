/**
 * A small JSON Schema check for headless output.
 *
 * `--output-schema` exists so a caller can ask for a structured final answer
 * without a second model round-trip. A full validator is a dependency this
 * project does not take; this covers the subset that structured-output schemas
 * actually use: type, properties, required, items, enum, and the numeric and
 * string bounds. Anything it does not understand is treated as satisfied,
 * because a false failure would reject good output.
 */

import { readFileSync } from "node:fs";

export interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean;
}

export interface SchemaCheck {
  valid: boolean;
  error?: string;
}

export function readSchema(file: string): SchemaNode {
  return JSON.parse(readFileSync(file, "utf8")) as SchemaNode;
}

/** Parse the model's final text, then check it against the schema. */
export function validateAgainstSchema(text: string, schema: SchemaNode): SchemaCheck {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch {
    return { valid: false, error: "the reply was not valid JSON" };
  }
  const error = check(value, schema, "$");
  return error ? { valid: false, error } : { valid: true };
}

/** Models often wrap JSON in a fence; take the outermost object or array. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return candidate.trim();
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  return end > start ? candidate.slice(start, end + 1) : candidate.trim();
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function check(value: unknown, schema: SchemaNode, path: string): string | null {
  if (!schema || typeof schema !== "object") return null;

  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    // JSON Schema calls an integer a number; accept it under "number".
    const matches = wanted.some((type) => type === actual || (type === "number" && actual === "number"));
    if (!matches) return `${path} should be ${wanted.join(" or ")}, got ${actual}`;
  }

  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    return `${path} is not one of the allowed values`;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below the minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above the maximum`;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long`;
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const error = check(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) return `${path}.${key} is required`;
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in object) {
        const error = check(object[key], child, `${path}.${key}`);
        if (error) return error;
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      const extra = Object.keys(object).find((key) => !allowed.has(key));
      if (extra) return `${path}.${extra} is not allowed`;
    }
  }

  return null;
}
