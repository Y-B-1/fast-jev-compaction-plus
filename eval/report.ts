// Dev-only: per-arm metrics, the A-versus-B comparison on shared cases, and the verdict (docs/prose-trim-design.md, Pass bar).
// Holds ids, tags and scores only, never transcript text.
import { ARMS, type Arm } from './arms.js';
import { CATEGORIES, TAGS } from './questions.js';
import { aggregate, passBar, type Metrics, type Scored } from './score.js';

export type ProseTrimDefault = 'trim' | 'tidy' | 'off';
export interface Verdict {
  default: ProseTrimDefault;
  reasons: string[];
}
/** A variant's metrics and the recall of S over the same cases. */
export interface Variant {
  metrics: Metrics;
  sRecall: number;
}
export interface ArmReport {
  metrics: Metrics;
  byTag: Record<string, Metrics>;
  byCategory: Record<string, Metrics>;
}
export type ArmRows = Partial<Record<Arm, Scored[]>>;
export interface Report {
  arms: Partial<Record<Arm, ArmReport>>;
  /** A and B on the cases both cover, S alongside; absent when there are none. */
  comparison?: { sharedCases: number; a: Metrics; b: Metrics; s: Metrics };
  verdict: Verdict;
}

/** Float slack for the two difference rules (0.97 - 0.01 is not exactly 0.96). */
const EPS = 1e-9;
const S_MARGIN = 0.01;
const TIE_MARGIN = 0.02;

/**
 * The pass bar on each variant (score.ts passBar, plus recall >= S - 0.01). Both pass: the higher recall wins, and A wins when
 * B's recall exceeds A's by at most 0.02 (compared on `shared` recalls when given). One passes: it wins. Neither: off.
 */
export function verdict(a: Variant | undefined, b: Variant | undefined, shared?: { a: number; b: number }): Verdict {
  const reasons: string[] = [];
  const check = (name: string, v: Variant | undefined): boolean => {
    if (!v) {
      reasons.push(`${name}: no scored cases`);
      return false;
    }
    const failed = passBar(v.metrics).failed;
    if (!(v.metrics.recall + EPS >= v.sRecall - S_MARGIN)) failed.push('recall < S - 0.01');
    reasons.push(failed.length === 0 ? `${name}: passes the bar` : `${name}: fails ${failed.join(', ')}`);
    return failed.length === 0;
  };
  const aPass = check('A', a);
  const bPass = check('B', b);
  if (aPass && bPass) {
    const ra = shared?.a ?? (a as Variant).metrics.recall;
    const rb = shared?.b ?? (b as Variant).metrics.recall;
    const tidy = rb - ra > TIE_MARGIN + EPS;
    reasons.push(tidy ? 'both pass: B recall beats A by more than 0.02' : 'both pass: A recall is within 0.02 of B or higher');
    return { default: tidy ? 'tidy' : 'trim', reasons };
  }
  if (aPass || bPass) return { default: aPass ? 'trim' : 'tidy', reasons };
  reasons.push('neither passes: default stays off');
  return { default: 'off', reasons };
}

const groupBy = (rows: Scored[], key: (r: Scored) => string): Record<string, Metrics> => {
  const groups = new Map<string, Scored[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return Object.fromEntries([...groups].map(([k, v]) => [k, aggregate(v)]));
};
const armReport = (rows: Scored[]): ArmReport => ({
  metrics: aggregate(rows),
  byTag: groupBy(rows, (r) => r.question.tag),
  byCategory: groupBy(rows, (r) => r.question.category),
});
const caseIds = (rows: Scored[] | undefined): Set<string> => new Set((rows ?? []).map((r) => r.question.caseId));
const only = (rows: Scored[] | undefined, ids: Set<string>): Scored[] => (rows ?? []).filter((r) => ids.has(r.question.caseId));

/** Every arm's metrics, A versus B on shared cases, and the verdict. A variant is judged on its own cases with S on the same cases. */
export function buildReport(rows: ArmRows): Report {
  const arms: Report['arms'] = {};
  for (const arm of ARMS) if (rows[arm]?.length) arms[arm] = armReport(rows[arm] as Scored[]);
  const variant = (r: Scored[] | undefined): Variant | undefined =>
    r?.length ? { metrics: aggregate(r), sRecall: aggregate(only(rows.S, caseIds(r))).recall } : undefined;
  const a = variant(rows.A);
  const b = variant(rows.B);
  const aIds = caseIds(rows.A);
  const shared = new Set([...caseIds(rows.B)].filter((id) => aIds.has(id)));
  let comparison: Report['comparison'];
  if (shared.size > 0) {
    comparison = {
      sharedCases: shared.size,
      a: aggregate(only(rows.A, shared)),
      b: aggregate(only(rows.B, shared)),
      s: aggregate(only(rows.S, shared)),
    };
  }
  const v = verdict(a, b, comparison && { a: comparison.a.recall, b: comparison.b.recall });
  if (!b) v.reasons.push('B is not covered: no case has a B result');
  return { arms, ...(comparison ? { comparison } : {}), verdict: v };
}

const pct = (n: number): string => (Number.isNaN(n) ? 'n/a' : (n * 100).toFixed(1));

/** Markdown: one row per arm, per-tag and per-category recall, the A-versus-B count and the verdict line. */
export function renderReport(r: Report): string {
  const lines = ['| arm | questions | recall | token | prose-ev | input-ev | wrong |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const arm of ARMS) {
    const m = r.arms[arm]?.metrics;
    lines.push(m ? `| ${arm} | ${m.total} | ${pct(m.recall)} | ${pct(m.tokenRecall)} | ${pct(m.proseEvidenceRecall)} | ${pct(m.inputEvidenceRecall)} | ${pct(m.wrongRate)} |` : `| ${arm} | not covered | | | | | |`);
  }
  const group = (title: string, names: readonly string[], pick: (a: ArmReport) => Record<string, Metrics>): void => {
    lines.push('', `Recall by ${title}`, '', `| arm | ${names.join(' | ')} |`, `| --- | ${names.map(() => '---:').join(' | ')} |`);
    for (const arm of ARMS) {
      const a = r.arms[arm];
      if (a) lines.push(`| ${arm} | ${names.map((n) => pct(pick(a)[n]?.recall ?? NaN)).join(' | ')} |`);
    }
  };
  group('tag', TAGS, (a) => a.byTag);
  group('category', CATEGORIES, (a) => a.byCategory);
  lines.push('', r.comparison ? `A vs B on ${r.comparison.sharedCases} shared cases: A recall ${pct(r.comparison.a.recall)}, B recall ${pct(r.comparison.b.recall)}, S recall ${pct(r.comparison.s.recall)}` : 'A vs B: no shared cases');
  lines.push('', `Verdict: ${r.verdict.default} (${r.verdict.reasons.join('; ')})`);
  return lines.join('\n') + '\n';
}
