// mcp-agent-neutral-checks.ts — shared assertions for the Agent-neutral Tool contract
// (plan docs/plans/2026-10-03-mcp-edit-before-export.md, G13 + G14). Imported by the verify
// scripts of Tasks 6, 7, 13 and 14; it is not a verify script itself (no `verify-` prefix, so
// verify-mcp-ci-coverage does not expect a CI entry for it).
//
// Both functions return a list of problems (empty = pass) so a caller can print every
// violation at once instead of stopping at the first.

/** A tool as `tools/list` emits it (name + the JSON Schema the SDK generated). */
export type ListedTool = { name: string; inputSchema?: unknown };

const FORBIDDEN_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "$ref"];
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function forbiddenKeyPaths(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenKeyPaths(item, `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SCHEMA_KEYS.includes(key)) out.push(`${path}.${key}`);
    forbiddenKeyPaths(child, `${path}.${key}`, out);
  }
}

/** A flat primitive property: one primitive `type`, and any `enum` holds strings only. */
function primitiveProblem(schema: unknown, where: string): string | null {
  if (!isRecord(schema)) return `${where}: not a schema object`;
  if (typeof schema.type !== "string" || !PRIMITIVE_TYPES.has(schema.type)) {
    return `${where}: type ${JSON.stringify(schema.type)} is not one flat primitive`;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.some((value) => typeof value !== "string")) {
      return `${where}: enum must be string values only (G13 numeric choices are string enums)`;
    }
  }
  return null;
}

/**
 * G13: every named tool is listed, its input is an object of flat primitives / string enums
 * with at most ONE array of flat objects, and the emitted schema has no oneOf/anyOf/allOf
 * (nor $ref) anywhere.
 */
export function verifyAgentNeutralSchemas(tools: readonly ListedTool[], names: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of names) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      problems.push(`${name}: not listed`);
      continue;
    }
    const schema = tool.inputSchema;
    if (!isRecord(schema) || schema.type !== "object") {
      problems.push(`${name}: inputSchema is not an object schema`);
      continue;
    }
    const forbidden: string[] = [];
    forbiddenKeyPaths(schema, name, forbidden);
    for (const path of forbidden) problems.push(`${path}: forbidden combinator/reference`);

    const properties = isRecord(schema.properties) ? schema.properties : {};
    let arrays = 0;
    for (const [key, property] of Object.entries(properties)) {
      const where = `${name}.${key}`;
      if (isRecord(property) && property.type === "array") {
        arrays += 1;
        const items = property.items;
        if (!isRecord(items) || items.type !== "object" || !isRecord(items.properties)) {
          problems.push(`${where}: an array must hold flat objects`);
          continue;
        }
        for (const [itemKey, itemProperty] of Object.entries(items.properties)) {
          const problem = primitiveProblem(itemProperty, `${where}[].${itemKey}`);
          if (problem) problems.push(problem);
        }
        continue;
      }
      const problem = primitiveProblem(property, where);
      if (problem) problems.push(problem);
    }
    if (arrays > 1) problems.push(`${name}: ${arrays} array properties (at most one allowed)`);
  }
  return problems;
}

const THAI = /[฀-๿]/u;

/** G14: `{ error, code, message (Thai), next }` with `error === code`. */
export function checkFailureEnvelope(value: unknown): string[] {
  if (!isRecord(value)) return ["reply is not an object"];
  const problems: string[] = [];
  if (typeof value.error !== "string" || !value.error) problems.push("error is not a non-empty string");
  if (value.code !== value.error) problems.push(`code ${JSON.stringify(value.code)} !== error ${JSON.stringify(value.error)}`);
  if (typeof value.message !== "string" || !THAI.test(value.message)) problems.push("message is not Thai text");
  if (typeof value.next !== "string" || !value.next.trim()) problems.push("next is not a non-empty string");
  return problems;
}
