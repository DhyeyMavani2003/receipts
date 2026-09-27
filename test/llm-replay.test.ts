import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { MockLLM } from '../src/llm/mock.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import type { JsonRequest } from '../src/llm/provider.ts';
import { RecordingLLM, ReplayLLM, ReplayMissError, fixtureFileName, fixtureKey, promptDifference } from '../src/llm/replay.ts';

const schema = z.object({ answer: z.string() });
type Answer = z.infer<typeof schema>;

function request(overrides: Partial<JsonRequest<Answer>> = {}): JsonRequest<Answer> {
  return { schemaName: 'ask_answer', schema, system: 'Answer briefly.', user: 'Will it happen?', ...overrides };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'receipts-llm-replay-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fixtureKey', () => {
  test('is 16 hex chars and stable', () => {
    const key = fixtureKey(request());
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(fixtureKey(request())).toBe(key);
    expect(fixtureFileName(request())).toBe(`ask_answer-${key}.json`);
  });

  test('changes with every identity field but not with role or schema object', () => {
    const base = fixtureKey(request());
    for (const change of [{ schemaName: 'other' }, { variant: 'A' }, { system: 'x' }, { user: 'y' }, { webSearch: true }]) {
      expect(fixtureKey(request(change))).not.toBe(base);
    }
    expect(fixtureKey(request({ role: 'grader' }))).toBe(base);
    expect(fixtureKey(request({ webSearch: false }))).toBe(base);
  });
});

describe('RecordingLLM + ReplayLLM', () => {
  test('records pretty JSON fixtures that replay offline', async () => {
    const live = new MockLLM(() => ({ answer: 'Probably not.' }), {
      model: 'gpt-5-2025-08-07',
      citations: () => [{ url: 'https://example.com/source', title: 'Source' }],
    });
    const recorder = new RecordingLLM(live, join(dir, 'llm'));
    const req = request({ variant: 'A', webSearch: true });
    const recorded = await recorder.json(req);
    expect(recorder.name).toBe('mock');

    const file = join(dir, 'llm', fixtureFileName(req));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('\n  "request": {');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      request: {
        schemaName: 'ask_answer',
        variant: 'A',
        system_sha: expect.stringMatching(/^[0-9a-f]{16}$/),
        user_excerpt: 'Will it happen?',
      },
      response: {
        data: { answer: 'Probably not.' },
        citations: [{ url: 'https://example.com/source', title: 'Source' }],
        model: 'gpt-5-2025-08-07',
      },
    });

    const replayed = await new ReplayLLM(join(dir, 'llm')).json(req);
    expect(replayed).toEqual({ ...recorded, model: 'replay:gpt-5-2025-08-07' });
  });

  test('never writes keys or headers into fixtures', async () => {
    const leaky = 'sk-proj-LEAKLEAKLEAKLEAKLEAK';
    const recorder = new RecordingLLM(new MockLLM(() => ({ answer: `echo ${leaky}` })), dir);
    await recorder.json(request({ user: `transcript mentions ${leaky}` }));
    const [file] = readdirSync(dir);
    const text = readFileSync(join(dir, file), 'utf8');
    expect(text).not.toContain('LEAKLEAK');
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text.toLowerCase()).not.toContain('bearer');
  });

  test('never writes URL signing tokens into fixtures, and still replays evidence checks', async () => {
    const signed = 'https://cdn.example/report.pdf?id=4&X-Amz-Signature=SIGNSIGN&Authorization=TOKENTOKEN';
    const live = new MockLLM(() => ({ answer: signed }), { citations: () => [{ url: signed }], searched: () => [{ url: signed }] });
    const req = request({ webSearch: true });
    await new RecordingLLM(live, dir).json(req);
    const text = readFileSync(join(dir, fixtureFileName(req)), 'utf8');
    expect(text).not.toContain('SIGNSIGN');
    expect(text).not.toContain('TOKENTOKEN');
    const replayed = await new ReplayLLM(dir).json(req);
    expect(replayed.data).toEqual({ answer: 'https://cdn.example/report.pdf?id=4' });
    expect(replayed.searched).toEqual([{ url: 'https://cdn.example/report.pdf?id=4' }]);
  });

  test('keeps the user excerpt short', async () => {
    await new RecordingLLM(new MockLLM(() => ({ answer: 'ok' })), dir).json(request({ user: 'x'.repeat(5000) }));
    const [file] = readdirSync(dir);
    expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).request.user_excerpt).toHaveLength(200);
  });

  test('a live answer never replaces a hand-written fixture; a regenerating script still can', async () => {
    const req = request();
    const path = join(dir, fixtureFileName(req));
    for (const model of ['synthetic-fixture', 'human:seed-drift']) {
      const handWritten = JSON.stringify({ response: { data: { answer: 'hand' }, citations: [], model } });
      writeFileSync(path, handWritten);
      const warnings: string[] = [];
      const recorder = new RecordingLLM(new MockLLM(() => ({ answer: 'live' }), { model: 'gpt-5.5' }), dir, (w) => warnings.push(w));
      expect((await recorder.json(req)).data).toEqual({ answer: 'live' });
      expect(readFileSync(path, 'utf8')).toBe(handWritten);
      expect(warnings).toEqual([`Not recorded: ${fixtureFileName(req)} is a hand-written fixture and stays as it is. Record with your own episode's values.`]);
      await new RecordingLLM(new MockLLM(() => ({ answer: 'regenerated' }), { model }), dir).json(req);
      expect(JSON.parse(readFileSync(path, 'utf8')).response.data).toEqual({ answer: 'regenerated' });
    }
    writeFileSync(path, JSON.stringify({ response: { data: { answer: 'old' }, citations: [], model: 'gpt-5' } }));
    await new RecordingLLM(new MockLLM(() => ({ answer: 'new' }), { model: 'gpt-5.5' }), dir).json(req);
    expect(JSON.parse(readFileSync(path, 'utf8')).response.data).toEqual({ answer: 'new' });
  });

  test('records the pages the search read, and replays them', async () => {
    const live = new MockLLM(() => ({ answer: 'ok' }), { model: 'gpt-5.5', searched: () => [{ url: 'https://example.com/read' }] });
    const req = request({ webSearch: true });
    await new RecordingLLM(live, dir).json(req);
    expect((await new ReplayLLM(dir).json(req)).searched).toEqual([{ url: 'https://example.com/read' }]);
  });

  test('does not write a fixture when the live call fails', async () => {
    const recorder = new RecordingLLM(new MockLLM(() => ({ wrong: true })), dir);
    await expect(recorder.json(request())).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('ReplayLLM', () => {
  test('a missing fixture throws a ReplayMissError naming the file, never its absolute path', async () => {
    const req = request({ variant: 'B' });
    const promise = new ReplayLLM(dir).json(req);
    await expect(promise).rejects.toBeInstanceOf(LLMUnavailableError);
    await expect(promise).rejects.toBeInstanceOf(ReplayMissError);
    await expect(promise).rejects.toThrow(fixtureFileName(req));
    const message = await promise.catch((e: Error) => e.message);
    expect(message).not.toContain(dir);
    expect(message).toContain('Use exactly the speaker, host, title, date, link and --today');
  });

  test('a miss names the prompt line that differs from the closest recording', async () => {
    const recorded = 'Speaker: Dana Founder\nHost (never attribute their words to the speaker): Sam Host\nSource: "Synthetic" (podcast) https://example.com/s\nDate said: 2025-01-15 (';
    await new RecordingLLM(new MockLLM(() => ({ answer: 'x' })), dir).json(request({ schemaName: 'extract_claims', user: `${recorded}x)\n` }));
    const noHost = request({ schemaName: 'extract_claims', user: 'Speaker: Dana Founder\nSource: "Synthetic" (podcast) https://example.com/s\nDate said: 2025-01-15 (x)' });
    await expect(new ReplayLLM(dir).json(noHost)).rejects.toThrow('differs in Host: recorded "Sam Host", this request none');
  });

  test('promptDifference: first differing labeled line, extra lines, or the text after them', () => {
    const rec = 'Speaker: Dana Founder\nSource: "S" (podcast) https://example.com/s\nDate said: 2025-01-15 (monday';
    expect(promptDifference('Speaker: Dana Founder\nSource: "S" (podcast) https://example.com/s\nDate said: 2024-03-15 (x)', [rec])).toBe(
      'Date said: recorded "2025-01-15 (monday", this request "2024-03-15 (x)"',
    );
    expect(promptDifference('Speaker: Dana Founder\nHost: Sam\nSource: "S" (podcast) https://example.com/s\nDate said: 2025-01-15 (monday)', [rec])).toBe(
      'Host: recorded none, this request "Sam"',
    );
    expect(promptDifference('Speaker: Dana Founder\nSource: "S" (podcast) https://example.com/s\nDate said: 2025-01-15 (monday)\nnew text', [rec])).toContain('text after');
    expect(promptDifference('anything', [])).toBeNull();
  });

  test('a fixture that no longer matches the schema is reported', async () => {
    const req = request();
    const stale = { request: {}, response: { data: { answer: 42 }, citations: [], model: 'gpt-5' } };
    writeFileSync(join(dir, fixtureFileName(req)), JSON.stringify(stale));
    await expect(new ReplayLLM(dir).json(req)).rejects.toThrow('no longer matches the ask_answer schema');
  });

  test('a hand-written fixture without citations still replays', async () => {
    const req = request();
    writeFileSync(join(dir, fixtureFileName(req)), JSON.stringify({ response: { data: { answer: 'yes' }, model: 'gpt-5' } }));
    expect(await new ReplayLLM(dir).json(req)).toEqual({ data: { answer: 'yes' }, citations: [], model: 'replay:gpt-5' });
  });
});
