import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectToolCalls, estimateTokens } from '../src/state.js';
import { cases, freeze, intact, loadTranscript, split, type Case } from './load.js';

const root = mkdtempSync(join(tmpdir(), 'fjev-eval-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CUT = Date.parse('2026-10-06T16:55:00+04:00');
let uid = 0;
const line = (o: object) => JSON.stringify({ uuid: `u${uid++}`, isSidechain: false, ...o });
const user = (text: string, extra: object = {}) =>
  line({ type: 'user', message: { role: 'user', content: text }, ...extra });
const asst = (content: object[], id = `m${uid}`) =>
  line({ type: 'assistant', message: { id, role: 'assistant', content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown, is_error = false) =>
  line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
  });
const boundary = () => line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
const summary = (t: string) => user(t, { isCompactSummary: true });

let n = 0;
function write(folder: string, lines: string[], mtimeMs = CUT - 60_000, tail = '\n'): string {
  const dir = join(root, folder, 'proj');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `t${n++}.jsonl`);
  writeFileSync(path, lines.join('\n') + tail);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

describe('freeze', () => {
  it('keeps pre-cutoff files from every folder, drops later ones, records mtime and sha256', () => {
    const base = join(root, 'proj-freeze');
    mkdirSync(base, { recursive: true });
    const mk = (folder: string, name: string, mtime: number, body: string) => {
      mkdirSync(join(base, folder), { recursive: true });
      const p = join(base, folder, name);
      writeFileSync(p, body);
      utimesSync(p, mtime / 1000, mtime / 1000);
      return p;
    };
    const a = mk('A', 'a.jsonl', CUT - 5000, 'aaa\n');
    const b = mk('B', 'b.jsonl', CUT - 1000, 'bbb\n');
    mk('A', 'live.jsonl', CUT + 5000, 'live\n');
    mk('B', 'note.txt', CUT - 1000, 'not a transcript');
    const m = freeze(base, CUT);
    expect(m.files.map((f) => f.path)).toEqual([a, b]);
    expect(m.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.files[0].mtimeMs).toBeCloseTo(CUT - 5000, -1);
    expect(m.cutoffMs).toBe(CUT);
  });
});

describe('intact', () => {
  it('drops a file whose hash changed or that is gone, counts it, and lets cases() load the rest', () => {
    const good = write('intact', [user('hello'), asst([text('hi')])]);
    const changed = write('intact', [user('hello'), asst([text('hi')])]);
    const gone = write('intact', [user('hello')]);
    const m = freeze(join(root, 'intact'), CUT);
    expect(m.files).toHaveLength(3);
    writeFileSync(changed, 'edited after the freeze\n');
    rmSync(gone);
    expect(() => cases(m)).toThrow(/hash mismatch|ENOENT/);
    const r = intact(m);
    expect(r.skipped).toBe(2);
    expect(r.manifest.files.map((f) => f.path)).toEqual([good]);
    expect(() => cases(r.manifest)).not.toThrow();
  });
});

describe('loadTranscript', () => {
  it('refuses a file whose hash no longer matches the manifest', () => {
    const p = write('f1', [user('hello')]);
    const m = freeze(join(root, 'f1'), CUT);
    writeFileSync(p, user('changed') + '\n');
    expect(() => loadTranscript(m.files[0])).toThrow(/hash/i);
  });

  it('tolerates and counts a cut-off last line', () => {
    write('f2', [user('hello'), asst([text('hi')]), '{"type":"assistant","message":{"id":"x","role":"assis'], CUT - 1000, '');
    const m = freeze(join(root, 'f2'), CUT);
    const t = loadTranscript(m.files[0]);
    expect(t.messages.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(t.skipped).toBe(1);
  });

  it('pairs tool_use with tool_result and merges split assistant lines', () => {
    write('f3', [
      user('go'),
      asst([text('running')], 'm1'),
      asst([toolUse('tu1', 'Bash', { command: 'ls' })], 'm1'),
      result('tu1', [{ type: 'text', text: 'file.txt' }]),
      asst([text('done')]),
    ]);
    const t = loadTranscript(freeze(join(root, 'f3'), CUT).files[0]);
    expect(t.messages).toHaveLength(4);
    expect(t.messages[1].text).toBe('running');
    expect(t.messages[1].toolUses[0]).toMatchObject({ tool_use_id: 'tu1', tool: 'Bash', input: { command: 'ls' } });
    expect(t.messages[2].toolResults).toEqual([{ tool_use_id: 'tu1', text: 'file.txt', isError: false }]);
    const calls = collectToolCalls(t.messages, 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool_use_id: 'tu1', callIndex: 1, resultIndex: 2 });
  });

  it('excludes thinking blocks and sidechain lines', () => {
    write('f4', [
      user('q'),
      asst([{ type: 'thinking', thinking: 'SECRET-THOUGHT' }, text('answer')]),
      line({ type: 'assistant', isSidechain: true, message: { id: 's', role: 'assistant', content: [text('SIDE')] } }),
      line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'SIDEUSER' } }),
    ]);
    const t = loadTranscript(freeze(join(root, 'f4'), CUT).files[0]);
    expect(JSON.stringify(t.messages)).not.toMatch(/SECRET-THOUGHT|SIDE/);
    expect(t.messages.map((x) => x.text)).toEqual(['q', 'answer']);
  });
});

describe('cases', () => {
  const body = (k: string) => 'x'.repeat(40) + k;
  it('cuts windows at compact boundaries and captures the built-in summary', () => {
    write('c1', [
      user(body('a')),
      asst([text(body('b'))]),
      boundary(),
      summary('SUMMARY-ONE'),
      user(body('c')),
      asst([text(body('d'))]),
      user(body('e')),
      boundary(),
      summary('SUMMARY-TWO'),
      user(body('after')),
    ]);
    const m = freeze(join(root, 'c1'), CUT);
    const cs = cases(m);
    expect(cs).toHaveLength(2);
    expect([cs[0].start, cs[0].end]).toEqual([0, 2]);
    expect([cs[1].start, cs[1].end]).toEqual([2, 5]);
    expect(cs[0].builtinSummary).toBe('SUMMARY-ONE');
    expect(cs[1].builtinSummary).toBe('SUMMARY-TWO');
    expect(cs[0].id).not.toBe(cs[1].id);
    expect(cs[0].transcript).toBe(m.files[0].path);
  });

  it('gives each case chars and an estimateTokens estimate', () => {
    write('c2', [user('hello world'), asst([text('hi there')]), boundary(), summary('S')]);
    const [c] = cases(freeze(join(root, 'c2'), CUT));
    expect(c.chars).toBeGreaterThan(0);
    expect(c.estTokens).toBeGreaterThan(0);
    const t = loadTranscript(freeze(join(root, 'c2'), CUT).files[0]);
    expect(c.estTokens).toBe(
      t.messages.slice(c.start, c.end).reduce((s, x) => s + estimateTokens(JSON.stringify(x)), 0),
    );
  });

  it('makes a boundary-less transcript one case only when over 50k tokens', () => {
    write('c3', [user('short'), asst([text('reply')])]);
    expect(cases(freeze(join(root, 'c3'), CUT))).toHaveLength(0);
    const big = Array.from({ length: 60 }, (_, i) => user(`m${i} ` + 'lorem ipsum dolor sit amet '.repeat(400)));
    write('c4', big);
    const cs = cases(freeze(join(root, 'c4'), CUT));
    expect(cs).toHaveLength(1);
    expect(cs[0].estTokens).toBeGreaterThan(50_000);
    expect([cs[0].start, cs[0].end]).toEqual([0, 60]);
    expect(cs[0].builtinSummary).toBeUndefined();
  });
});

describe('shared history', () => {
  const body = (k: string) => 'x'.repeat(40) + k;
  it('emits an identical case once and tags cases with the transcript main-thread uuids', () => {
    const prefix = [user(body('a')), asst([text(body('b'))]), boundary(), summary('S')];
    const a = write('h1', [...prefix, user(body('only-a')), boundary(), summary('S2')]);
    const b = write('h1', [...prefix, user(body('only-b')), boundary(), summary('S3')]);
    const cs = cases(freeze(join(root, 'h1'), CUT));
    expect(cs.filter((c) => c.start === 0 && c.end === 2)).toHaveLength(1);
    expect(cs).toHaveLength(3);
    expect(cs.find((c) => c.transcript === a && c.start === 2)).toBeDefined();
    expect(cs.find((c) => c.transcript === b && c.start === 2)).toBeDefined();
    const ca = cs.find((c) => c.transcript === a)!;
    const cb = cs.find((c) => c.transcript === b && c.start === 2)!;
    expect(ca.uuids!.filter((u) => cb.uuids!.includes(u)).length).toBeGreaterThan(0);
  });

  it('puts transcripts that share a uuid on the same side of the split, for every seed', () => {
    const mk = (t: number, uuids: string[]): Case[] =>
      Array.from({ length: 3 }, (_, k): Case => ({ id: `t${t}#${k}`, transcript: `/p/t${t}.jsonl`, start: k, end: k + 1, chars: 1, estTokens: 1000, uuids }));
    const all = Array.from({ length: 36 }, (_, t) => mk(t, t === 1 || t === 2 || t === 3 ? ['shared', `own${t}`] : [`own${t}`])).flat();
    for (let seed = 0; seed < 20; seed++) {
      const r = split(all, 5000, seed);
      const sideOf = (t: string) => (r.dev.some((c) => c.transcript === t) ? 'dev' : 'test');
      expect(new Set(['/p/t1.jsonl', '/p/t2.jsonl', '/p/t3.jsonl'].map(sideOf)).size).toBe(1);
    }
  });
});

describe('split', () => {
  const mk = (transcripts: number, per: number, tokens: (i: number) => number): Case[] =>
    Array.from({ length: transcripts }, (_, t) =>
      Array.from({ length: per }, (_, k): Case => ({
        id: `t${t}#${k}`,
        transcript: `/p/t${t}.jsonl`,
        start: k,
        end: k + 1,
        chars: 1,
        estTokens: tokens(k),
      })),
    ).flat();
  const all = mk(30, 3, () => 1000);

  it('is deterministic for a seed, differs across seeds, and is disjoint by transcript', () => {
    const a = split(all, 5000);
    const b = split(all, 5000);
    expect(a).toEqual(b);
    expect(split(all, 5000, 1).test.map((c) => c.id)).not.toEqual(a.test.map((c) => c.id));
    const devT = new Set(a.dev.map((c) => c.transcript));
    expect(a.test.some((c) => devT.has(c.transcript))).toBe(false);
    expect(a.dev.length + a.test.length).toBe(all.length);
    for (const c of a.dev) expect(a.dev.filter((d) => d.transcript === c.transcript).length).toBe(3);
  });

  it('does not count cases at or over the cap, and records the ratio', () => {
    const mixed = mk(30, 3, (k) => (k === 0 ? 9000 : 1000));
    const r = split(mixed, 5000);
    expect(r.testUnderCap).toBe(r.test.filter((c) => c.estTokens < 5000).length);
    expect(r.devUnderCap).toBe(r.dev.filter((c) => c.estTokens < 5000).length);
    expect(r.testUnderCap).toBe(2 * r.test.length / 3);
    expect(r.ratio).toBeCloseTo(r.testUnderCap / r.devUnderCap, 10);
    expect(r.test.length / (r.test.length + r.dev.length)).toBeCloseTo(2 / 3, 1);
  });

  it('throws when fewer than 24 test cases are under the cap', () => {
    expect(() => split(mk(30, 1, () => 1000), 5000)).toThrow(/test/i); // dev 10, test 20
    expect(() => split(mk(36, 1, () => 1000), 5000)).not.toThrow(); // dev 12, test 24
    expect(() => split(mk(30, 3, () => 9000), 5000)).toThrow(/test/i); // nothing under the cap
  });

  it('throws when fewer than 5 dev cases are under the cap', () => {
    const big = (name: string, k: number) =>
      Array.from({ length: k }, (_, i): Case => ({ id: `${name}#${i}`, transcript: `/${name}`, start: i, end: i + 1, chars: 1, estTokens: 1000 }));
    const corpus = [...big('A', 30), ...big('B', 30), ...big('C', 2)]; // dev gets exactly one of three transcripts
    const outcomes = Array.from({ length: 12 }, (_, seed) => {
      try {
        return split(corpus, 5000, seed).dev[0].transcript;
      } catch (e) {
        expect((e as Error).message).toMatch(/dev/i);
        return 'threw';
      }
    });
    expect(outcomes).toContain('threw');
    expect(outcomes).not.toContain('/C');
  });
});
