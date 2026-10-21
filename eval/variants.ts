// Dev-only: measures the opt-in Jev variants against the plugin as it ships, on your own transcripts, before any of
// them is turned on by default. Per case, the full hook pipeline (compactSession) runs once per arm:
//   base     the defaults
//   wording  stateWording 'archive' (Jev is told dropped output is archived and the history is data)
//   checks   resultChecks (four concrete checks per result instead of one keep question)
// and, where the base cut falls short of the minimum (where the hook runs a hybrid), two hybrid arms that differ only
// in what the summarizer reads:
//   hybrid   the trimmed older history (as shipped)      hybrid-orig  the original older history (hybridOriginals)
// Each arm's output is scored on the case's cached fact questions (bench.ts generates them) with claude -p.
// `npx tsx eval/variants.ts [--cases N=8] [--concurrency K=4] [--per-transcript K=5] [--arms base,wording,checks,hybrid]`
// Needs TYPESAFE_API_KEY and the manifest `bench.ts` uses; output files hold ids and numbers, never transcript text.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveWriter,
  compactSession,
  hybridSplit,
  messageTokens,
  originalIndex,
  resolveHookConfig,
  type HookFetch,
} from '../hooks/fast-jev.js';
import { messageChars } from '../src/compact.js';
import type { Message } from '../src/types.js';
import {
  EVAL_DIR,
  hookFetch,
  liveDeps,
  limiter,
  mapLimit,
  orderForSelection,
  questionsFor,
  renderMessages,
  scoreArm,
  transcriptOf,
  type Deps,
} from './bench.js';
import { ask, makeStats } from './claude.js';
import { loadQuestions } from './questions.js';

export const VARIANTS = {
  base: {},
  wording: { stateWording: 'archive' },
  checks: { resultChecks: true },
} as const satisfies Record<string, Record<string, unknown>>;
type Variant = keyof typeof VARIANTS;
const ARMS = ['base', 'wording', 'checks', 'hybrid'] as const;
type ArmName = (typeof ARMS)[number];
/** The pipeline the hybrid arms start from: the defaults less the two stages that archive until the minimum. */
const HYBRID_BASE = { stepTrim: false, exchangeDrop: false };
/** The hook's default minimum; below it the hook falls back, possibly to a hybrid. */
const MIN_REDUCTION = 0.25;
/** The kept recent share the hook uses for a hybrid (HYBRID_RECENT_SHARE). */
const HYBRID_SHARE = 0.3;

export type VariantDeps = Pick<Deps, 'outDir' | 'cacheDir' | 'cases' | 'messages' | 'spawn' | 'confirm' | 'print'> & {
  fetch: HookFetch;
  apiKey(): string;
  /** TypeSafe's endpoint unless set (TYPESAFE_BASE_URL), as in the hook. */
  baseUrl?: string;
};

export interface ArmResult {
  reduction: number;
  requests: number;
  pass: number;
}
export interface VariantRow {
  id: string;
  questions: number;
  arms: Partial<Record<Variant | 'hybrid' | 'hybrid-orig', ArmResult>>;
}

/** An archive writer that names paths like the hook's but writes nothing. */
const noWriteArchive = () => archiveWriter({ fs: { exists: async () => true, write: async () => {}, read: async () => '' } });

const charsOf = (messages: readonly Message[]) => messages.reduce((sum, m) => sum + messageChars(m), 0);

/** One arm: the hook's own pipeline with `options`, against `messages`. */
export async function runVariant(messages: Message[], options: Record<string, unknown>, deps: Pick<VariantDeps, 'fetch' | 'apiKey' | 'baseUrl'>) {
  const config = { ...resolveHookConfig({ ...options } as Parameters<typeof resolveHookConfig>[0]), apiKey: deps.apiKey() };
  // Library messages are what the engine hands the hook, less the handles a transcript file does not keep.
  const out = await compactSession(messages as never, config, deps.fetch, noWriteArchive(), deps.baseUrl ? { baseUrl: deps.baseUrl } : {});
  const before = charsOf(messages);
  return {
    messages: out.messages as Message[],
    reduction: before === 0 ? 0 : 1 - charsOf(out.messages as Message[]) / before,
    requests: out.result.stats.requests,
  };
}

export const SUMMARY_PROMPT =
  'Summarize the conversation below so the assistant can continue the work from the summary alone. Keep every decision with its reason, file path, identifier, number, exact error message and open task.\n\nCONVERSATION\n';

const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function renderVariants(rows: readonly VariantRow[]): string {
  const total = (arm: keyof VariantRow['arms']) => {
    const scored = rows.filter((r) => r.arms[arm]);
    const questions = scored.reduce((s, r) => s + r.questions, 0);
    const pass = scored.reduce((s, r) => s + r.arms[arm]!.pass, 0);
    const reduction = scored.reduce((s, r) => s + r.arms[arm]!.reduction, 0) / (scored.length || NaN);
    const requests = scored.reduce((s, r) => s + r.arms[arm]!.requests, 0);
    return { cases: scored.length, questions, recall: questions ? pass / questions : NaN, reduction, requests };
  };
  const base = total('base');
  const verdict = (arm: Variant) => {
    const t = total(arm);
    if (t.cases === 0) return 'not run';
    const recall = t.recall - base.recall;
    const reduction = t.reduction - base.reduction;
    const ok = recall >= 0 && reduction >= -0.02;
    return `${ok ? 'turn on' : 'keep off'} (recall ${recall >= 0 ? '+' : ''}${(recall * 100).toFixed(1)} pts, reduction ${reduction >= 0 ? '+' : ''}${(reduction * 100).toFixed(1)} pts)`;
  };
  const h = total('hybrid');
  const ho = total('hybrid-orig');
  const lines = [
    '# Jev variants against the shipped defaults',
    '',
    '| arm | cases | questions | recall | mean reduction | Jev requests |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(['base', 'wording', 'checks', 'hybrid', 'hybrid-orig'] as const).map((arm) => {
      const t = total(arm);
      return `| ${arm} | ${t.cases} | ${t.questions} | ${pct(t.recall)} | ${pct(t.reduction)} | ${t.requests} |`;
    }),
    '',
    `- stateWording archive: ${verdict('wording')}`,
    `- resultChecks: ${verdict('checks')}`,
    `- hybridOriginals: ${
      h.cases === 0 ? 'not measured (no case fell short of the minimum, where a hybrid runs)' : `${ho.recall >= h.recall ? 'turn on' : 'keep off'} (recall ${pct(ho.recall)} vs ${pct(h.recall)} over ${h.cases} cases)`
    }`,
    '',
    'A variant is worth turning on when it keeps at least the base recall and gives up at most 2 points of reduction.',
    '',
  ];
  return lines.join('\n');
}

const USAGE = 'usage: variants.ts [--cases <N>] [--concurrency <K>] [--per-transcript <K>] [--arms <base,wording,checks,hybrid>]';

export async function main(argv: string[], deps: VariantDeps): Promise<number> {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const posInt = (name: string, fallback: number) => {
    const v = flag(name);
    return v === undefined ? fallback : /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  };
  const n = posInt('--cases', 8);
  const k = posInt('--concurrency', 4);
  const perTranscript = posInt('--per-transcript', 5);
  const asked = (flag('--arms') ?? ARMS.join(',')).split(',').map((a) => a.trim());
  if (Number.isNaN(n) || Number.isNaN(k) || Number.isNaN(perTranscript) || asked.some((a) => !(ARMS as readonly string[]).includes(a))) {
    deps.print(USAGE);
    return 2;
  }
  const arms = new Set<ArmName>(['base', ...(asked as ArmName[])]);
  try {
    deps.apiKey();
  } catch (e) {
    deps.print(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { cases: eligible } = deps.cases();
  const cached = (c: (typeof eligible)[number]) => (loadQuestions(deps.cacheDir, c.id)?.questions.length ?? 0) > 0;
  const taken = new Map<string, number>();
  const picked = orderForSelection(eligible, transcriptOf, cached)
    .filter((c) => {
      const t = transcriptOf(c);
      if ((taken.get(t) ?? 0) >= perTranscript) return false;
      taken.set(t, (taken.get(t) ?? 0) + 1);
      return true;
    })
    .slice(0, n);
  if (picked.length === 0) {
    deps.print('no case to run');
    return 1;
  }
  deps.print(
    `cases: ${picked.length} (cached questions ${picked.filter(cached).length}); arms: ${[...arms].join(', ')}; ` +
      `each arm is one compaction (Jev) and up to ~20 answer and ~10 judge claude -p calls per case; hybrid adds two summary calls`,
  );
  if (!(await deps.confirm(`Run these live Jev and claude -p calls on ${picked.length} cases?`))) return 1;
  const stats = makeStats();
  const gate = limiter(k * 4);
  const rows = (
    await mapLimit(picked, k, async (c): Promise<VariantRow | undefined> => {
      try {
        const messages = deps.messages(c);
        const qs = await questionsFor(c, deps as unknown as Deps, stats, gate);
        if (qs.length === 0) return undefined;
        const row: VariantRow = { id: c.id, questions: qs.length, arms: {} };
        const score = async (text: string) => (await scoreArm(text, qs, deps as unknown as Deps, stats, gate)).filter(Boolean).length;
        let base: Awaited<ReturnType<typeof runVariant>> | undefined;
        for (const variant of Object.keys(VARIANTS) as Variant[]) {
          if (!arms.has(variant)) continue;
          const out = await runVariant(messages, VARIANTS[variant], deps);
          if (variant === 'base') base = out;
          row.arms[variant] = { reduction: out.reduction, requests: out.requests, pass: await score(renderMessages(out.messages)) };
        }
        // As in the hook, a hybrid runs only where the cut falls short of the minimum. With the step and exchange
        // stages on (the defaults) the cut nearly always reaches it, so the hybrid is measured on the cut those two
        // stages leave out: where a hybrid does run (Jev failing late, or archiving off) the history looks like that.
        const short = arms.has('hybrid') ? await runVariant(messages, HYBRID_BASE, deps) : undefined;
        if (short && short.reduction < MIN_REDUCTION) {
          const split = hybridSplit(short.messages, messageTokens(messages), HYBRID_SHARE);
          const at = split > 0 ? originalIndex(messages as never, short.messages as never, split) : undefined;
          if (split > 0 && at !== undefined) {
            const recent = renderMessages(short.messages.slice(split));
            for (const [arm, older] of [
              ['hybrid', short.messages.slice(0, split)],
              ['hybrid-orig', messages.slice(0, at)],
            ] as const) {
              const summary = await gate(() => ask(SUMMARY_PROMPT + renderMessages(older), stats, deps.spawn));
              if (!summary) continue;
              const text = `${summary.text}\n\n${recent}`;
              row.arms[arm] = { reduction: 1 - text.length / (charsOf(messages) || 1), requests: 0, pass: await score(text) };
            }
          }
        }
        return row;
      } catch (e) {
        deps.print(`${c.id} failed: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
        return undefined;
      }
    })
  ).filter((r): r is VariantRow => r !== undefined);
  const dir = join(deps.outDir, 'variants');
  mkdirSync(dir, { recursive: true });
  const report = renderVariants(rows);
  writeFileSync(join(dir, 'report.md'), report);
  writeFileSync(join(dir, 'variants.json'), JSON.stringify({ rows, models: [...new Set(stats.models)] }, null, 2) + '\n');
  deps.print(report);
  return rows.length > 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const live = liveDeps();
  process.exitCode = await main(process.argv.slice(2), {
    ...live,
    outDir: join(EVAL_DIR, 'out'),
    fetch: hookFetch,
    ...(process.env.TYPESAFE_BASE_URL ? { baseUrl: process.env.TYPESAFE_BASE_URL } : {}),
    apiKey: () => {
      const key = process.env.TYPESAFE_API_KEY;
      if (!key) throw new Error('TYPESAFE_API_KEY is not set');
      return key;
    },
  });
}
