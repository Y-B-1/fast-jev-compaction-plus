import { describe, expect, it } from 'vitest';
import { compactSession, contextBreakdown, formatBreakdown, resolveHookConfig } from '../hooks/fast-jev.ts';
import { COMPACTED_MARKER } from '../src/dedupe.js';
import { elideBody } from '../src/prose.js';
import { estimateTokens } from '../src/state.js';
import { compact, messageChars, resolveOptions, type JevAsker, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}
function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}
function result(id: string, text: string): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text }] });
}
function jev(answer: number, call = answer): JevAsker {
  return {
    async ask(_state, questions) {
      return {
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: k.startsWith('call_') ? call : answer }])),
      };
    },
  };
}
function jevFetch(answer: (name: string) => number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: answer(k) }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}
function archive() {
  const files = new Map<string, string>();
  return { files, cite: (id: string, text: string) => (files.set(`arch/${id}.txt`, text), `arch/${id}.txt`) };
}

const BIG = 'line of real output with detail\n'.repeat(400); // 12,800 chars
const tail = [message('assistant', 'Working.'), message('user', 'continue'), message('assistant', 'ok'), message('user', 'go')];

describe('defaults', () => {
  it('keeps a shorter head and salvage, and caps kept results at 4000 chars', () => {
    const o = resolveOptions();
    expect(o.truncateHeadChars).toBe(150);
    expect(o.salvageChars).toBe(150);
    expect(o.maxKeptResultChars).toBe(4000);
    expect(resolveOptions({ maxKeptResultChars: -5 }).maxKeptResultChars).toBe(0);
  });
});

describe('shorter truncation note', () => {
  it('cites the archive path without the extra wording', async () => {
    const a = archive();
    const out = await compact(
      [message('user', 'Find the bug.'), call('t1', 'Read', { file_path: 'a' }, BIG), result('t1', BIG), ...tail],
      jev(0.01, 0.9),
      { archive: a.cite, preserveRecentMessages: 4 },
    );
    const text = out.messages.flatMap((m) => m.toolResults ?? [])[0]!.text;
    expect(text).toContain(`${COMPACTED_MARKER}${BIG.length - 150} chars; full output: arch/t1.txt]`);
    expect(text).not.toContain('Read or grep');
  });
});

describe('cap on kept results', () => {
  const session = () => [message('user', 'Find the bug.'), call('t1', 'Read', { file_path: 'a' }, BIG), result('t1', BIG), ...tail];

  it('cuts a result Jev keeps whole to its first maxKeptResultChars and archives it', async () => {
    const a = archive();
    const out = await compact(session(), jev(0.9), { archive: a.cite, preserveRecentMessages: 4 });
    expect(out.decisions[0]!.action).toBe('keep');
    expect(out.stats.resultsCapped).toBe(1);
    const text = out.messages.flatMap((m) => m.toolResults ?? [])[0]!.text;
    expect(text.startsWith(BIG.slice(0, 4000))).toBe(true);
    expect(text).toContain(`${COMPACTED_MARKER}${BIG.length - 4000} chars; full output: arch/t1.txt]`);
    expect(text.length).toBeLessThan(4200);
    expect(a.files.get('arch/t1.txt')).toBe(BIG);
  });

  it('leaves kept results whole when the cap is 0, and never caps the newest messages', async () => {
    const off = await compact(session(), jev(0.9), { preserveRecentMessages: 4, maxKeptResultChars: 0 });
    expect(off.stats.resultsCapped).toBe(0);
    expect(off.messages.flatMap((m) => m.toolResults ?? [])[0]!.text).toBe(BIG);
    const pinned = await compact(session(), jev(0.9), { preserveRecentMessages: 6 });
    expect(pinned.messages.flatMap((m) => m.toolResults ?? [])[0]!.text).toBe(BIG);
  });
});

describe('elided bodies are never cut twice', () => {
  it('returns an already elided body unchanged', () => {
    const once = elideBody(BIG, 'Write.content for a.ts', 150, 150, 'arch/x.txt');
    expect(once).not.toBe(BIG);
    expect(elideBody(once, 'Write.content for a.ts', 150, 150, 'arch/x.txt')).toBe(once);
  });
});

describe('inputTrim', () => {
  const body = 'const value = compute();\n'.repeat(200);
  const session = (): SessionMessage[] => [
    message('user', 'Fix the stale cache.'),
    call('w1', 'Write', { file_path: 'src/app.ts', content: body }, 'ok'),
    result('w1', 'ok'),
    call('t1', 'Read', { file_path: 'big' }, BIG),
    result('t1', BIG),
    call('w2', 'Write', { file_path: 'src/new.ts', content: body }, 'ok'),
    result('w2', 'ok'),
    message('user', 'go'),
  ];
  const config = (options: Record<string, unknown> = {}) => ({
    ...resolveHookConfig({ preserveRecentMessages: 3, proseTrim: false, notificationTrim: false, ...options }),
    apiKey: 'k',
  });
  const content = (messages: SessionMessage[], id: string) =>
    messages.flatMap((m) => m.toolUses).find((t) => t.tool_use_id === id)?.input['content'] as string;

  it('cuts old code bodies even when tool compaction alone reaches the minimum', async () => {
    const out = await compactSession(session(), config(), jevFetch(() => 0.01));
    expect(content(out.messages, 'w1')).toContain('[fast-jev-compaction elided ');
    expect(content(out.messages, 'w1').length).toBeLessThan(600);
    expect(content(out.messages, 'w2')).toBe(body);
    expect(out.result.stats.inputsElided).toBe(1);
    expect(out.prose).toBeUndefined();
  });

  it('leaves code bodies whole when inputTrim is off', async () => {
    const out = await compactSession(session(), config({ inputTrim: false }), jevFetch(() => 0.01));
    expect(content(out.messages, 'w1')).toBe(body);
    expect(out.result.stats.inputsElided).toBe(0);
  });

  it('counts the cut toward the reduction', async () => {
    const on = await compactSession(session(), config(), jevFetch(() => 0.01));
    const off = await compactSession(session(), config({ inputTrim: false }), jevFetch(() => 0.01));
    expect(on.result.stats.charsAfter).toBeLessThan(off.result.stats.charsAfter - 3000);
  });

  it('measures charsAfter on the trimmed messages, quotes and newlines included', async () => {
    const quoted = 'const s = "a\tb";\n'.repeat(300);
    const messages = session().map((m) =>
      m.toolUses.some((t) => t.tool_use_id === 'w1')
        ? call('w1', 'Write', { file_path: 'src/app.ts', content: quoted }, 'ok')
        : m,
    );
    const out = await compactSession(messages, config(), jevFetch(() => 0.01));
    expect(out.result.stats.charsAfter).toBe(out.result.messages.reduce((sum, m) => sum + messageChars(m), 0));
  });
});

describe('context breakdown', () => {
  it('estimates tokens per kind of content the model sees', () => {
    const api = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'b'.repeat(40) },
          { type: 'text', text: 'c'.repeat(80) },
          { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'd'.repeat(100) } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'e'.repeat(800) },
          { type: 'tool_result', tool_use_id: 'y', content: [{ type: 'text', text: 'f'.repeat(400) }] },
          { type: 'image', source: { type: 'base64', data: 'g'.repeat(10_000) } },
        ],
      },
    ];
    const b = contextBreakdown(api);
    expect(b).toEqual({
      userText: estimateTokens('a'.repeat(400)),
      assistantText: estimateTokens('c'.repeat(80)),
      thinking: estimateTokens('b'.repeat(40)),
      toolInputs: estimateTokens(JSON.stringify({ file_path: 'd'.repeat(100) })),
      toolResults: estimateTokens('e'.repeat(800)) + estimateTokens('f'.repeat(400)),
      images: 1,
    });
    expect(b.images).toBe(1);
    expect(formatBreakdown(b)).toMatch(/^user text ~\d+, assistant text ~\d+, thinking ~\d+, tool inputs ~\d+, tool results ~\d+, images 1$/);
  });
});
