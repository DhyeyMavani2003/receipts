// In-memory LLM for tests. The handler returns the model's data; it is
// validated against the request schema like a real reply would be, and every
// request is kept in `calls` for assertions.

import type { Citation, JsonRequest, JsonResponse, LLM } from './provider.ts';

export type MockHandler = (req: JsonRequest<unknown>) => unknown | Promise<unknown>;

export interface MockOptions {
  model?: string;
  citations?: (req: JsonRequest<unknown>) => Citation[];
  searched?: (req: JsonRequest<unknown>) => Citation[];
}

export class MockLLM implements LLM {
  readonly name = 'mock';
  readonly calls: JsonRequest<unknown>[] = [];

  constructor(
    private readonly handler: MockHandler,
    private readonly opts: MockOptions = {},
  ) {}

  async json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>> {
    const generic = req as JsonRequest<unknown>;
    this.calls.push(generic);
    const data = req.schema.parse(await this.handler(generic));
    return {
      data,
      citations: this.opts.citations?.(generic) ?? [],
      ...(this.opts.searched ? { searched: this.opts.searched(generic) } : {}),
      model: this.opts.model ?? 'mock',
    };
  }
}
