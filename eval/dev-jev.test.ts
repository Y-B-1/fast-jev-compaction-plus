import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { run, type S4 } from './dev-jev.js';
import { freeze, loadTranscript, type Case } from './load.js';

const root = mkdtempSync(join(tmpdir(), 'fjev-dev-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
vi.stubGlobal('fetch', () => {
  throw new Error('network is off in tests');
});

let uid = 0;
const line = (o: object) => JSON.stringify({ uuid: `u${uid++}`, isSidechain: false, ...o });
const asst = (content: object[]) => line({ type: 'assistant', message: { id: `m${uid}`, role: 'assistant', content } });
const result = (id: string, content: string) =>
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

/** A synthetic transcript: a goal, then 8 old turns of filler prose plus a Read call, then a short tail. */
function transcript(name: string): { cases: Case[]; manifest: ReturnType<typeof freeze> } {
  const dir = join(root, name, 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = [line({ type: 'user', message: { role: 'user', content: 'Fix the parser bug in the config loader.' } })];
  for (let i = 0; i < 8; i++) {
    lines.push(
      asst([
        { type: 'text', text: 'Sure, I will take a look at this now. Then I will report what I find in detail.' },
        { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/x/f${i}.ts` } },
      ]),
      result(`t${i}`, 'x'.repeat(2000)),
    );
  }
  lines.push(line({ type: 'user', message: { role: 'user', content: 'Thanks, continue.' } }), asst([{ type: 'text', text: 'Done.' }]));
  const path = join(dir, 'a.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  const manifest = freeze(join(root, name), Date.now() + 1e6);
  const messages = loadTranscript(manifest.files[0]!).messages;
  const c: Case = { id: `${name}#0-${messages.length}`, transcript: path, start: 0, end: messages.length, chars: 0, estTokens: 1000 };
  return { cases: [c, { ...c, id: `${name}#again` }], manifest };
}

type Req = { questions: Record<string, unknown> };
/** Fake Jev: c-units alternate low and high noul; c1 flips on every second sighting. Calls and results are kept. */
function fakeFetch(status = 200) {
  const seen = new Map<string, number>();
  const calls: string[] = [];
  const fn = async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as Req;
    calls.push(Object.keys(body.questions).join(','));
    if (status !== 200) return new Response('nope', { status });
    const answers: Record<string, { type: 'noul'; noul: number }> = {};
    for (const key of Object.keys(body.questions)) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      let noul = 0.9;
      if (/^c\d+$/.test(key)) noul = (Number(key.slice(1)) % 2 === 1) !== (key === 'c1' && n % 2 === 0) ? 0.02 : 0.9;
      answers[key] = { type: 'noul', noul };
    }
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('dev-jev run', () => {
  it('refuses without an API key and sends nothing', async () => {
    const { cases, manifest } = transcript('nokey');
    const f = fakeFetch();
    await expect(run({ cases, manifest, cap: 197094, outPath: join(root, 'nokey.json'), fetch: f.fn })).rejects.toThrow(
      /TYPESAFE_API_KEY/,
    );
    expect(f.calls).toEqual([]);
  });

  it('writes per-case statuses, T0, histogram and flip rate, with no transcript text', async () => {
    const { cases, manifest } = transcript('ok');
    const f = fakeFetch();
    const outPath = join(root, 'ok.json');
    const s4 = await run({ cases, manifest, cap: 197094, outPath, apiKey: 'test-key', fetch: f.fn });
    const onDisk: S4 = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(onDisk).toEqual(s4);
    expect(s4.cases.map((c) => c.id)).toEqual(cases.map((c) => c.id));
    expect(s4.allOk).toBe(true);
    for (const c of s4.cases) {
      expect(c.statuses).toEqual({ '200': c.t0.requests + c.trim.requests[0] + c.trim.requests[1] });
      expect(typeof c.t0.pct).toBe('number');
      expect(c.trim.scored).toBeGreaterThan(0);
      const binned = Object.values(c.noul.bins).reduce((a, b) => a + b, 0);
      expect(binned + c.noul.missing).toBe(c.trim.scored);
      expect(c.flip.compared).toBe(c.trim.scored);
      expect(c.flip.flips).toBe(1);
      expect(c.flip.rate).toBe(1 / c.trim.scored);
    }
    expect(Object.values(s4.histogram).reduce((a, b) => a + b, 0)).toBe(
      s4.cases.reduce((a, c) => a + c.trim.scored, 0),
    );
    const raw = readFileSync(outPath, 'utf8');
    expect(raw).not.toContain('take a look');
    expect(raw).not.toContain('test-key');
  });

  it('stops after the first case whose request returns non-200', async () => {
    const { cases, manifest } = transcript('bad');
    const s4 = await run({ cases, manifest, cap: 197094, outPath: join(root, 'bad.json'), apiKey: 'test-key', fetch: fakeFetch(500).fn });
    expect(s4.cases).toHaveLength(1);
    expect(s4.allOk).toBe(false);
    expect(s4.cases[0]!.statuses['500']).toBeGreaterThan(0);
  });
});
