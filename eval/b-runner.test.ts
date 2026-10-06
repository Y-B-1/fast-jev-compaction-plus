import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { confirmFromStream, parseCompacted, runHeadless, type BSpawn } from './b-runner.js';

const root = mkdtempSync(join(tmpdir(), 'fjev-b-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
vi.stubGlobal('fetch', () => {
  throw new Error('network is off in tests');
});
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
  return { dir, projects, folder, src, sourceLines, evalDir: join(dir, 'eval'), outDir: join(dir, 'eval', 'out'), out };
}

const baseOpts = (s: ReturnType<typeof setup>, spawn: BSpawn, confirm: (q: string) => Promise<boolean>) => ({
  sourceId: s.src, caseId: 'case-9', projectsDir: s.projects, evalDir: s.evalDir, outDir: s.outDir,
  env: { PATH: '/bin', TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv, spawn, confirm, print: (m: string) => s.out.push(m),
});

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

  it('spawns --resume --fork-session with the tidy plugin copy, records headless true on the hook summary, key only in env', async () => {
    const s = setup();
    let argv: string[] = [];
    let spawnEnv: NodeJS.ProcessEnv = {};
    let newId = '';
    const spawn: BSpawn = (a, o) => {
      argv = a;
      spawnEnv = o.env;
      newId = a[a.indexOf('--session-id') + 1];
      writeFileSync(join(s.folder, `${newId}.jsonl`), [...s.sourceLines, ...compacted('S1\nS2')].join('\n') + '\n');
      return { status: 0, stdout: 'trimmed to 3/9 messages (50% reduction; prose: 4 scored, 1 dropped)', stderr: '' };
    };
    const r = await runHeadless(baseOpts(s, spawn, async () => true));
    expect(r).not.toBe('refused');
    expect(argv).toContain('--resume');
    expect(argv[argv.indexOf('--resume') + 1]).toBe(s.src);
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
  const modeOf = (s: ReturnType<typeof setup>) => JSON.parse(readFileSync(join(s.outDir, 'b-mode.json'), 'utf8'));

  it('ignores a hook toast and an old boundary that were only copied from the source history', async () => {
    const s = setup('synthetic', [user('trimmed to 3/9 messages (prose: 3 scored, 0 dropped)'), ...compacted('OLD')]);
    await runHeadless(baseOpts(s, forkWith(s, []), async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(existsSync(join(s.outDir, 'b'))).toBe(false);
  });

  it('records headless false and no b file when only an old boundary exists and the new /compact failed', async () => {
    const s = setup('synthetic', compacted('OLD'));
    await runHeadless(baseOpts(s, forkWith(s, [user('later')]), async () => true));
    expect(modeOf(s).headless).toBe(false);
    expect(modeOf(s).evidence).toMatch(/no new compact boundary/);
    expect(existsSync(join(s.outDir, 'b', 'case-9.json'))).toBe(false);
  });

  it('records headless true with fallback evidence on a new fast-jev fallback toast', async () => {
    const s = setup();
    const fallback = line({ type: 'system', subtype: 'info', content: 'fallback to built-in summary (request failed)' });
    await runHeadless(baseOpts(s, forkWith(s, [fallback, ...compacted('NEW')]), async () => true));
    const mode = modeOf(s);
    expect(mode.headless).toBe(true);
    expect(mode.evidence).toMatch(/fell back/);
    expect(JSON.parse(readFileSync(join(s.outDir, 'b', 'case-9.json'), 'utf8')).summary).toEqual(['NEW']);
  });

  it('refuses without a key, or a missing source, before asking or spawning', async () => {
    const s = setup();
    const spawn = vi.fn<BSpawn>();
    const confirm = vi.fn(async () => true);
    await expect(runHeadless({ ...baseOpts(s, spawn, confirm), env: {} })).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(runHeadless({ ...baseOpts(s, spawn, confirm), sourceId: 'nope' })).rejects.toThrow(/not found/);
    expect(confirm).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(s.dir).sort()).toEqual(['projects', 'work']);
  });
});
