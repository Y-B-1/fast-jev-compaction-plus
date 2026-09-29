import { mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Hook input too large');
    chunks.push(Buffer.from(chunk));
  }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const data = process.env.FAST_JEV_DATA ?? join(homedir(), '.codex', 'fast-jev-compaction');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const bridge = Boolean(process.env.FAST_JEV_COMPACTION_ADAPTER);
  await appendFile(join(data, 'hooks.jsonl'), JSON.stringify({ time: new Date().toISOString(), event: event.hook_event_name, session_id: event.session_id, bridge }) + '\n', { mode: 0o600 });
  if (event.hook_event_name === 'SessionStart' && !bridge) {
    process.stdout.write(JSON.stringify({ systemMessage: 'Fast Jev compaction needs the installed Codex runtime launcher; this process uses native compaction.' }));
  }
}
main().catch(() => process.stderr.write('Fast Jev lifecycle status unavailable.\n'));
