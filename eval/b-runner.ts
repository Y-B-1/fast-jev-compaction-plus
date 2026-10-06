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
 * Real transcripts point at the kept messages with compactMetadata.preservedSegment {headUuid, anchorUuid, tailUuid};
 * they lie BEFORE the boundary, so keptMessages is the main-thread message count from the head record to the tail record.
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

/** Same copy as live-compact.sh: only the copy's userConfig.proseTrim.default is patched. */
function copyTidyPlugin(evalDir: string): string {
  const copy = join(evalDir, 'live', 'tidy');
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  for (const dir of ['.claude-plugin', 'hooks', 'src', 'types']) cpSync(join(REPO, dir), join(copy, dir), { recursive: true });
  const manifest = join(copy, '.claude-plugin', 'plugin.json');
  const json = JSON.parse(readFileSync(manifest, 'utf8'));
  json.userConfig.proseTrim.default = 'tidy';
  writeFileSync(manifest, JSON.stringify(json, null, 2) + '\n');
  return copy;
}

export interface HeadlessOptions {
  sourceId: string;
  caseId: string;
  projectsDir?: string;
  evalDir?: string;
  outDir?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: BSpawn;
  confirm?: (question: string) => Promise<boolean>;
  print?: (message: string) => void;
}

/**
 * Detection signal: any toast fast-jev's session.compact handler emits ("prose: N scored" on a trim, else "trimmed to", "kept N/M",
 * "skipped (" or "fallback to built-in summary ("), found in the child's stdout/stderr or in NEW fork records only.
 * A fork copies the source history, so records at or before the source's record count (and its old boundaries) are ignored;
 * only fork records past that count, written by this run, count. A compact boundary alone proves /compact ran, not the hook.
 */
const HOOK_SIGNAL = /prose: \d+ scored|trimmed to \d+\/\d+ messages|kept \d+\/\d+ messages, no summary|skipped \(|fallback to built-in summary \(/;
const TRIM_SIGNAL = /prose: \d+ scored/;
const recordLines = (raw: string) => raw.split('\n').filter((l) => l.trim());
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
  const sourceRecords = recordLines(readFileSync(sourceFile, 'utf8')).length;
  const newId = randomUUID();
  const forkPath = join(projectsDir, folder.name, `${newId}.jsonl`);
  print(`The fork will write: ${forkPath}`);
  if (!(await (o.confirm ?? ((q) => confirmFromStream(q)))('Run claude -p --resume --fork-session with /compact on this session?'))) return 'refused';

  const copy = copyTidyPlugin(evalDir);
  const argv = ['-p', '/compact', '--resume', o.sourceId, '--fork-session', '--session-id', newId, '--setting-sources', 'project,local', '--plugin-dir', copy, '--output-format', 'stream-json', '--verbose'];
  const r = (o.spawn ?? realSpawn)(argv, { cwd, env: { ...env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });
  const forked = existsSync(forkPath);
  const fresh = forked ? recordLines(readFileSync(forkPath, 'utf8')).slice(sourceRecords) : [];
  const hasBoundary = fresh.some(isBoundary);
  const seen = `${r.stdout}\n${r.stderr}\n${fresh.join('\n')}`;
  const hook = HOOK_SIGNAL.test(seen);
  const outcome = TRIM_SIGNAL.test(seen) ? 'trim succeeded' : 'fell back to the built-in summary or skipped';
  const mode: BMode = {
    headless: hook && hasBoundary,
    evidence: !hasBoundary
      ? `no new compact boundary in fork (claude exit ${r.status}${forked ? '' : ', no fork file'}${hook ? '; hook output seen' : ''})`
      : hook
        ? `fast-jev hook output in new output or new fork records (${outcome})`
        : 'new compact boundary in fork, no fast-jev hook output',
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
