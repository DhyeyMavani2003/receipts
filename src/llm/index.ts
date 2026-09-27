// getLLM(): pick the model client for a run from config (RECEIPTS_LLM,
// RECEIPTS_RECORD, OPENAI_API_KEY, RECEIPTS_MODEL, RECEIPTS_GRADER_MODEL).

import type { Config } from '../config.ts';
import { OpenAILLM } from './openai.ts';
import type { OpenAIOptions } from './openai.ts';
import { LLMUnavailableError } from './provider.ts';
import type { LLM } from './provider.ts';
import { RecordingLLM, ReplayLLM } from './replay.ts';

export * from './provider.ts';
export { MockLLM } from './mock.ts';
export { OpenAILLM, OpenAIError, listModels, pickModel, MODEL_PREFERENCE, FALLBACK_MODEL } from './openai.ts';
export { ReplayLLM, RecordingLLM, fixtureKey, fixtureFileName } from './replay.ts';
export { toOpenAISchema } from './schema.ts';

export type LLMConfig = Pick<Config, 'llmMode' | 'record' | 'fixturesDir' | 'openaiKey' | 'model' | 'graderModel'>;

/**
 * replay → fixtures only (record is ignored); openai → live client, wrapped
 * in a recorder when `record` is set. `openai` lets tests inject fetch.
 */
export function getLLM(cfg: LLMConfig, openai: Omit<OpenAIOptions, 'apiKey' | 'model' | 'graderModel'> = {}): LLM {
  if (cfg.llmMode === 'replay') return new ReplayLLM(cfg.fixturesDir);
  if (!cfg.openaiKey) {
    throw new LLMUnavailableError('OPENAI_API_KEY missing: add it to .env, or run offline with --offline (RECEIPTS_LLM=replay)');
  }
  const live = new OpenAILLM({ ...openai, apiKey: cfg.openaiKey, model: cfg.model, graderModel: cfg.graderModel });
  return cfg.record ? new RecordingLLM(live, cfg.fixturesDir) : live;
}
