import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { LLMUnavailableError, MockLLM, OpenAILLM, RecordingLLM, ReplayLLM, getLLM } from '../src/llm/index.ts';
import type { LLMConfig } from '../src/llm/index.ts';

const schema = z.object({ n: z.number() });

function config(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return { llmMode: 'openai', record: false, fixturesDir: '/tmp/receipts-fixtures-unused', openaiKey: 'sk-test-key', ...overrides };
}

describe('getLLM', () => {
  test('replay mode needs no key and ignores record', () => {
    const llm = getLLM(config({ llmMode: 'replay', openaiKey: undefined, record: true }));
    expect(llm).toBeInstanceOf(ReplayLLM);
    expect((llm as ReplayLLM).dir).toBe('/tmp/receipts-fixtures-unused');
  });

  test('openai mode without a key is unavailable', () => {
    expect(() => getLLM(config({ openaiKey: undefined }))).toThrow(LLMUnavailableError);
    expect(() => getLLM(config({ openaiKey: '' }))).toThrow('OPENAI_API_KEY missing');
    expect(() => getLLM(config({ openaiKey: undefined, record: true }))).toThrow('OPENAI_API_KEY missing');
  });

  test('openai mode returns the live client, wrapped when recording', () => {
    const live = getLLM(config());
    expect(live).toBeInstanceOf(OpenAILLM);
    expect(live.name).toBe('openai');
    const recording = getLLM(config({ record: true }));
    expect(recording).toBeInstanceOf(RecordingLLM);
    expect(recording.name).toBe('openai');
  });

  test('passes the pinned models through', async () => {
    const llm = getLLM(config({ model: 'gpt-5-mini', graderModel: 'gpt-5.2' })) as OpenAILLM;
    expect(await llm.resolveModel('extractor')).toBe('gpt-5-mini');
    expect(await llm.resolveModel('grader')).toBe('gpt-5.2');
  });
});

describe('MockLLM', () => {
  test('answers from the handler, validates, and records calls', async () => {
    const llm = new MockLLM(async (req) => ({ n: req.variant === 'A' ? 1 : 2 }));
    const a = await llm.json({ schemaName: 's', schema, system: 'sys', user: 'u', variant: 'A' });
    const b = await llm.json({ schemaName: 's', schema, system: 'sys', user: 'u' });
    expect(a).toEqual({ data: { n: 1 }, citations: [], model: 'mock' });
    expect(b.data).toEqual({ n: 2 });
    expect(llm.calls.map((c) => c.variant)).toEqual(['A', undefined]);
  });

  test('rejects handler data that breaks the schema', async () => {
    const llm = new MockLLM(() => ({ n: 'one' }));
    await expect(llm.json({ schemaName: 's', schema, system: '', user: '' })).rejects.toThrow();
  });
});
