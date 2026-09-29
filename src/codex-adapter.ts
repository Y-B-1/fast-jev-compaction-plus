import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JevClient } from './client.js';
import { compactCodexItems, type CodexItem } from './codex.js';
import { redactCompactionState, redactText } from './redact.js';
import type { CompactOptions, JevAsker } from './types.js';

const data = process.env.FAST_JEV_DATA ?? join(homedir(), '.codex', 'fast-jev-compaction');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('SIGINT', () => controller.abort());

async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) throw new Error('Compaction input exceeds 32 MiB');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.version !== 1 || !Array.isArray(input.items) || typeof input.session_id !== 'string') throw new Error('Unsupported native compaction bridge input');
  if (input.items.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('Invalid history items');
  let apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const credentials = JSON.parse(await readFile(join(data, 'credentials.json'), 'utf8'));
    if (credentials.provider !== 'openrouter' || typeof credentials.apiKey !== 'string') throw new Error('Configure an OpenRouter key for fast compaction');
    apiKey = credentials.apiKey;
  }
  let options: CompactOptions & { minReductionRatio?: number } = {};
  try { options = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const archiveDir = join(data, 'archives', createHash('sha256').update(input.session_id).digest('hex').slice(0, 24));
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const client = new JevClient({ apiKey, signal: controller.signal });
  const jev: JevAsker = { ask: (state, questions) => client.ask(redactCompactionState(state, apiKey), redactCompactionState(questions, apiKey)) };
  const result = await compactCodexItems(input.items as CodexItem[], jev, {
    ...options,
    archive(id, output) {
      const redacted = redactText(output, apiKey);
      const digest = createHash('sha256').update(id + '\0' + redacted).digest('hex');
      const path = join(archiveDir, digest + '.txt');
      try { writeFileSync(path, redacted, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return path;
    },
  });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writeFile(join(data, 'last-attempt.json'), JSON.stringify({ time: new Date().toISOString(), session_id: input.session_id, edits: result.edits.length, ...result.stats }) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(result));
}

main().catch(() => {
  // Provider error bodies can contain secrets; let the native bridge fall back.
  process.stderr.write('Fast Jev compaction unavailable; using native fallback.\n');
  process.stdout.write(JSON.stringify({ version: 1, skip: true }));
});
