// Key redaction must catch key-shaped strings but leave ordinary words and
// URLs alone: "elon-musk-says" contains "sk-", and a recorded grading fixture
// whose evidence URL got "redacted" would ship a broken link.

import { describe, expect, test } from 'bun:test';

import { redactSecrets } from '../src/llm/openai.ts';
import { buildFixture, serializeFixture } from '../src/llm/replay.ts';
import { z } from 'zod';

const URL_WITH_SK = 'https://techcrunch.com/2019/04/22/elon-musk-says-tesla-will-have-one-million-robotaxis-next-year/';
const FAKE_KEY = 'sk-proj-AbCdEfGh0123456789IjKlMnOpQrStUv';

describe('fixture redaction', () => {
  const fixtureText = (data: unknown, user = 'prompt') =>
    serializeFixture(buildFixture({ schemaName: 's', schema: z.unknown(), system: 'sys', user }, { data, citations: [], model: 'm' }));

  test('evidence URLs and slugs survive recording', () => {
    const text = fixtureText({ evidence: [{ url: URL_WITH_SK }, { url: 'https://example.com/sk-hynix-quarterly-results-record' }] });
    expect(text).toContain(URL_WITH_SK);
    expect(text).toContain('sk-hynix-quarterly-results-record');
  });

  test('a pasted key is still redacted', () => {
    const text = fixtureText({ note: `key ${FAKE_KEY} here` }, `user pasted ${FAKE_KEY}`);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('sk-REDACTED');
  });
});

describe('error redaction', () => {
  test('keys are scrubbed, words that merely contain "sk-" are not', () => {
    expect(redactSecrets(`bad key ${FAKE_KEY}`)).toBe('bad key sk-***');
    expect(redactSecrets(`see ${URL_WITH_SK}`)).toBe(`see ${URL_WITH_SK}`);
  });
});
