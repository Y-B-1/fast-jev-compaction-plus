import { describe, expect, it } from 'vitest';
import { applyDecisions } from '../src/compact.js';
import { applyExchanges, findExchanges } from '../src/exchanges.js';
import { findBlocks } from '../src/inject.js';
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
