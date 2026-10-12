import { describe, expect, it } from 'vitest';
import { compactSession } from '../hooks/fast-jev.ts';
import type { SessionMessage } from '../src/types.js';

const message = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  role,
  text,
  toolUses: [],
  ...extra,
});
const call = (id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage =>
  message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }], handle: `h-${id}` });
const result = (id: string, text: string): SessionMessage =>
  message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }], handle: `r-${id}` });

const BIG = 'export const value = 1;\n'.repeat(2000); // 48,000 chars, dropped by tool compaction
const FLUFF = 'Let me take a careful look at how this module is laid out before changing anything.';
const KEPT = 'The cache key lives in src/cache/key.ts and must not change.';
const REPLY = `${Array(12).fill(FLUFF).join(' ')} ${KEPT}`;

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the stale cache.', { handle: 'u-0' }),
    call('rd1', 'Read', { file_path: 'src/big.ts' }, BIG),
    result('rd1', BIG),
    message('assistant', REPLY, { handle: 'a-1' }),
    message('user', 'first recent prompt', { handle: 'u-2' }),
    message('assistant', 'ok', { handle: 'a-3' }),
    message('user', 'second recent prompt', { handle: 'u-4' }),
    message('assistant', 'ok', { handle: 'a-5' }),
  ];
}

const isProse = (key: string) => /^c\d+$/.test(key);
function fetchWith(prose: number | 'fail', requests: string[][] = []) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const keys = Object.keys(questions);
    requests.push(keys);
    if (prose === 'fail' && keys.some(isProse)) return { status: 500, ok: false, text: 'down' };
    const answers = Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: isProse(k) ? prose : 0.01 }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}
function archive() {
  const files = new Map<string, string>();
  const pathOf = (id: string) => `arch/${id}.txt`;
  return { files, pathOf, cite: (id: string, text: string) => (files.set(id, text), pathOf(id)), flush: async () => {} };
}
const config = (extra: Record<string, unknown> = {}) => ({
  apiKey: 'k',
  preserveRecentMessages: 2,
  minReductionRatio: 0.25,
  archiveResults: true,
  proseTrim: true,
  ...extra,
});
const replyOf = (messages: readonly SessionMessage[]) => messages.find((m) => m.role === 'assistant' && m.text.includes('src/cache/key.ts'));

describe('replyTrim: old replies trimmed on every compaction', () => {
  it('trims an old reply after tool compaction already met the minimum, keeping protected clauses and archiving the original', async () => {
    const a = archive();
    const requests: string[][] = [];
    const out = await compactSession(transcript(), config() as never, fetchWith(0.01, requests), a);
    const reply = replyOf(out.messages)!;
    expect(reply.text).toContain(KEPT);
    expect(reply.text).not.toContain(FLUFF);
    expect(reply.text).toMatch(/\[fast-jev-compaction trimmed [\d,]+ chars of this reply; full text: arch\/reply-[0-9a-f]{12}\.txt/);
    expect([...a.files.values()]).toContain(REPLY);
    expect(reply.text).not.toContain(REPLY);
    expect(out.prose?.cutoff).toBe(0.05);
    expect(requests.filter((keys) => keys.some(isProse))).toHaveLength(1);
    // The recent rows are never scored or changed.
    expect(out.messages.slice(-4).map((m) => m.text)).toEqual(['first recent prompt', 'ok', 'second recent prompt', 'ok']);
  });

  it('keeps a clause Jev scores at or above the cut-off', async () => {
    const out = await compactSession(transcript(), config() as never, fetchWith(0.05), archive());
    expect(replyOf(out.messages)!.text).toContain(REPLY);
    expect(out.prose?.stats.dropped).toBe(0);
  });

  it('changes nothing when replyTrim is off, without an archive, or when proseTrim is off', async () => {
    for (const [extra, withArchive] of [
      [{ replyTrim: false }, true],
      [{ archiveResults: false }, false],
      [{ proseTrim: false }, true],
    ] as const) {
      const requests: string[][] = [];
      const out = await compactSession(transcript(), config(extra) as never, fetchWith(0.01, requests), withArchive ? archive() : undefined);
      expect(replyOf(out.messages)!.text).toContain(REPLY);
      expect(requests.filter((keys) => keys.some(isProse))).toHaveLength(0);
    }
  });

  it('keeps tool compaction’s result when the reply request fails', async () => {
    const a = archive();
    const out = await compactSession(transcript(), config() as never, fetchWith('fail'), a);
    expect(replyOf(out.messages)!.text).toContain(REPLY);
    expect(out.prose?.stats.failed).toBeDefined();
    expect([...a.files.keys()].some((id) => id.startsWith('reply-'))).toBe(false);
  });
});
