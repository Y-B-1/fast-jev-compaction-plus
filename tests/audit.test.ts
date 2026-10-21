import { describe, expect, it } from 'vitest';
import { applyDecisions } from '../src/compact.js';
import { applyExchanges, findExchanges } from '../src/exchanges.js';
import { findBlocks } from '../src/inject.js';
import { supersededCalls } from '../src/dedupe.js';
import { collectToolCalls } from '../src/state.js';
import { findSteps, planSteps } from '../src/steps.js';
import type { Message } from '../src/types.js';

const msg = (role: 'user' | 'assistant', text: string, extra: Partial<Message> = {}): Message => ({
  role,
  text,
  toolUses: [],
  ...extra,
});
const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('markers never split a surrogate pair', () => {
  it('in a dropped-call note', () => {
    const tool = { tool_use_id: 'x', tool: 'Bash', input: { command: 'a'.repeat(146) + '😀'.repeat(20) }, text: '' };
    const messages = [
      msg('user', 's'),
      msg('assistant', '', { toolUses: [tool] }),
      msg('user', '', { toolResults: [{ tool_use_id: 'x', text: 'out'.repeat(300) }] }),
      msg('user', 'e'),
    ];
    const calls = collectToolCalls(messages, 0);
    const out = applyDecisions(
      messages,
      [{ id: 't1', tool: 'Bash', action: 'drop_call', reason: 'call_dropped', keepCall: 0, keepResult: 0 }] as never,
      calls,
      150,
    );
    expect(out.some((m) => m.text.includes('removed the Bash call'))).toBe(true);
    expect(out.some((m) => lone(m.text))).toBe(false);
  });

  it('in a step note', () => {
    const reply = 'b'.repeat(199) + '😀'.repeat(10) + ' '.repeat(1300);
    const messages = [msg('user', 's'), msg('user', 'go'), msg('assistant', reply), msg('user', 'next'), msg('assistant', 'x'), msg('user', 'y')];
    const steps = findSteps(messages, 0, 100);
    const plans = planSteps(
      { messages, steps, noul: new Map(steps.map((s) => [s.key, 0])), stats: {} } as never,
      (id: string) => `p/${id}`,
    );
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.some((p) => lone(p.row.text))).toBe(false);
  });

  it('in an exchange marker', () => {
    const messages = [
      msg('user', 's'),
      msg('user', 'old task'),
      msg('assistant', `w ${'z'.repeat(2000)}`),
      msg('assistant', 'c'.repeat(399) + '😀'.repeat(10)),
      msg('user', 't2'),
      msg('assistant', 'r'),
      msg('user', 't3'),
      msg('assistant', 'r'),
      msg('user', 't4'),
      msg('assistant', 'r'),
    ];
    const exchanges = findExchanges(messages, 0);
    const applied = applyExchanges(
      { messages, exchanges, noul: new Map(exchanges.map((e) => [e.key, 0])), stats: {} } as never,
      0.5,
      (id: string) => `p/${id}`,
    );
    const markers = applied.messages.filter((m) => m.text.includes('archived this exchange'));
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.some((m) => lone(m.text))).toBe(false);
  });
});

describe('injected-content fold and images', () => {
  const rows = (): Message[] => [
    msg('user', 'start'),
    { ...msg('user', `please review this:\n${'detail line\n'.repeat(400)}`), handle: 'h-long' } as Message,
    msg('assistant', 'ok'),
    msg('user', 'two'),
    msg('assistant', 'ok'),
    msg('user', 'three'),
    msg('assistant', 'ok'),
    msg('user', 'four'),
    msg('assistant', 'ok'),
  ];

  it('folds a long engine-held prompt when the conversation has no images', () => {
    expect(findBlocks(rows(), 2, 150, false).map((b) => b.kind)).toContain('long');
  });

  it('leaves a long engine-held prompt whole when the conversation holds images', () => {
    expect(findBlocks(rows(), 2, 150, true).map((b) => b.kind)).not.toContain('long');
  });
});

describe('duplicate calls', () => {
  const read = (id: string, chars: number, isError = false) =>
    ({ id, tool_use_id: id, tool: 'Read', input: { file_path: '/r/x.ts' }, callIndex: 0, resultIndex: 1, resultChars: chars, isError, pinned: false }) as never;

  it('a later full copy supersedes the earlier one', () => {
    expect([...supersededCalls([read('t1', 3000), read('t2', 3000)])]).toEqual(['t1']);
  });

  it('a later "File unchanged" stub or error does not supersede the full output', () => {
    expect(supersededCalls([read('t1', 3500), read('t2', 150)]).size).toBe(0);
    expect(supersededCalls([read('t1', 3500), read('t2', 3500, true)]).size).toBe(0);
  });
});

describe('empty assistant rows', () => {
  it('drops an old empty assistant row but keeps one in the pinned newest messages', () => {
    const messages = [
      msg('user', 'start'),
      msg('assistant', ''),
      msg('user', 'continue'),
      { ...msg('assistant', ''), handle: 'thinking' } as Message,
      msg('assistant', 'working'),
    ];
    const out = applyDecisions(messages, [], [], 150, undefined, 0, 0, 3);
    expect(out).toHaveLength(4);
    expect(out.some((m) => (m as { handle?: string }).handle === 'thinking')).toBe(true);
  });
});

describe('dropped-call notes', () => {
  const drop = (tool: string, input: Record<string, unknown>, output: string) => {
    const messages = [
      msg('user', 's'),
      msg('assistant', '', { toolUses: [{ tool_use_id: 'x', tool, input, text: output }] }),
      msg('user', '', { toolResults: [{ tool_use_id: 'x', text: output }] }),
      msg('user', 'e'),
    ];
    return applyDecisions(
      messages,
      [{ id: 't1', tool, action: 'drop_call', reason: 'call_dropped', keepCall: 0, keepResult: 0 }] as never,
      collectToolCalls(messages, 0),
      150,
      undefined,
      300,
    )
      .map((m) => m.text)
      .join('\n');
  };
  const output = `${'progress line\n'.repeat(50)}Error: listen EADDRINUSE 127.0.0.1:5173\n${'more\n'.repeat(20)}`;

  it('keeps the error lines of a command that may not reproduce', () => {
    expect(drop('Bash', { command: 'npm run dev' }, output)).toMatch(/errors: .*EADDRINUSE/);
  });

  it('keeps only the one-line note for a read a re-run reproduces', () => {
    expect(drop('Read', { file_path: 'a.ts' }, output)).not.toContain('EADDRINUSE');
  });
});
