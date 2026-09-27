// The one interface every model call goes through. Implementations:
//   openai.ts  - OpenAI Responses API (structured outputs + web_search tool)
//   replay.ts  - offline: answers from fixtures/llm/<key>.json, optional recording
//   mock.ts    - tests: answers from an in-memory function
// getLLM() in ./index.ts picks one from env (RECEIPTS_LLM, RECEIPTS_RECORD).

import type { z } from 'zod';

export interface Citation {
  url: string;
  title?: string;
}

export interface JsonRequest<T> {
  /** Stable name for the output schema, e.g. "extract_claims". Used in the OpenAI format name and fixture keys. */
  schemaName: string;
  schema: z.ZodType<T>;
  system: string;
  user: string;
  /** Allow the model to search the web (grader, ask). */
  webSearch?: boolean;
  /** Which role's model to use. 'grader' uses RECEIPTS_GRADER_MODEL when set. */
  role?: 'extractor' | 'grader' | 'general';
  /** Distinguishes otherwise-identical calls (e.g. judge "A" vs "B") in fixture keys. */
  variant?: string;
}

export interface JsonResponse<T> {
  data: T;
  citations: Citation[];   // url_citation annotations: pages the answer itself cites, deduped
  /**
   * Pages the web search read (web_search_call action.sources) that the answer
   * never cited. They can confirm a URL the model names as evidence came from
   * its own search, but they are not evidence on their own: a search reads
   * dozens of result pages, most of them unrelated.
   */
  searched?: Citation[];
  model: string;           // model id that answered ("replay:<id>" for fixtures)
}

export interface LLM {
  readonly name: string;   // "openai" | "replay" | "mock"
  json<T>(req: JsonRequest<T>): Promise<JsonResponse<T>>;
}

export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}
