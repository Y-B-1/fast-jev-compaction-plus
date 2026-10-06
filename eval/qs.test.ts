import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/state.js';
import { ask, EVAL_ARGV, EVAL_CAP, EVAL_MODEL, EVAL_OVERHEAD, makeStats, type SpawnFn } from './claude.js';
import { cacheFile, dropFailed, loadQuestions, parseQuestions, questionPrompt, saveQuestions, tokenKind, type Question } from './questions.js';
import { aggregate, answerPrompt, judgePrompt, normalize, passBar, scoreAnswer, type Scored } from './score.js';

const okJson = (result: string, model = 'claude-sonnet-5-5') =>
  JSON.stringify({ type: 'result', result, modelUsage: { [model]: { inputTokens: 1 } } });

function fake(result = 'hi', model?: string) {
  const calls: { argv: string[]; cwd: string; input: string; cwdEntries: string[] }[] = [];
  const spawn: SpawnFn = (argv, o) => {
    calls.push({ argv, cwd: o.cwd, input: o.input, cwdEntries: readdirSync(o.cwd) });
    return { status: 0, stdout: okJson(result, model) };
  };
  return { spawn, calls };
}

describe('claude.ask', () => {
  it('spawns the exact argv in an empty cwd with the prompt on stdin', () => {
    const f = fake('answer');
    const r = ask('hello', makeStats(), f.spawn);
    expect(EVAL_MODEL).toBe('sonnet');
    expect(EVAL_ARGV).toEqual(['-p', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', 'project,local', '--output-format', 'json']);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].argv).toEqual(EVAL_ARGV);
    expect(f.calls[0].input).toBe('hello');
    expect(f.calls[0].cwdEntries).toEqual([]);
    expect(f.calls[0].cwd.startsWith(tmpdir()) || f.calls[0].cwd.startsWith('/private')).toBe(true);
    expect(existsSync(f.calls[0].cwd)).toBe(false); // temp dir cleaned up
    expect(r).toEqual({ text: 'answer', model: 'claude-sonnet-5-5' });
  });

  it('records the resolved model id per call', () => {
    const stats = makeStats();
    ask('a', stats, fake('x', 'claude-sonnet-5-5').spawn);
    ask('b', stats, fake('y', 'claude-sonnet-5-6').spawn);
    expect(stats.models).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-6']);
  });

  it('refuses a prompt over the cap, counts it, and never spawns', () => {
    expect(EVAL_OVERHEAD).toBe(2906);
    expect(EVAL_CAP).toBe(197094);
    const f = fake();
    const stats = makeStats();
    const big = 'word '.repeat(400_000);
    expect(estimateTokens(big)).toBeGreaterThan(EVAL_CAP);
    expect(ask(big, stats, f.spawn)).toBeNull();
    expect(stats.refusals).toBe(1);
    expect(f.calls).toHaveLength(0);
  });

  it('redacts credential-shaped text before spawn', () => {
    const f = fake();
    ask('key sk-abcdefghijklmnopqrstuvwxyz123456 here', makeStats(), f.spawn);
    expect(f.calls[0].input).not.toContain('sk-abcdefghijklmnop');
    expect(f.calls[0].input).toContain('here');
  });

  it('throws when the result carries no model id or the spawn fails', () => {
    expect(() => ask('a', makeStats(), () => ({ status: 0, stdout: JSON.stringify({ result: 'x' }) }))).toThrow(/model/);
    expect(() => ask('a', makeStats(), () => ({ status: 1, stdout: '' }))).toThrow(/exit/);
  });
});

const q = (over: Partial<Question> = {}): Question => ({
  id: 'q1', caseId: 'c1', question: 'Which file?', gold: 'src/state.ts', evidence: 'edited src/state.ts',
  category: 'path', tag: 'assistant-prose', ...over,
});

describe('questions', () => {
  it('parses a JSON reply, rejects bad categories and tags, and counts what it dropped', () => {
    const reply = JSON.stringify([
      { question: 'Which file?', gold: 'a.ts', evidence: 'x', category: 'path', tag: 'tool-result' },
      { question: 'bad', gold: 'g', evidence: 'x', category: 'weather', tag: 'tool-result' },
      { question: 'bad tag', gold: 'g', evidence: 'x', category: 'path', tag: 'nope' },
    ]);
    const r = parseQuestions('c9', '```json\n' + reply + '\n```');
    expect(r.questions.map((x) => x.id)).toEqual(['c9:0']);
    expect(r.invalid).toBe(2);
    const empty = parseQuestions('c9', JSON.stringify([
      { question: 'q', gold: '', evidence: 'x', category: 'path', tag: 'tool-result' },
      { question: 'q', gold: '  ', evidence: 'x', category: 'number', tag: 'tool-result' },
      { question: 'q', gold: 'a.ts', evidence: 'x', category: 'path', tag: 'tool-result' },
    ]));
    expect(empty.questions.map((x) => x.id)).toEqual(['c9:2']);
    expect(empty.invalid).toBe(2);
    expect(parseQuestions('c9', 'not json')).toEqual({ questions: [], invalid: 0, malformed: true });
  });

  it('classifies token questions: path, number, id, error; not decision/task/instruction', () => {
    expect(['path', 'number', 'id', 'error'].map((c) => tokenKind(c as Question['category']))).toEqual([true, true, true, true]);
    expect(['decision', 'open-task', 'instruction'].map((c) => tokenKind(c as Question['category']))).toEqual([false, false, false]);
  });

  it('the question prompt demands facts from before the pinned tail and names the tags', () => {
    const p = questionPrompt('HISTORY', 5);
    expect(p).toContain('HISTORY');
    expect(p).toMatch(/15-25|15 to 25/);
    for (const t of ['assistant-prose', 'tool-result', 'user-text', 'prose-input', 'code-body']) expect(p).toContain(t);
    expect(p).toMatch(/pinned tail/);
  });

  it('drops questions the original fails and counts them', () => {
    const qs = [q({ id: 'a' }), q({ id: 'b' })];
    const r = dropFailed(qs, new Map([['a', true], ['b', false]]));
    expect(r.kept.map((x) => x.id)).toEqual(['a']);
    expect(r.dropped).toBe(1);
  });

  it('round-trips through a cache dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fjev-q-'));
    try {
      expect(loadQuestions(dir, 'c1')).toBeUndefined();
      saveQuestions(dir, 'c1', [q()], { dropped: 2, model: 'claude-sonnet-5-5' });
      expect(cacheFile(dir, 'c1').startsWith(dir)).toBe(true);
      expect(loadQuestions(dir, 'c1')).toEqual({ questions: [q()], dropped: 2, model: 'claude-sonnet-5-5' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('score', () => {
  it('normalizes case, quotes, backticks, trailing punctuation and whitespace', () => {
    expect(normalize('  `Src/State.ts`. ')).toBe('src/state.ts');
    expect(normalize('"v1.2.3",')).toBe('v1.2.3');
    expect(normalize('Error:   ENOENT')).toBe('error: enoent');
  });

  it('token questions pass when the normalized answer contains the normalized gold', () => {
    expect(scoreAnswer(q(), 'It was `SRC/state.ts`.')).toEqual({ outcome: 'pass' });
    expect(scoreAnswer(q(), 'src/other.ts')).toEqual({ outcome: 'wrong' });
  });

  it('token golds match as whole tokens, not substrings', () => {
    const t = (gold: string, answer: string, category: Question['category'] = 'path') => scoreAnswer(q({ gold, category }), answer).outcome;
    expect(t('5', '15 retries', 'number')).toBe('wrong');
    expect(t('3000', '30000', 'number')).toBe('wrong');
    expect(t('5', '1.5', 'number')).toBe('wrong');
    expect(t('src/a.ts', 'src/a.tsx')).toBe('wrong');
    expect(t('a.ts', 'src/a.ts')).toBe('wrong');
    expect(t('a.ts', 'src/b.ts or a.ts or c.ts')).toBe('wrong');
    expect(t('a.ts', 'a.ts, b.ts')).toBe('wrong');
    expect(t('', 'anything')).toBe('wrong');
    expect(t('src/a.ts', 'The file is src/a.ts in the repo')).toBe('pass');
    expect(t('src/a.ts', 'It is `src/a.ts`')).toBe('pass');
    expect(t('src/a.ts', 'src/a.ts.')).toBe('pass');
    expect(t('src/a.ts', 'It was src/a.ts, I think')).toBe('pass');
    expect(t('5', 'There were 5 retries.', 'number')).toBe('pass');
    expect(t('ENOENT', 'Error: ENOENT', 'error')).toBe('pass');
  });

  it('an answer starting with UNKNOWN is unknown', () => {
    expect(scoreAnswer(q(), 'UNKNOWN (perhaps src/state.ts)')).toEqual({ outcome: 'unknown' });
    expect(scoreAnswer(q({ category: 'decision' }), 'unknown, maybe X', () => 'CORRECT')).toEqual({ outcome: 'unknown' });
    expect(scoreAnswer(q(), 'Unknownword src/state.ts')).toEqual({ outcome: 'pass' });
  });

  it('UNKNOWN answers score unknown, never pass, unless the gold itself starts with "unknown"', () => {
    expect(scoreAnswer(q(), 'UNKNOWN')).toEqual({ outcome: 'unknown' });
    expect(scoreAnswer(q(), ' unknown. ')).toEqual({ outcome: 'unknown' });
    expect(scoreAnswer(q({ category: 'decision' }), 'UNKNOWN', () => 'CORRECT')).toEqual({ outcome: 'unknown' });
  });

  it('sentence answers holding the gold and no other candidate of its kind pass (R1)', () => {
    const t = (gold: string, answer: string, category: Question['category']) => scoreAnswer(q({ gold, category }), answer).outcome;
    expect(t('3000', 'The timeout is 3000 ms, set in config.ts', 'number')).toBe('pass');
    expect(t('404', 'HTTP 404, from /api/x', 'number')).toBe('pass');
    expect(t('EADDRINUSE', 'EADDRINUSE on port 3000, then retried', 'error')).toBe('pass');
    expect(t('src/a.ts', 'src/a.ts and it was edited in v1.2', 'path')).toBe('pass');
    expect(t('8', '8 files and 245 tests', 'number')).toBe('wrong');
    expect(t('5', '5 retries, then backoff of 2s', 'number')).toBe('wrong');
    expect(t('a.ts', 'src/b.ts or a.ts', 'path')).toBe('wrong');
    expect(t('abc1234', 'abc1234 or deadbeef9', 'id')).toBe('wrong');
    expect(t('PROJ-12', 'PROJ-12, not PROJ-13', 'id')).toBe('wrong');
    expect(t('abc1234', 'The commit is abc1234 on 2026-10-06', 'id')).toBe('pass');
  });

  it('fragments of the gold are not other candidates (repair 3)', () => {
    const t = (gold: string, answer: string, category: Question['category']) => scoreAnswer(q({ gold, category }), answer).outcome;
    for (const g of ['3000ms', '30s', '-1', '1,000', '50%', 'v1.2.3']) expect(t(g, g, 'number')).toBe('pass');
    for (const g of ['~/x.ts', '@scope/pkg/index.ts', 'My Docs/a.ts', 'C:\\foo\\bar.ts']) expect(t(g, g, 'path')).toBe('pass');
    expect(t('3000ms', '3000ms, not 5000ms', 'number')).toBe('wrong');
    expect(t('My Docs/a.ts', 'My Docs/a.ts or src/b.ts', 'path')).toBe('wrong');
  });

  it('exact answers that merely start with "unknown" are not UNKNOWN (R2)', () => {
    expect(scoreAnswer(q({ gold: "Unknown option '--foo'", category: 'error' }), "Unknown option '--foo'")).toEqual({ outcome: 'pass' });
    expect(scoreAnswer(q({ gold: 'unknown.ts', category: 'path' }), 'unknown.ts')).toEqual({ outcome: 'pass' });
    expect(scoreAnswer(q({ gold: 'UNKNOWN', category: 'path' }), 'UNKNOWN')).toEqual({ outcome: 'pass' });
    expect(scoreAnswer(q(), 'unknown - no idea')).toEqual({ outcome: 'unknown' });
    expect(scoreAnswer(q(), 'Unknown: not stated')).toEqual({ outcome: 'unknown' });
    expect(scoreAnswer(q(), 'unknown.ts')).toEqual({ outcome: 'wrong' });
  });

  it('token answer prompts ask for the single exact value only; free questions do not', () => {
    for (const c of ['path', 'number', 'id', 'error'] as const) expect(answerPrompt('T', q({ category: c }))).toMatch(/single exact value only/i);
    expect(answerPrompt('T', q({ category: 'decision' }))).not.toMatch(/single exact value only/i);
  });

  it('non-token questions go to the judge, which sees only gold and answer', () => {
    let seen = '';
    const judge = (p: string) => ((seen = p), 'CORRECT');
    const qq = q({ category: 'decision', question: 'SECRETQUESTION', evidence: 'SECRETEVIDENCE', gold: 'use X because Y' });
    expect(scoreAnswer(qq, 'X, since Y', judge)).toEqual({ outcome: 'pass' });
    expect(seen).toContain('use X because Y');
    expect(seen).toContain('X, since Y');
    expect(seen).not.toContain('SECRETEVIDENCE');
    expect(scoreAnswer(qq, 'Z', () => 'INCORRECT')).toEqual({ outcome: 'wrong' });
    expect(() => scoreAnswer(qq, 'Z')).toThrow(/judge/);
    expect(judgePrompt('g', 'a')).not.toMatch(/question/i);
  });

  it('the answer prompt shows only the arm output and the question, with UNKNOWN as the escape', () => {
    const p = answerPrompt('ARM OUTPUT', q({ gold: 'GOLDVALUE', evidence: 'EVID' }));
    expect(p).toContain('ARM OUTPUT');
    expect(p).toContain('Which file?');
    expect(p).toContain('UNKNOWN');
    expect(p).not.toContain('GOLDVALUE');
    expect(p).not.toContain('EVID');
  });

  const s = (o: Partial<Question>, outcome: Scored['outcome']): Scored => ({ question: q(o), outcome });
  it('aggregates recall, group recalls, wrong rate; unknown counts as a miss and a non-wrong', () => {
    const rows: Scored[] = [
      s({ category: 'path', tag: 'assistant-prose' }, 'pass'),
      s({ category: 'number', tag: 'tool-result' }, 'pass'),
      s({ category: 'error', tag: 'prose-input', field: 'Write.content' }, 'wrong'),
      s({ category: 'decision', tag: 'code-body', field: 'Write.content' }, 'unknown'),
      s({ category: 'decision', tag: 'user-text' }, 'pass'),
    ];
    const m = aggregate(rows);
    expect(m.total).toBe(5);
    expect(m.recall).toBeCloseTo(3 / 5);
    expect(m.tokenRecall).toBeCloseTo(2 / 3);
    expect(m.proseEvidenceRecall).toBeCloseTo(1); // assistant-prose only
    expect(m.inputEvidenceRecall).toBeCloseTo(0); // prose-input + code-body
    expect(m.wrongRate).toBeCloseTo(1 / 5);
    expect(m.inputByField['Write.content']).toEqual({ pass: 0, total: 2 });
    expect(passBar(m)).toEqual({ pass: false, failed: expect.arrayContaining(['recall', 'tokenRecall', 'inputEvidenceRecall', 'wrongRate']) });
  });

  it('passes the bar at the stated thresholds', () => {
    const rows: Scored[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push(s({ category: i % 2 ? 'path' : 'decision', tag: i % 4 === 0 ? 'prose-input' : 'assistant-prose' }, 'pass'));
    }
    expect(passBar(aggregate(rows))).toEqual({ pass: true, failed: [] });
  });
});
