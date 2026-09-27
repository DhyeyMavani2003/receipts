// Readers for the GBrain skill pack (skillpack.json, skills/*/SKILL.md,
// routing-eval.jsonl, evals/*.judge.json) shared by the skillpack tests.
// Routing normalization mirrors gbrain's src/core/routing-eval.ts so the
// structural checks here agree with `gbrain routing-eval`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PACK_ROOT = join(import.meta.dir, '..');

export interface SkillpackManifest {
  api_version: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  homepage: string;
  gbrain_min_version: string;
  skills: string[];
  unit_tests?: string[];
  e2e_tests?: string[];
  llm_evals?: string[];
  routing_evals?: string[];
  runbooks?: { bootstrap?: string };
  changelog?: string;
}

export interface SkillFrontmatter {
  name: string;
  version?: string;
  description: string;
  mutating: boolean;
  triggers: string[];
  [key: string]: unknown;
}

export interface SkillDoc {
  path: string;            // "skills/receipts-ingest"
  slug: string;            // "receipts-ingest"
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface RoutingFixture {
  intent: string;
  expected_skill: string | null;
  ambiguous_with?: string[];
}

export interface HedgeRow {
  p: number;
  phrases: string;         // the table cell exactly as written
}

export interface JudgeCase {
  name: string;
  criteria: string;
  skill?: string;
  input?: string;
}

export interface JudgeEval {
  task: string;
  output: string;
  cases: JudgeCase[];
}

export function readPackFile(relPath: string): string {
  return readFileSync(join(PACK_ROOT, relPath), 'utf-8');
}

export function packFileExists(relPath: string): boolean {
  return existsSync(join(PACK_ROOT, relPath));
}

export function readManifest(): SkillpackManifest {
  return JSON.parse(readPackFile('skillpack.json')) as SkillpackManifest;
}

export function splitFrontmatter(markdown: string): { yaml: string; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('markdown has no leading --- frontmatter block');
  return { yaml: match[1] ?? '', body: match[2] ?? '' };
}

export function loadSkill(skillPath: string): SkillDoc {
  const { yaml, body } = splitFrontmatter(readPackFile(join(skillPath, 'SKILL.md')));
  const frontmatter = Bun.YAML.parse(yaml) as SkillFrontmatter;
  const slug = skillPath.split('/').pop() ?? skillPath;
  return { path: skillPath, slug, frontmatter, body };
}

export function loadSkills(): SkillDoc[] {
  return readManifest().skills.map(loadSkill);
}

/** Parse routing-eval.jsonl: one JSON object per non-empty line; `//` and `#` lines are comments. */
export function parseFixtures(jsonl: string): RoutingFixture[] {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as RoutingFixture);
}

export function loadFixtures(skillPath: string): RoutingFixture[] {
  return parseFixtures(readPackFile(join(skillPath, 'routing-eval.jsonl')));
}

/** gbrain's routing normalization: lowercase, non letters/marks/digits → space, collapse. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** Skills whose normalized trigger is a substring of the normalized intent. */
export function matchingSkills(intent: string, skills: SkillDoc[]): string[] {
  const normalized = normalizeText(intent);
  return skills
    .filter((s) => s.frontmatter.triggers.some((t) => {
      const phrase = normalizeText(t);
      return phrase.length >= 3 && normalized.includes(phrase);
    }))
    .map((s) => s.slug);
}

/** The body's markdown section that starts with `## <title>` (up to the next `## `). */
export function section(body: string, title: string): string {
  const start = body.indexOf(`\n## ${title}`);
  if (start === -1) return '';
  const rest = body.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Rows of the `| p | hedge phrases |` table in the hedge section. */
export function parseHedgeTable(body: string): HedgeRow[] {
  return section(body, 'Hedge → probability table')
    .split('\n')
    .map((line) => line.match(/^\|\s*(0\.\d+)\s*\|\s*(.+?)\s*\|$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ p: Number(m[1]), phrases: m[2] ?? '' }));
}

/** Shell lines inside ```bash fences, with `\` continuations joined. */
export function bashCommands(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  return blocks.flatMap((block) =>
    block
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

/** Commands for `tool` found in bash fences and in inline code spans. */
export function commandsFor(markdown: string, tool: 'receipts' | 'gbrain'): string[] {
  const inline = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? '');
  const prefix = `${tool} `;
  return [...bashCommands(markdown), ...inline]
    .flatMap((cmd) => cmd.split(/\s+\|\s+/)) // shell pipes only, not <a|b> placeholders
    .map((cmd) => cmd.replace(/^cat <<'EOF'\s*/, '').trim())
    .filter((cmd) => cmd.startsWith(prefix));
}

/** `--flag` names used in a command line. */
export function flagsOf(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1] ?? '');
}

export function loadJudgeEvals(): { path: string; data: JudgeEval }[] {
  const globs = readManifest().llm_evals ?? [];
  return globs.flatMap((pattern) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: PACK_ROOT })].sort().map((path) => ({
      path,
      data: JSON.parse(readPackFile(path)) as JudgeEval,
    })),
  );
}

export function globCount(patterns: string[]): number {
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const path of new Bun.Glob(pattern).scanSync({ cwd: PACK_ROOT })) {
      if (!path.includes('node_modules')) found.add(path);
    }
  }
  return found.size;
}
