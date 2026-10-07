// Dev-only: the eval's one door to a model. Local `claude -p`, fixed model, no tools, empty cwd.
// Never reads an API key from anywhere but TYPESAFE_API_KEY (used only to redact it from prompts).
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactText } from '../src/redact.js';
import { estimateTokens } from '../src/state.js';

/** User decision: one model for writing, answering and judging. Pinned by full id, never an alias; ask() throws on any other resolved id. */
export const EVAL_MODEL = 'claude-sonnet-5-5';
export const EVAL_ARGV = ['-p', '--model', EVAL_MODEL, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'project,local', '--output-format', 'json'];
/** T2 spike (spikes/cp/overhead.json): a tiny prompt used 2906 input tokens; the window is 200000. */
export const EVAL_OVERHEAD = 2906;
export const EVAL_CAP = 200_000 - EVAL_OVERHEAD;

export interface SpawnResult { status: number | null; stdout: string }
/** May be sync or async; ask() awaits it. The real one is async so many calls can run at once. */
export type SpawnFn = (argv: string[], opts: { cwd: string; input: string }) => SpawnResult | Promise<SpawnResult>;
export interface Stats {
  /** Prompts refused for being over the cap. */
  refusals: number;
  /** Resolved model id of every call, in order. */
  models: string[];
}
export const makeStats = (): Stats => ({ refusals: 0, models: [] });

const MAX_STDOUT = 64 * 1024 * 1024;
const realSpawn: SpawnFn = (argv, { cwd, input }) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn('claude', argv, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_STDOUT) child.kill();
      else chunks.push(b);
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: size > MAX_STDOUT ? null : status, stdout: Buffer.concat(chunks).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

/** Redacts, refuses over the cap (null, counted), else asks; throws unless the resolved model is EVAL_MODEL. Returns the reply and the model id `claude -p` resolved (T2: keys of result.modelUsage). */
export async function ask(prompt: string, stats: Stats, spawn: SpawnFn = realSpawn): Promise<{ text: string; model: string } | null> {
  const input = redactText(prompt, process.env.TYPESAFE_API_KEY);
  if (estimateTokens(input) > EVAL_CAP) {
    stats.refusals++;
    return null;
  }
  const cwd = mkdtempSync(join(tmpdir(), 'fjev-claude-'));
  try {
    const r = await spawn(EVAL_ARGV, { cwd, input });
    if (r.status !== 0) throw new Error(`claude exit ${r.status}`);
    const out = JSON.parse(r.stdout) as { result?: unknown; modelUsage?: Record<string, unknown> };
    const model = Object.keys(out.modelUsage ?? {})[0];
    if (!model) throw new Error('claude result has no model id (modelUsage)');
    if (model !== EVAL_MODEL) throw new Error(`claude resolved model ${model}, not ${EVAL_MODEL}`);
    stats.models.push(model);
    return { text: typeof out.result === 'string' ? out.result : '', model };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
