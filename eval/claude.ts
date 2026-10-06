// Dev-only: the eval's one door to a model. Local `claude -p`, fixed model, no tools, empty cwd.
// Never reads an API key from anywhere but TYPESAFE_API_KEY (used only to redact it from prompts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactText } from '../src/redact.js';
import { estimateTokens } from '../src/state.js';

/** User decision: one model for writing, answering and judging. */
export const EVAL_MODEL = 'sonnet';
export const EVAL_ARGV = ['-p', '--model', EVAL_MODEL, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'project,local', '--output-format', 'json'];
/** T2 spike (spikes/cp/overhead.json): a tiny prompt used 2906 input tokens; the window is 200000. */
export const EVAL_OVERHEAD = 2906;
export const EVAL_CAP = 200_000 - EVAL_OVERHEAD;

export type SpawnFn = (argv: string[], opts: { cwd: string; input: string }) => { status: number | null; stdout: string };
export interface Stats {
  /** Prompts refused for being over the cap. */
  refusals: number;
  /** Resolved model id of every call, in order. */
  models: string[];
}
export const makeStats = (): Stats => ({ refusals: 0, models: [] });

const realSpawn: SpawnFn = (argv, { cwd, input }) => {
  const r = spawnSync('claude', argv, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/** Redacts, refuses over the cap (null, counted), else asks. Returns the reply and the model id `claude -p` resolved (T2: keys of result.modelUsage). */
export function ask(prompt: string, stats: Stats, spawn: SpawnFn = realSpawn): { text: string; model: string } | null {
  const input = redactText(prompt, process.env.TYPESAFE_API_KEY);
  if (estimateTokens(input) > EVAL_CAP) {
    stats.refusals++;
    return null;
  }
  const cwd = mkdtempSync(join(tmpdir(), 'fjev-claude-'));
  try {
    const r = spawn(EVAL_ARGV, { cwd, input });
    if (r.status !== 0) throw new Error(`claude exit ${r.status}`);
    const out = JSON.parse(r.stdout) as { result?: unknown; modelUsage?: Record<string, unknown> };
    const model = Object.keys(out.modelUsage ?? {})[0];
    if (!model) throw new Error('claude result has no model id (modelUsage)');
    stats.models.push(model);
    return { text: typeof out.result === 'string' ? out.result : '', model };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
