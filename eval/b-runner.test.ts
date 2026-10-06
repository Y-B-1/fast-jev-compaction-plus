import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { confirmFromStream, cutCopy, parseCompacted, runHeadless, type BSpawn } from './b-runner.js';
import { loadTranscript, type Case } from './load.js';

const root = mkdtempSync(join(tmpdir(), 'fjev-b-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
vi.stubGlobal('fetch', () => {
  throw new Error('network is off in tests');
});
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-test-synthetic-key-0123456789';

let uid = 0;
const line = (o: object) => JSON.stringify({ uuid: `u${uid++}`, isSidechain: false, ...o });
const user = (t: string, extra: object = {}) => line({ type: 'user', message: { role: 'user', content: t }, ...extra });
const asst = (t: string) => line({ type: 'assistant', message: { id: `m${uid}`, role: 'assistant', content: [{ type: 'text', text: t }] } });
const boundary = () => line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' });
const compacted = (summary: string) => [user('q1'), asst('a1'), boundary(), user(summary, { isCompactSummary: true }), user('kept q'), asst('kept a')];

function write(name: string, lines: string[]): string {
  const p = join(root, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('parseCompacted', () => {
  it('fills {caseId, mode, summary, keptMessages} from a synthetic compacted transcript', () => {
    const p = write('c1.jsonl', compacted('Line one\n\nLine two\nLine three'));
    expect(parseCompacted(p, 'case-1', 'hand')).toEqual({ caseId: 'case-1', mode: 'hand', summary: ['Line one', 'Line two', 'Line three'], keptMessages: 2 });
  });
  it('uses the last boundary', () => {
    const p = write('c2.jsonl', [...compacted('first'), boundary(), user('second\nsummary', { isCompactSummary: true }), user('k'), asst('k2'), user('k3')]);
    const r = parseCompacted(p, 'c', 'headless');
    expect(r.summary).toEqual(['second', 'summary']);
    expect(r.keptMessages).toBe(3);
    expect(r.mode).toBe('headless');
  });
  it('throws when there is no boundary or no summary', () => {
    expect(() => parseCompacted(write('c3.jsonl', [user('x'), asst('y')]), 'c', 'hand')).toThrow(/no compact boundary/);
    expect(() => parseCompacted(write('c4.jsonl', [user('x'), boundary()]), 'c', 'hand')).toThrow(/no summary/);
  });
});

describe('parseCompacted preserved segment', () => {
  it('counts the messages between preservedSegment head and tail, which lie before the boundary', () => {
    const k1 = user('kept 1');
    const k2 = asst('kept 2');
    const [h, t] = [JSON.parse(k1).uuid, JSON.parse(k2).uuid];
    const b = line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: h, anchorUuid: 'x', tailUuid: t } } });
    const p = write('ps.jsonl', [user('old'), k1, k2, asst('dropped'), b, user('SUM', { isCompactSummary: true })]);
    expect(parseCompacted(p, 'c', 'headless').keptMessages).toBe(2);
  });
});

describe('parseCompacted preserved messages', () => {
  it('counts only user and assistant records whose uuid is in preservedMessages.uuids', () => {
    const k1 = user('kept 1');
    const k2 = asst('kept 2');
    const sys = line({ type: 'system', subtype: 'info', content: 'listed but not a message' });
    const other = user('not listed');
    const uuids = [k1, k2, sys].map((l) => JSON.parse(l).uuid).concat('missing-uuid');
    const b = line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preservedMessages: { uuids } } });
    const p = write('pm.jsonl', [k1, k2, sys, other, b, user('SUM', { isCompactSummary: true }), user('after')]);
    expect(parseCompacted(p, 'c', 'headless').keptMessages).toBe(2);
  });
});

describe('confirmFromStream', () => {
  const ask = async (answer: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = confirmFromStream('go?', input, output);
    input.write(answer + '\n');
    return p;
  };
  it('is true only for y or yes', async () => {
    expect(await ask('y')).toBe(true);
    expect(await ask('Yes')).toBe(true);
    expect(await ask('n')).toBe(false);
    expect(await ask('')).toBe(false);
  });
});

function setup(sessionText = 'synthetic', history: string[] = []) {
  const dir = mkdtempSync(join(root, 'h-'));
  const projects = join(dir, 'projects');
  const folder = join(projects, '-synthetic-folder');
  mkdirSync(folder, { recursive: true });
  const src = 'aaaaaaaa-0000-4000-8000-000000000001';
  writeFileSync(join(folder, `${src}.jsonl`), [JSON.stringify({ type: 'user', cwd: join(dir, 'work'), message: { content: sessionText } }), ...history].join('\n') + '\n');
  mkdirSync(join(dir, 'work'));
  const out: string[] = [];
  const sourceLines = readFileSync(join(folder, `${src}.jsonl`), 'utf8').split('\n').filter(Boolean);
  const file = join(folder, `${src}.jsonl`);
  const tail = loadTranscript({ path: file, mtimeMs: 0, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }).messages.length;
  const theCase: Case = { id: 'case-9', transcript: file, start: 0, end: tail, chars: 0, estTokens: 0 };
  return { dir, projects, folder, src, sourceLines, theCase, evalDir: join(dir, 'eval'), outDir: join(dir, 'eval', 'out'), out };
}

const baseOpts = (s: ReturnType<typeof setup>, spawn: BSpawn, confirm: (q: string) => Promise<boolean>) => ({
  case: s.theCase, evalDir: s.evalDir, outDir: s.outDir,
  env: { PATH: '/bin', TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv, spawn, confirm, print: (m: string) => s.out.push(m),
});

const modeOf = (s: ReturnType<typeof setup>) => JSON.parse(readFileSync(join(s.outDir, 'b-mode.json'), 'utf8'));
const idOf = (a: string[]) => a[a.indexOf('--session-id') + 1];
const markerOf = (s: ReturnType<typeof setup>, a: string[]) => join(s.evalDir, 'live', `marker-${idOf(a)}.txt`);

describe('runHeadless', () => {
  it('prints the fork path, sends nothing and writes nothing on n', async () => {
    const s = setup();
    const spawn = vi.fn<BSpawn>();
    const r = await runHeadless(baseOpts(s, spawn, async () => false));
    expect(r).toBe('refused');
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(s.outDir)).toBe(false);
    expect(existsSync(join(s.evalDir, 'live'))).toBe(false);
    expect(s.out.join('\n')).toContain(join(s.folder, ''));
    expect(s.out.join('\n')).not.toContain(KEY);
  });

  it('spawns --resume --fork-session with the tidy plugin copy, records headless true on the hook marker, key only in env', async () => {
    const s = setup();
    let argv: string[] = [];
    let spawnEnv: NodeJS.ProcessEnv = {};
    let newId = '';
    const spawn: BSpawn = (a, o) => {
      argv = a;
      spawnEnv = o.env;
      newId = a[a.indexOf('--session-id') + 1];
      writeFileSync(join(s.folder, `${newId}.jsonl`), [...s.sourceLines, ...compacted('S1\nS2')].join('\n') + '\n');
      writeFileSync(join(s.evalDir, 'live', `marker-${newId}.txt`), 'trimmed to 3/9 messages (50% reduction; prose: 4 scored, 1 dropped)');
      return { status: 0, stdout: 'done', stderr: '' };
    };
    const r = await runHeadless(baseOpts(s, spawn, async () => true));
    expect(r).not.toBe('refused');
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).not.toBe(s.src);
    expect(argv[argv.indexOf('--resume') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv).toContain('--fork-session');
    expect(argv).toContain('/compact');
    const copy = join(s.evalDir, 'live', 'tidy');
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe(copy);
    expect(JSON.parse(readFileSync(join(copy, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig.proseTrim.default).toBe('tidy');
    expect(existsSync(join(copy, 'hooks'))).toBe(true);
    expect(spawnEnv.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).toBe('1');
    expect(spawnEnv.TYPESAFE_API_KEY).toBe(KEY);
    expect(argv.join(' ')).not.toContain(KEY);
    const mode = JSON.parse(readFileSync(join(s.outDir, 'b-mode.json'), 'utf8'));
    expect(mode.headless).toBe(true);
    expect(typeof mode.evidence).toBe('string');
    expect(mode.forkPath).toBe(join(s.folder, `${newId}.jsonl`));
    const b = JSON.parse(readFileSync(join(s.outDir, 'b', 'case-9.json'), 'utf8'));
    expect(b).toEqual({ caseId: 'case-9', mode: 'headless', summary: ['S1', 'S2'], keptMessages: 2 });
    for (const f of [join(s.outDir, 'b-mode.json'), join(s.outDir, 'b', 'case-9.json')]) expect(readFileSync(f, 'utf8')).not.toContain(KEY);
    expect(s.out.join('\n')).not.toContain(KEY);
  });

  it('records headless false when the fork compacted without the hook summary', async () => {
    const s = setup();
    const spawn: BSpawn = (a) => {
      writeFileSync(join(s.folder, `${a[a.indexOf('--session-id') + 1]}.jsonl`), [...s.sourceLines, ...compacted('S')].join('\n') + '\n');
      return { status: 0, stdout: 'done', stderr: '' };
    };
    await runHeadless(baseOpts(s, spawn, async () => true));
    const mode = JSON.parse(readFileSync(join(s.outDir, 'b-mode.json'), 'utf8'));
    expect(mode.headless).toBe(false);
    expect(mode.evidence).toMatch(/boundary/);
  });

  const forkWith = (s: ReturnType<typeof setup>, extra: string[]): BSpawn => (a) => {
    writeFileSync(join(s.folder, `${a[a.indexOf('--session-id') + 1]}.jsonl`), [...s.sourceLines, ...extra].join('\n') + '\n');
    return { status: 0, stdout: 'done', stderr: '' };
  };

  const forkMarker = (s: ReturnType<typeof setup>, extra: string[], text?: string): BSpawn => (a) => {
    writeFileSync(join(s.folder, `${idOf(a)}.jsonl`), [...s.sourceLines, ...extra].join('\n') + '\n');
    if (text !== undefined) writeFileSync(markerOf(s, a), text);
    return { status: 0, stdout: 'done', stderr: '' };
  };

  it('ignores a hook toast and an old boundary that were only copied from the source history', async () => {
    const s = setup('synthetic', [user('trimmed to 3/9 messages (prose: 3 scored, 0 dropped)'), ...compacted('OLD')]);
    await runHeadless(baseOpts(s, forkWith(s, []), async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(existsSync(join(s.outDir, 'b'))).toBe(false);
  });

  it('is not headless when the only hook-like text is in a new summary record, stdout and stderr, with no marker file', async () => {
    const s = setup();
    const forged = 'prose: 3 scored; trimmed to 2/9 messages; skipped (x); fallback to built-in summary (x)';
    const spawn: BSpawn = (a) => {
      writeFileSync(join(s.folder, `${idOf(a)}.jsonl`), [...s.sourceLines, ...compacted(forged)].join('\n') + '\n');
      return { status: 0, stdout: forged, stderr: forged };
    };
    await runHeadless(baseOpts(s, spawn, async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(modeOf(s).evidence).toMatch(/no fast-jev hook marker/);
  });

  it('is headless with "trim succeeded" when the marker says prose: 3 scored and a new boundary exists', async () => {
    const s = setup();
    await runHeadless(baseOpts(s, forkMarker(s, compacted('NEW'), 'prose: 3 scored'), async () => true));
    expect(modeOf(s).headless).toBe(true);
    expect(modeOf(s).evidence).toMatch(/trim succeeded/);
  });

  it('reports the fallback outcome when the marker text is a fallback toast', async () => {
    const s = setup();
    await runHeadless(baseOpts(s, forkMarker(s, compacted('NEW'), 'fallback to built-in summary (request failed)'), async () => true));
    expect(modeOf(s).headless).toBe(true);
    expect(modeOf(s).evidence).toMatch(/fell back/);
  });

  it('is not headless when the marker exists but the fork has no new boundary', async () => {
    const s = setup();
    await runHeadless(baseOpts(s, forkMarker(s, [user('later')], 'prose: 3 scored'), async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(modeOf(s).evidence).toMatch(/no new compact boundary/);
  });

  it('instruments only the copy: the marker line appears once inside notify and the repo hook is byte-identical', async () => {
    const hash = () => createHash('sha256').update(readFileSync(join(REPO, 'hooks', 'fast-jev.ts'))).digest('hex');
    const before = hash();
    const s = setup();
    let id = '';
    await runHeadless(baseOpts(s, (a) => { id = idOf(a); return forkMarker(s, [], undefined)(a, { cwd: '', env: {} }); }, async () => true));
    expect(hash()).toBe(before);
    const copied = readFileSync(join(s.evalDir, 'live', 'tidy', 'hooks', 'fast-jev.ts'), 'utf8');
    const markerLines = copied.split('\n').filter((l) => l.includes(join(s.evalDir, 'live', `marker-${id}.txt`)));
    expect(markerLines).toHaveLength(1);
    expect(markerLines[0]).toContain('.fs.write(');
    expect(markerLines[0]).not.toContain('?.');
    expect(copied).not.toContain('?.(');
    const notify = copied.slice(copied.indexOf('function notify('));
    expect(notify.slice(0, notify.indexOf('\n}\n'))).toContain(markerLines[0]);
    expect(notify.indexOf('  log($, text);\n' + markerLines[0])).toBeGreaterThan(0);
    expect(readFileSync(join(REPO, 'hooks', 'fast-jev.ts'), 'utf8')).not.toContain('marker-');
  });

  it('is headless when a fork shorter than the source (sidechain and uuid-less records dropped) has a new boundary and the marker', async () => {
    const side = Array.from({ length: 8 }, (_, i) => user(`side ${i}`, { isSidechain: true }));
    const s = setup('synthetic', [...side, JSON.stringify({ type: 'summary', summary: 'meta' }), JSON.stringify({ type: 'file-history-snapshot' })]);
    const spawn: BSpawn = (a) => {
      writeFileSync(join(s.folder, `${idOf(a)}.jsonl`), [s.sourceLines[0], ...compacted('NEW'), JSON.stringify({ type: 'summary', summary: 'meta2' })].join('\n') + '\n');
      writeFileSync(markerOf(s, a), 'prose: 3 scored');
      return { status: 0, stdout: 'done', stderr: '' };
    };
    await runHeadless(baseOpts(s, spawn, async () => true));
    expect(s.sourceLines.length).toBeGreaterThan(readFileSync(modeOf(s).forkPath, 'utf8').split('\n').filter(Boolean).length);
    expect(modeOf(s).headless).toBe(true);
    expect(modeOf(s).evidence).toMatch(/trim succeeded/);
  });

  it('is not headless when the fork only copies a boundary already in the source, even with the marker', async () => {
    const hist = compacted('OLD');
    const s = setup('synthetic', hist);
    await runHeadless(baseOpts(s, forkMarker(s, [], 'prose: 3 scored'), async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(modeOf(s).evidence).toMatch(/no new compact boundary/);
  });

  it('does not spawn when the copy has no notify anchor', async () => {
    const s = setup();
    const repo = join(s.dir, 'repo');
    for (const d of ['.claude-plugin', 'hooks', 'src', 'types']) cpSync(join(REPO, d), join(repo, d), { recursive: true });
    const hook = join(repo, 'hooks', 'fast-jev.ts');
    writeFileSync(hook, readFileSync(hook, 'utf8').replace('  log($, text);', '  log($, String(text));'));
    const spawn = vi.fn<BSpawn>();
    await expect(runHeadless({ ...baseOpts(s, spawn, async () => true), repoDir: repo })).rejects.toThrow(/notify/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('records headless false and no b file when only an old boundary exists and the new /compact failed', async () => {
    const s = setup('synthetic', compacted('OLD'));
    await runHeadless(baseOpts(s, forkWith(s, [user('later')]), async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(modeOf(s).evidence).toMatch(/no new compact boundary/);
    expect(existsSync(join(s.outDir, 'b', 'case-9.json'))).toBe(false);
  });

  it('refuses without a key, or an unknown case id, before asking or spawning', async () => {
    const s = setup();
    const manifestPath = join(s.dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ cutoffMs: 0, files: [] }));
    const spawn = vi.fn<BSpawn>();
    const confirm = vi.fn(async () => true);
    await expect(runHeadless({ ...baseOpts(s, spawn, confirm), env: {} })).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(runHeadless({ ...baseOpts(s, spawn, confirm), case: 'nope#0-1', manifestPath })).rejects.toThrow(/not found/);
    expect(confirm).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(s.dir).sort()).toEqual(['manifest.json', 'projects', 'work']);
    expect(readdirSync(s.folder)).toEqual([`${s.src}.jsonl`]);
  });

  it('resolves a case id against the manifest', async () => {
    const hist = setup('synthetic', compacted('S'));
    const m2 = join(hist.dir, 'manifest.json');
    const f2 = join(hist.folder, `${hist.src}.jsonl`);
    writeFileSync(m2, JSON.stringify({ cutoffMs: 0, files: [{ path: f2, mtimeMs: 0, sha256: createHash('sha256').update(readFileSync(f2)).digest('hex') }] }));
    let argv: string[] = [];
    const spawn: BSpawn = (a) => { argv = a; return { status: 0, stdout: '', stderr: '' }; };
    await runHeadless({ ...baseOpts(hist, spawn, async () => true), case: `${hist.src}#0-3`, manifestPath: m2 });
    expect(argv).toContain('--resume');
    expect(readdirSync(hist.folder)).toEqual([`${hist.src}.jsonl`]);
  });
});

describe('cutCopy and the cut run', () => {
  // Source: m0 (cwd line), q1 a1 | boundary#1 at 3 | summary, q2 a2 (+ a sidechain) | boundary#2 at 5 | summary, tail1.
  const twoBoundaries = () => {
    const h = [
      user('q1', { sessionId: 'old' }), asst('a1'), boundary(), user('S1', { isCompactSummary: true, sessionId: 'old' }),
      user('side', { isSidechain: true }), user('q2'), asst('a2'), 'not json {', boundary(), user('S2', { isCompactSummary: true }), user('tail1'),
    ];
    const s = setup('synthetic', h);
    const file = join(s.folder, `${s.src}.jsonl`);
    const t = loadTranscript({ path: file, mtimeMs: 0, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
    return { s, t, file };
  };
  const hashOf = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

  it('cuts at the second boundary: end messages, same last segment, nothing from the boundary on, every sessionId is the cut id', () => {
    const { s, t, file } = twoBoundaries();
    expect(t.boundaries.map((b) => b.at)).toEqual([3, 5]);
    const c: Case = { ...s.theCase, start: 3, end: 5 };
    const { cutId, path } = cutCopy(c);
    expect(path).toBe(join(s.folder, `${cutId}.jsonl`));
    const cut = loadTranscript({ path, mtimeMs: 0, sha256: hashOf(path) });
    expect(cut.messages).toHaveLength(5);
    expect(cut.messages.slice(3)).toEqual(t.messages.slice(3, 5));
    expect(cut.boundaries).toHaveLength(1);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(lines.some((l) => l.includes('S2') || l.includes('tail1') || l.includes('not json'))).toBe(false);
    expect(lines.some((l) => l.includes('"side"'))).toBe(true);
    const ids = lines.map((l) => JSON.parse(l).sessionId).filter((x) => x !== undefined);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([cutId]));
    expect(readFileSync(file, 'utf8')).toContain('"sessionId":"old"');
  });

  it('keeps every parseable line for a tail case', () => {
    const { s, file } = twoBoundaries();
    const { path } = cutCopy(s.theCase);
    const want = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && l !== 'not json {');
    const got = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(got).toHaveLength(want.length);
    expect(got.map((l) => JSON.parse(l).uuid)).toEqual(want.map((l) => JSON.parse(l).uuid));
  });

  it('throws and leaves no file when the end matches no boundary', () => {
    const { s } = twoBoundaries();
    const before = readdirSync(s.folder).sort();
    expect(() => cutCopy({ ...s.theCase, start: 0, end: 4 })).toThrow(/no compact boundary at message 4/);
    expect(readdirSync(s.folder).sort()).toEqual(before);
  });

  const cutRun = (s: ReturnType<typeof setup>, c: Case, spawn: BSpawn, confirm: (q: string) => Promise<boolean> = async () => true) =>
    runHeadless({ ...baseOpts(s, spawn, confirm), case: c });

  it('resumes the cut copy, and removes it after the run', async () => {
    const { s } = twoBoundaries();
    const c: Case = { ...s.theCase, start: 3, end: 5 };
    let resumed = '';
    let existedDuring = false;
    const spawn: BSpawn = (a) => {
      resumed = a[a.indexOf('--resume') + 1];
      existedDuring = existsSync(join(s.folder, `${resumed}.jsonl`));
      return { status: 0, stdout: '', stderr: '' };
    };
    await cutRun(s, c, spawn);
    expect(resumed).not.toBe(s.src);
    expect(existedDuring).toBe(true);
    expect(existsSync(join(s.folder, `${resumed}.jsonl`))).toBe(false);
    expect(readdirSync(s.folder)).toEqual([`${s.src}.jsonl`]);
  });

  it('removes the cut copy when the spawn throws', async () => {
    const { s } = twoBoundaries();
    const spawn: BSpawn = () => { throw new Error('boom'); };
    await expect(cutRun(s, { ...s.theCase, start: 3, end: 5 }, spawn)).rejects.toThrow(/boom/);
    expect(readdirSync(s.folder)).toEqual([`${s.src}.jsonl`]);
  });

  it('creates no copy when the confirm is refused', async () => {
    const { s } = twoBoundaries();
    const spawn = vi.fn<BSpawn>();
    expect(await cutRun(s, { ...s.theCase, start: 3, end: 5 }, spawn, async () => false)).toBe('refused');
    expect(readdirSync(s.folder)).toEqual([`${s.src}.jsonl`]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not count fork records whose uuid is in the cut copy as new', async () => {
    const { s } = twoBoundaries();
    const c: Case = { ...s.theCase, start: 3, end: 5 };
    const spawn: BSpawn = (a) => {
      const cutLines = readFileSync(join(s.folder, `${a[a.indexOf('--resume') + 1]}.jsonl`), 'utf8');
      writeFileSync(join(s.folder, `${idOf(a)}.jsonl`), cutLines);
      writeFileSync(markerOf(s, a), 'prose: 3 scored');
      return { status: 0, stdout: '', stderr: '' };
    };
    await cutRun(s, c, spawn);
    expect(modeOf(s).headless).toBe(false);
    expect(modeOf(s).evidence).toMatch(/no new compact boundary/);
  });
});
