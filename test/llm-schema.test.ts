import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { toOpenAISchema } from '../src/llm/schema.ts';
import type { JsonSchema } from '../src/llm/schema.ts';
import { zDate } from '../src/types.ts';

// Every schema node reachable from the root, including anyOf branches and array items.
function nodes(schema: unknown): JsonSchema[] {
  if (Array.isArray(schema)) return schema.flatMap(nodes);
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as JsonSchema;
  const children = Object.entries(node).flatMap(([key, value]) => {
    if (key === 'properties' || key === '$defs') return Object.values(value as JsonSchema).flatMap(nodes);
    if (['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties'].includes(key)) return nodes(value);
    return [];
  });
  return [node, ...children];
}

// The OpenAI strict-mode rules this module promises.
function expectStrict(schema: JsonSchema): void {
  expect(schema.type).toBe('object');
  for (const node of nodes(schema)) {
    expect(node).not.toHaveProperty('$schema');
    expect(node).not.toHaveProperty('default');
    expect(node).not.toHaveProperty('oneOf');
    if (node.type !== 'object') continue;
    expect(node.additionalProperties).toBe(false);
    expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as JsonSchema).sort());
  }
}

const extractLike = z.object({
  claims: z.array(
    z.object({
      quote: z.string(),
      type: z.enum(['prediction', 'stance', 'factual']),
      targetDate: zDate.nullable(),
      targetDateInferred: z.boolean(),
      specificity: z.number().int(),
      source: z.object({ url: z.string(), title: z.string().nullable() }).nullable(),
    }),
  ),
});

describe('toOpenAISchema', () => {
  test('nested objects and arrays of objects follow strict rules', () => {
    const schema = toOpenAISchema(extractLike);
    expectStrict(schema);
    const item = (schema.properties as any).claims.items;
    expect(item.type).toBe('object');
    expect(item.required).toEqual(['quote', 'type', 'targetDate', 'targetDateInferred', 'specificity', 'source']);
  });

  test('nullable fields allow null; enums keep their values', () => {
    const item = (toOpenAISchema(extractLike).properties as any).claims.items.properties;
    const dateTypes = item.targetDate.anyOf ?? [{ type: item.targetDate.type }];
    expect(dateTypes).toContainEqual({ type: 'null' });
    expect(dateTypes.find((s: JsonSchema) => s.type === 'string').pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    expect(item.type).toEqual({ type: 'string', enum: ['prediction', 'stance', 'factual'] });
    const nested = item.source.anyOf.find((s: JsonSchema) => s.type === 'object');
    expect(nested.additionalProperties).toBe(false);
    expect(nested.required).toEqual(['url', 'title']);
  });

  test('drops the meaningless safe-integer bounds of .int() but keeps real ones', () => {
    const props = toOpenAISchema(z.object({ n: z.number().int(), p: z.number().min(0).max(1) })).properties as any;
    expect(props.n).toEqual({ type: 'integer' });
    expect(props.p).toEqual({ type: 'number', minimum: 0, maximum: 1 });
  });

  test('optional and defaulted fields become required, defaults and length limits are stripped', () => {
    const schema = toOpenAISchema(
      z.object({ a: z.string().optional(), b: z.boolean().default(false), c: z.string().min(1).max(10) }),
    );
    expectStrict(schema);
    expect((schema.properties as any).c).toEqual({ type: 'string' });
  });

  test('property names that look like keywords are kept', () => {
    const schema = toOpenAISchema(z.object({ default: z.string(), minLength: z.number(), $schema: z.string() }));
    expect(Object.keys(schema.properties as JsonSchema)).toEqual(['default', 'minLength', '$schema']);
    expect(schema.required).toEqual(['default', 'minLength', '$schema']);
  });

  test('closes loose objects and turns oneOf unions into anyOf', () => {
    const schema = toOpenAISchema(
      z.object({
        loose: z.looseObject({ a: z.string() }),
        pick: z.discriminatedUnion('k', [z.object({ k: z.literal('a') }), z.object({ k: z.literal('b') })]),
      }),
    );
    expectStrict(schema);
    expect((schema.properties as any).pick.anyOf).toHaveLength(2);
  });

  test('keeps descriptions', () => {
    const schema = toOpenAISchema(z.object({ hedge: z.string().describe('exact hedge words') }));
    expect((schema.properties as any).hedge.description).toBe('exact hedge words');
  });

  test('rejects shapes strict mode cannot express', () => {
    expect(() => toOpenAISchema(z.array(z.string()))).toThrow('root schema must be a z.object');
    expect(() => toOpenAISchema(z.object({ m: z.record(z.string(), z.number()) }))).toThrow('z.record');
    expect(() => toOpenAISchema(z.object({ d: z.date() }))).toThrow();
  });
});
