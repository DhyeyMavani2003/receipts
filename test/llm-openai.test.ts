import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FALLBACK_MODEL,
  OpenAIError,
  OpenAILLM,
  backoffMs,
  listModels,
  parseResponsesOutput,
  pickModel,
} from '../src/llm/openai.ts';
import type { FetchLike, OpenAIOptions } from '../src/llm/openai.ts';
import { LLMUnavailableError } from '../src/llm/provider.ts';
import type { JsonRequest } from '../src/llm/provider.ts';

const FAKE_KEY = 'sk-test-FAKEFAKEFAKEFAKEFAKE1234';

const gradeSchema = z.object({
  verdict: z.enum(['correct', 'incorrect']),
  confidence: z.number(),
  resolvedOn: z.string().nullable(),
});
type Grade = z.infer<typeof gradeSchema>;
const GOOD = { verdict: 'correct', confidence: 0.8, resolvedOn: '2020-05-30' };

function request(overrides: Partial<JsonRequest<Grade>> = {}): JsonRequest<Grade> {
  return { schemaName: 'grade_claim', schema: gradeSchema, system: 'You grade claims.', user: 'Claim: X by 2020.', ...overrides };
}

interface Cite {
  url: string;
  title: string;
}

// Shape of a real Responses API body: reasoning, optional web searches, then the message.
function responsesBody(text: string, opts: { citations?: Cite[]; webSearch?: boolean; sources?: string[]; model?: string } = {}) {
  const annotations = (opts.citations ?? []).map((c, i) => ({
    type: 'url_citation',
    url: c.url,
    title: c.title,
    start_index: i * 10,
    end_index: i * 10 + 9,
  }));
  return {
    id: 'resp_123',
    object: 'response',
    created_at: 1759000000,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: opts.model ?? 'gpt-5-2025-08-07',
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [] },
      ...(opts.webSearch
        ? [
            {
              id: 'ws_1',
              type: 'web_search_call',
              status: 'completed',
              action: { type: 'search', query: 'claim outcome', sources: (opts.sources ?? []).map((url) => ({ type: 'url', url })) },
            },
          ]
        : []),
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations, logprobs: [] }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function apiError(status: number, message: string, code: string | null = null): Response {
  return json({ error: { message, type: 'invalid_request_error', param: null, code } }, status);
}

type Reply = () => Response | Promise<Response>;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: any;
}

// Stands in for api.openai.com: serves /models and replays queued /responses replies in order.
class FakeOpenAI {
  readonly requests: Recorded[] = [];
  readonly sleeps: number[] = [];
  constructor(
    private readonly responses: Reply[],
    private readonly models: Reply = () => json({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }] }),
  ) {}

  fetch: FetchLike = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    if (url.endsWith('/models')) return this.models();
    const next = this.responses.shift();
    if (!next) throw new Error('FakeOpenAI: unexpected /responses call');
    return next();
  };

  get responseCalls(): Recorded[] {
    return this.requests.filter((r) => r.url.endsWith('/responses'));
  }

  get modelCalls(): Recorded[] {
    return this.requests.filter((r) => r.url.endsWith('/models'));
  }

  client(opts: Partial<OpenAIOptions> = {}): OpenAILLM {
    return new OpenAILLM({
      apiKey: FAKE_KEY,
      fetch: this.fetch,
      sleep: async (ms) => void this.sleeps.push(ms),
      ...opts,
    });
  }
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('OpenAILLM.json', () => {
  test('sends a strict json_schema request and returns validated data', async () => {
    const api = new FakeOpenAI([() => json(responsesBody(JSON.stringify(GOOD)))]);
    const res = await api.client({ model: 'gpt-5' }).json(request());

    expect(res).toEqual({ data: GOOD as Grade, citations: [], model: 'gpt-5-2025-08-07' });
    const [call] = api.responseCalls;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.body.model).toBe('gpt-5');
    expect(call.body.input).toEqual([
      { role: 'system', content: 'You grade claims.' },
      { role: 'user', content: 'Claim: X by 2020.' },
    ]);
    const format = call.body.text.format;
    expect(format).toMatchObject({ type: 'json_schema', name: 'grade_claim', strict: true });
    expect(format.schema.additionalProperties).toBe(false);
    expect(format.schema.required).toEqual(['verdict', 'confidence', 'resolvedOn']);
  });

  test('never sends temperature, and sends tools only for web search', async () => {
    const api = new FakeOpenAI([() => json(responsesBody(JSON.stringify(GOOD))), () => json(responsesBody(JSON.stringify(GOOD)))]);
    const llm = api.client({ model: 'gpt-5' });
    await llm.json(request());
    await llm.json(request({ webSearch: true }));

    const [plain, searching] = api.responseCalls.map((c) => c.body);
    for (const body of [plain, searching]) expect(body).not.toHaveProperty('temperature');
    expect(plain).not.toHaveProperty('tools');
    expect(plain).not.toHaveProperty('include');
    expect(searching.tools).toEqual([{ type: 'web_search' }]);
    expect(searching.include).toEqual(['web_search_call.action.sources']);
  });

  test('pages the search only read come back as searched, apart from the cited ones', async () => {
    const body = responsesBody(JSON.stringify(GOOD), {
      webSearch: true,
      citations: [{ url: 'https://example.com/a', title: 'A' }],
      sources: ['https://example.com/read-only', 'https://example.com/a'],
    });
    const res = await new FakeOpenAI([() => json(body)]).client({ model: 'gpt-5' }).json(request({ webSearch: true }));
    expect(res.citations).toEqual([{ url: 'https://example.com/a', title: 'A' }]);
    expect(res.searched).toEqual([{ url: 'https://example.com/read-only' }]);
  });

  test('an account that rejects the sources include is retried without it, once per client', async () => {
    const api = new FakeOpenAI([
      () => apiError(400, "Invalid value: 'web_search_call.action.sources'. Supported values for include are: ...", null),
      () => json(responsesBody(JSON.stringify(GOOD))),
      () => json(responsesBody(JSON.stringify(GOOD))),
    ]);
    const llm = api.client({ model: 'gpt-5' });
    expect((await llm.json(request({ webSearch: true }))).data).toEqual(GOOD as Grade);
    await llm.json(request({ webSearch: true }));
    expect(api.responseCalls.map((c) => 'include' in c.body)).toEqual([true, false, false]);
  });

  test('other 400s are not retried without the include', async () => {
    const api = new FakeOpenAI([() => apiError(400, 'Bad schema')]);
    const err = await errorOf(api.client({ model: 'gpt-5' }).json(request({ webSearch: true })));
    expect(err.message).toContain('Bad schema');
    expect(api.responseCalls).toHaveLength(1);
  });

  test('collects url_citation annotations after web_search_call items, deduped by url', async () => {
    const citations = [
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'B' },
      { url: 'https://example.com/a', title: 'A again' },
    ];
    const api = new FakeOpenAI([() => json(responsesBody(JSON.stringify(GOOD), { citations, webSearch: true }))]);
    const res = await api.client({ model: 'gpt-5' }).json(request({ webSearch: true }));
    expect(res.citations).toEqual([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'B' },
    ]);
  });

  test('retries once with the validation error appended, then succeeds', async () => {
    const api = new FakeOpenAI([
      () => json(responsesBody(JSON.stringify({ verdict: 'maybe', confidence: 0.5 }))),
      () => json(responsesBody(JSON.stringify(GOOD))),
    ]);
    const res = await api.client({ model: 'gpt-5' }).json(request());

    expect(res.data).toEqual(GOOD as Grade);
    expect(api.responseCalls).toHaveLength(2);
    const retryUser = api.responseCalls[1].body.input[1].content as string;
    expect(retryUser.startsWith('Claim: X by 2020.')).toBe(true);
    expect(retryUser).toContain('did not match the required JSON schema');
    expect(retryUser).toContain('verdict');
    expect(retryUser).toContain('resolvedOn');
  });

  test('retries non-JSON text too, and gives up after the second bad reply', async () => {
    const api = new FakeOpenAI([() => json(responsesBody('Sure! Here is the JSON')), () => json(responsesBody('{"verdict":1}'))]);
    const err = await errorOf(api.client({ model: 'gpt-5' }).json(request()));
    expect(err).toBeInstanceOf(OpenAIError);
    expect(err.message).toContain('grade_claim: model output failed validation twice');
    expect(api.responseCalls[1].body.input[1].content).toContain('not valid JSON');
  });

  test('backs off and retries on 429, honoring Retry-After', async () => {
    const api = new FakeOpenAI([
      () => apiError(429, 'Rate limit reached', 'rate_limit_exceeded'),
      () => json(responsesBody(JSON.stringify(GOOD))),
    ]);
    const first = api.client({ model: 'gpt-5', retryDelayMs: 1000 });
    const res = await first.json(request());
    expect(res.data).toEqual(GOOD as Grade);
    expect(api.responseCalls).toHaveLength(2);
    expect(api.sleeps).toEqual([1000]);

    const withHeader = new FakeOpenAI([
      () => json({ error: { message: 'slow down' } }, 429, { 'retry-after': '2' }),
      () => json(responsesBody(JSON.stringify(GOOD))),
    ]);
    await withHeader.client({ model: 'gpt-5' }).json(request());
    expect(withHeader.sleeps).toEqual([2000]);
  });

  test('retries network errors and 5xx, then reports the model unavailable after 3 attempts', async () => {
    const flaky = new FakeOpenAI([
      () => Promise.reject(new TypeError('fetch failed')),
      () => apiError(503, 'overloaded'),
      () => json(responsesBody(JSON.stringify(GOOD))),
    ]);
    expect((await flaky.client({ model: 'gpt-5', retryDelayMs: 10 }).json(request())).data).toEqual(GOOD as Grade);
    expect(flaky.sleeps).toEqual([10, 20]);

    const down = new FakeOpenAI([() => apiError(500, 'boom'), () => apiError(502, 'boom'), () => apiError(500, 'boom')]);
    const err = await errorOf(down.client({ model: 'gpt-5' }).json(request()));
    expect(err).toBeInstanceOf(LLMUnavailableError);
    expect(err.message).toContain('after 3 attempts');
    expect(down.responseCalls).toHaveLength(3);
  });

  test('aborts a hung call after the timeout', async () => {
    const hang: Reply = () => new Promise<Response>(() => {});
    const api = new FakeOpenAI([hang, hang]);
    // The fake ignores the signal, so the timeout has to win the race itself.
    const abortable: FetchLike = (url, init) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        api.fetch(url, init).then(resolve, reject);
      });
    const err = await errorOf(api.client({ model: 'gpt-5', fetch: abortable, timeoutMs: 5, maxAttempts: 2 }).json(request()));
    expect(err.message).toContain('timed out after 5ms');
    expect(api.responseCalls).toHaveLength(2);
  });

  test('401 says the key was rejected, without echoing it and without retrying', async () => {
    const api = new FakeOpenAI([() => apiError(401, `Incorrect API key provided: ${FAKE_KEY}.`, 'invalid_api_key')]);
    const err = await errorOf(api.client({ model: 'gpt-5' }).json(request()));
    expect(err).toBeInstanceOf(LLMUnavailableError);
    expect(err.message).toContain('OPENAI_API_KEY rejected');
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain('FAKEFAKE');
    expect(api.responseCalls).toHaveLength(1);
  });

  test('unknown model tells the user to set RECEIPTS_MODEL', async () => {
    const api = new FakeOpenAI([() => apiError(404, "The model 'gpt-9' does not exist", 'model_not_found')]);
    const err = await errorOf(api.client({ model: 'gpt-9' }).json(request()));
    expect(err.message).toContain('"gpt-9"');
    expect(err.message).toContain('set RECEIPTS_MODEL');
  });

  test('other 4xx errors pass the API message through with keys redacted', async () => {
    const api = new FakeOpenAI([() => apiError(400, `Bad schema (key ${FAKE_KEY})`)]);
    const err = await errorOf(api.client({ model: 'gpt-5' }).json(request()));
    expect(err).toBeInstanceOf(OpenAIError);
    expect((err as OpenAIError).status).toBe(400);
    expect(err.message).toContain('Bad schema');
    expect(err.message).not.toContain('FAKEFAKE');
  });
});

describe('model resolution', () => {
  const modelList = (ids: string[]) => () => json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

  test('picks the first preferred model the account lists, fetching the list once', async () => {
    const replies = [() => json(responsesBody(JSON.stringify(GOOD))), () => json(responsesBody(JSON.stringify(GOOD)))];
    const api = new FakeOpenAI(replies, modelList(['gpt-4.1', 'gpt-5', 'gpt-5.1', 'dall-e-3']));
    const llm = api.client();
    await llm.json(request());
    await llm.json(request({ role: 'grader' }));
    expect(api.responseCalls.map((c) => c.body.model)).toEqual(['gpt-5.1', 'gpt-5.1']);
    expect(api.modelCalls).toHaveLength(1);
    expect(api.modelCalls[0].headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
  });

  test('pinned models skip the list; the grader model applies to role grader only', async () => {
    const api = new FakeOpenAI([]);
    const llm = api.client({ model: 'gpt-5-mini', graderModel: 'gpt-5.2' });
    expect(await llm.resolveModel('extractor')).toBe('gpt-5-mini');
    expect(await llm.resolveModel('grader')).toBe('gpt-5.2');
    expect(await llm.resolveModel()).toBe('gpt-5-mini');
    expect(await api.client({ model: 'gpt-5-mini' }).resolveModel('grader')).toBe('gpt-5-mini');
    expect(api.modelCalls).toHaveLength(0);
  });

  test(`falls back to ${FALLBACK_MODEL} after retrying a failing list call, and asks again next time`, async () => {
    const listReplies = [() => apiError(500, 'nope'), () => apiError(503, 'busy'), () => apiError(500, 'nope')];
    const api = new FakeOpenAI([], () => (listReplies.shift() ?? modelList(['gpt-5.2']))());
    const llm = api.client();
    expect(await llm.resolveModel()).toBe(FALLBACK_MODEL);
    expect(api.modelCalls).toHaveLength(3);
    expect(api.sleeps).toHaveLength(2);
    expect(await llm.resolveModel('grader')).toBe('gpt-5.2');
    expect(await llm.resolveModel()).toBe('gpt-5.2');
    expect(api.modelCalls).toHaveLength(4);
  });

  test('pickModel prefers newer models and falls back when none match', () => {
    expect(pickModel(['gpt-4.1', 'gpt-5.5', 'gpt-5.2'])).toBe('gpt-5.5');
    expect(pickModel(['gpt-4.1', 'gpt-4o'])).toBe('gpt-4.1');
    expect(pickModel(['whisper-1'])).toBe(FALLBACK_MODEL);
  });

  test('listModels returns ids and maps 401 to a key error', async () => {
    const api = new FakeOpenAI([], modelList(['gpt-5', 'gpt-4.1']));
    expect(await listModels(FAKE_KEY, { fetch: api.fetch })).toEqual(['gpt-5', 'gpt-4.1']);

    const rejected = new FakeOpenAI([], () => apiError(401, `Incorrect API key provided: ${FAKE_KEY}`));
    const err = await errorOf(listModels(FAKE_KEY, { fetch: rejected.fetch }));
    expect(err.message).toContain('OPENAI_API_KEY rejected');
    expect(err.message).not.toContain('FAKEFAKE');
  });
});

describe('parseResponsesOutput', () => {
  test('falls back to a top-level output_text', () => {
    const body = { status: 'completed', model: 'gpt-5', output: [{ type: 'reasoning', summary: [] }], output_text: '{"a":1}' };
    expect(parseResponsesOutput(body)).toEqual({ text: '{"a":1}', citations: [], searched: [], model: 'gpt-5' });
  });

  test('uses the last message when several are present', () => {
    const body = responsesBody('{"final":true}');
    body.output.splice(1, 0, {
      id: 'msg_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Searching...', annotations: [], logprobs: [] }],
    });
    expect(parseResponsesOutput(body).text).toBe('{"final":true}');
  });

  test('reports refusals, incomplete responses and empty output', () => {
    const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] };
    expect(() => parseResponsesOutput(refusal)).toThrow('Model refused: No.');
    const incomplete = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
    expect(() => parseResponsesOutput(incomplete)).toThrow('incomplete (max_output_tokens)');
    expect(() => parseResponsesOutput({ status: 'completed', output: [] })).toThrow('no output_text');
  });
});

test('backoffMs doubles per attempt, prefers Retry-After, and is capped', () => {
  expect([1, 2, 3].map((a) => backoffMs(a, 500))).toEqual([500, 1000, 2000]);
  expect(backoffMs(1, 500, '3')).toBe(3000);
  expect(backoffMs(1, 500, 'soon')).toBe(500);
  expect(backoffMs(1, 500, '3600')).toBe(30_000);
});
