// Zod schema -> JSON schema that OpenAI structured outputs accept with
// strict:true. Strict mode wants every object closed (additionalProperties
// false) with every property listed in `required`, and rejects a handful of
// keywords. The zod schema stays the source of truth: replies are validated
// against it afterwards, so constraints dropped here are still enforced.

import { z } from 'zod';

export type JsonSchema = { [key: string]: unknown };

// Keywords strict mode rejects. minLength/maxLength and friends are enforced
// by zod on the parsed reply instead.
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  'default',
  'examples',
  'minLength',
  'maxLength',
  'uniqueItems',
  'propertyNames',
  'patternProperties',
  'unevaluatedProperties',
  'minProperties',
  'maxProperties',
]);

// Keywords whose value is a map of name -> schema. The names are data (a
// property may well be called "default"), so only the values are walked.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions']);
// Keywords whose value is a schema or a list of schemas.
const SCHEMA_KEYWORDS = new Set(['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf', 'not', 'additionalProperties']);

function isRecord(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// z.number().int() emits +-MAX_SAFE_INTEGER bounds that carry no meaning.
function isSafeIntegerBound(key: string, value: unknown): boolean {
  return (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) || (key === 'maximum' && value === Number.MAX_SAFE_INTEGER);
}

function isObjectSchema(node: JsonSchema): boolean {
  const t = node.type;
  return t === 'object' || (Array.isArray(t) && t.includes('object'));
}

function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  return isRecord(node) ? strictNode(node) : node;
}

function strictMap(map: unknown): unknown {
  if (!isRecord(map)) return map;
  return Object.fromEntries(Object.entries(map).map(([name, schema]) => [name, strictSchema(schema)]));
}

function strictNode(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key) || isSafeIntegerBound(key, value)) continue;
    // Strict mode has no oneOf; anyOf is looser, and zod re-checks exclusivity.
    const outKey = key === 'oneOf' ? 'anyOf' : key;
    if (SCHEMA_MAP_KEYWORDS.has(key)) out[outKey] = strictMap(value);
    else if (SCHEMA_KEYWORDS.has(key)) out[outKey] = strictSchema(value);
    else out[outKey] = value;
  }
  return isObjectSchema(out) ? closeObject(out) : out;
}

function closeObject(node: JsonSchema): JsonSchema {
  const properties = isRecord(node.properties) ? node.properties : {};
  const extra = node.additionalProperties;
  if (Object.keys(properties).length === 0 && isRecord(extra) && Object.keys(extra).length > 0) {
    throw new Error('toOpenAISchema: records/maps (z.record) are not allowed in strict mode; use an array of objects');
  }
  // Optional fields become required: the model then always sends a value,
  // which zod accepts. Schemas should prefer .nullable() over .optional().
  return { ...node, properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * JSON schema for `text.format.schema` with strict:true. Uses zod's input
 * side because the model produces what zod parses. Throws for shapes strict
 * mode cannot express (non-object root, records, dates, transforms).
 */
export function toOpenAISchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: 'input' });
  const out = strictNode(raw as JsonSchema);
  if (out.type !== 'object') {
    throw new Error('toOpenAISchema: the root schema must be a z.object (OpenAI requires an object at the root)');
  }
  return out;
}
