// Dev-only T10 spike: does `claude -p --resume <id> --fork-session` running /compact run session.compact hooks?
// Also turns a compacted transcript into the fixed B result. Never reads a key from anywhere but process.env.TYPESAFE_API_KEY;
// the key goes only into the child's env, never into argv, output or files. Transcript text is never printed.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadTranscript } from './load.js';

export interface BResult {
  caseId: string;
  mode: 'headless' | 'hand';
  summary: string[];
  keptMessages: number;
}
export interface BMode {
  headless: boolean;
  evidence: string;
  forkPath: string;
}
export type BSpawn = (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { status: number | null; stdout: string; stderr: string };

/**
 * Last compact boundary of a compacted transcript: summary lines (non-blank) and keptMessages.
 * Real transcripts point at the kept messages with compactMetadata.preservedMessages.uuids (keptMessages is the count of user and
 * assistant records in that list) or compactMetadata.preservedSegment {headUuid, anchorUuid, tailUuid};
 * they lie BEFORE the boundary, so for a segment keptMessages is the main-thread message count from the head record to the tail record.
 * Without a usable segment it falls back to the messages after the boundary (the synthetic and hand shape).
 */
export function parseCompacted(file: string, caseId: string, mode: BResult['mode']): BResult {
  const text = readFileSync(file);
  const t = loadTranscript({ path: file, mtimeMs: 0, sha256: createHash('sha256').update(text).digest('hex') });
  const last = t.boundaries[t.boundaries.length - 1];
  if (!last) throw new Error(`no compact boundary in ${file}`);
  if (last.summary === undefined) throw new Error(`no summary after the compact boundary in ${file}`);
  return { caseId, mode, summary: last.summary.split('\n').filter((l) => l.trim()), keptMessages: preservedCount(text.toString('utf8')) ?? t.messages.length - last.at };
}

function preservedCount(raw: string): number | undefined {
  const lines = raw.split('\n').filter((l) => l.trim());
  const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } });
  const b = recs.map((r, i) => (r?.type === 'system' && r.subtype === 'compact_boundary' && !r.isSidechain ? i : -1)).filter((i) => i >= 0).pop();
  const uuids = b === undefined ? undefined : recs[b].compactMetadata?.preservedMessages?.uuids;
  if (Array.isArray(uuids)) {
    const keep = new Set<unknown>(uuids);
    return recs.filter((r) => keep.has(r?.uuid) && (r?.type === 'user' || r?.type === 'assistant')).length;
  }
  const seg = b === undefined ? undefined : recs[b].compactMetadata?.preservedSegment;
  if (typeof seg?.headUuid !== 'string' || typeof seg?.tailUuid !== 'string') return undefined;
  const head = recs.findIndex((r) => r?.uuid === seg.headUuid);
  const tail = recs.findIndex((r) => r?.uuid === seg.tailUuid);
  if (head < 0 || tail < head) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'fjev-seg-'));
  try {
    const slice = join(dir, 'segment.jsonl');
    const body = lines.slice(head, tail + 1).join('\n');
    writeFileSync(slice, body);
    return loadTranscript({ path: slice, mtimeMs: 0, sha256: createHash('sha256').update(body).digest('hex') }).messages.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** y or yes (any case) is true; anything else, or a closed stream, is false. */
export function confirmFromStream(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<boolean> {
  const rl = createInterface({ input, output });
  return new Promise((done) => {
    rl.once('close', () => done(false));
    rl.question(`${question} [y/N] `, (a) => {
      done(/^y(es)?$/i.test(a.trim()));
      rl.close();
    });
  });
}

const realSpawn: BSpawn = (argv, { cwd, env }) => {
  const r = spawnSync('claude', argv, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = join(homedir(), '.claude', 'fast-jev-eval');

/**
 * Same copy as live-compact.sh: the copy's userConfig.proseTrim.default is patched to tidy, and its notify() writes its text to
 * `marker` (run-unique, so model text can never forge it). The repo's own hook is never touched; a missing or repeated anchor throws.
 */
function copyTidyPlugin(evalDir: string, marker: string, repo = REPO): string {
  const copy = join(evalDir, 'live', 'tidy');
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  for (const dir of ['.claude-plugin', 'hooks', 'src', 'types']) cpSync(join(repo, dir), join(copy, dir), { recursive: true });
  const manifest = join(copy, '.claude-plugin', 'plugin.json');
  const json = JSON.parse(readFileSync(manifest, 'utf8'));
  json.userConfig.proseTrim.default = 'tidy';
  writeFileSync(manifest, JSON.stringify(json, null, 2) + '\n');
  const hook = join(copy, 'hooks', 'fast-jev.ts');
  const src = readFileSync(hook, 'utf8');
  const start = src.indexOf('function notify(');
  const body = start < 0 || src.indexOf('function notify(', start + 1) >= 0 ? undefined : src.slice(start, src.indexOf('\n}\n', start));
  const anchor = '  log($, text);';
  if (body === undefined || body.split(anchor).length !== 2) throw new Error(`cannot instrument the plugin copy: "${anchor}" not found exactly once inside notify() in hooks/fast-jev.ts`);
  const at = start + body.indexOf(anchor) + anchor.length;
  // The hook loader rejects `?.(` and silently loads no hooks, so the inserted line must not use it.
  const probe = `\n  try { void ($ as any).fs.write(${JSON.stringify(marker)}, text).catch(() => {}); } catch {}`;
  writeFileSync(hook, src.slice(0, at) + probe + src.slice(at));
  return copy;
}

export interface HeadlessOptions {
  sourceId: string;
  caseId: string;
  projectsDir?: string;
  evalDir?: string;
  repoDir?: string;
  outDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: BSpawn;
  confirm?: (question: string) => Promise<boolean>;
  print?: (message: string) => void;
}

/**
 * Detection: the instrumented plugin copy writes fast-jev's notify text to a marker file named for the fork's new session id.
 * The hook ran iff that file exists; its text, not model output, says whether the trim succeeded. Only fork records whose uuid is not
 * in the source (read just before the spawn), written by this run, count for the boundary; a fork drops non-main-chain records. A compact boundary alone proves /compact ran, not the hook.
 */
const TRIM_SIGNAL = /prose: \d+ scored|^trimmed to \d+\/\d+ messages/;
const recordLines = (raw: string) => raw.split('\n').filter((l) => l.trim());
const uuidOf = (l: string) => { try { const u = JSON.parse(l).uuid; return typeof u === 'string' ? u : undefined; } catch { return undefined; } };
const isBoundary = (l: string) => { try { const o = JSON.parse(l); return o.type === 'system' && o.subtype === 'compact_boundary'; } catch { return false; } };

export async function runHeadless(o: HeadlessOptions): Promise<'refused' | BMode> {
  const env = o.env ?? process.env;
  const print = o.print ?? ((m: string) => console.log(m));
  const projectsDir = o.projectsDir ?? join(homedir(), '.claude', 'projects');
  const evalDir = o.evalDir ?? EVAL_DIR;
  const outDir = o.outDir ?? join(evalDir, 'out');
  if (!env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is not set in the environment');
  const folder = readdirSync(projectsDir, { withFileTypes: true }).find((d) => d.isDirectory() && existsSync(join(projectsDir, d.name, `${o.sourceId}.jsonl`)));
  if (!folder) throw new Error(`source session ${o.sourceId} not found under ${projectsDir}`);
  const sourceFile = join(projectsDir, folder.name, `${o.sourceId}.jsonl`);
  const cwd = readFileSync(sourceFile, 'utf8').split('\n').map((l) => { try { return JSON.parse(l).cwd; } catch { return undefined; } }).find((c) => typeof c === 'string');
  if (!cwd) throw new Error('source session records no cwd');
  const newId = randomUUID();
  const forkPath = join(projectsDir, folder.name, `${newId}.jsonl`);
  print(`The fork will write: ${forkPath}`);
  if (!(await (o.confirm ?? ((q) => confirmFromStream(q)))('Run claude -p --resume --fork-session with /compact on this session?'))) return 'refused';

  const sourceUuids = new Set(recordLines(readFileSync(sourceFile, 'utf8')).map(uuidOf));
  const marker = join(evalDir, 'live', `marker-${newId}.txt`);
  const copy = copyTidyPlugin(evalDir, marker, o.repoDir);
  rmSync(marker, { force: true });
  const argv = ['-p', '/compact', '--resume', o.sourceId, '--fork-session', '--session-id', newId, '--setting-sources', 'project,local', '--plugin-dir', copy, '--output-format', 'stream-json', '--verbose'];
  const r = (o.spawn ?? realSpawn)(argv, { cwd, env: { ...env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });
  const forked = existsSync(forkPath);
  const fresh = forked ? recordLines(readFileSync(forkPath, 'utf8')).filter((l) => { const u = uuidOf(l); return u !== undefined && !sourceUuids.has(u); }) : [];
  const hasBoundary = fresh.some(isBoundary);
  const hook = existsSync(marker);
  const outcome = hook && TRIM_SIGNAL.test(readFileSync(marker, 'utf8').trim()) ? 'trim succeeded' : 'fell back to the built-in summary or skipped';
  const mode: BMode = {
    headless: hook && hasBoundary,
    evidence: !hasBoundary
      ? `no new compact boundary in fork (claude exit ${r.status}${forked ? '' : ', no fork file'}${hook ? '; hook marker seen' : ''})`
      : hook
        ? `fast-jev hook marker written and new compact boundary in fork (${outcome})`
        : 'new compact boundary in fork, no fast-jev hook marker',
    forkPath,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'b-mode.json'), JSON.stringify(mode, null, 2) + '\n');
  if (hasBoundary) {
    mkdirSync(join(outDir, 'b'), { recursive: true });
    writeFileSync(join(outDir, 'b', `${o.caseId}.json`), JSON.stringify(parseCompacted(forkPath, o.caseId, 'headless'), null, 2) + '\n');
  }
  print(`headless ${mode.headless}: ${mode.evidence}`);
  return mode;
}

// CLI: `npx tsx eval/b-runner.ts headless <source session id> --case <id>` or `--from-transcript <jsonl> --case <id>`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  const caseId = args.includes('--case') ? flag('--case') : undefined;
  if (!caseId) throw new Error('usage: b-runner.ts headless <session id> --case <id> | --from-transcript <jsonl> --case <id>');
  if (args.includes('--from-transcript')) {
    const result = parseCompacted(flag('--from-transcript'), caseId, 'hand');
    const dir = join(EVAL_DIR, 'out', 'b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${caseId}.json`), JSON.stringify(result, null, 2) + '\n');
    console.log(`wrote ${join(dir, `${caseId}.json`)} (${result.summary.length} summary lines, ${result.keptMessages} kept)`);
  } else if (args[0] === 'headless' && args[1] && !args[1].startsWith('--')) {
    await runHeadless({ sourceId: args[1], caseId });
  } else throw new Error('usage: b-runner.ts headless <session id> --case <id> | --from-transcript <jsonl> --case <id>');
}
