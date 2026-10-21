import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.js';

// Two compactions in flight at once (the main one waiting on Jev while a
// subagent's runs to the end) each keep their own /jev report.
describe('/jev with concurrent compactions', () => {
  it('keeps the outcome and detail of the compaction that finished last', async () => {
    const hooks: Record<string, (...args: any[]) => Promise<any>> = {};
    (register as any)(
      (event: string, a: unknown, b?: any) => {
        hooks[event] = typeof b === 'function' ? b : (a as any);
      },
      { apiKey: 'k', minReductionRatio: 0, archiveResults: false, preserveRecentMessages: 1, minResultChars: 0 },
    );
    const m = (role: string, text: string, extra: Record<string, unknown> = {}) => ({ role, text, toolUses: [], ...extra });
    const big = 'line\n'.repeat(2000);
    const transcript = (id: string) => [
      m('user', `goal ${id}`),
      m('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: id }, text: big }] }),
      m('user', '', { toolResults: [{ tool_use_id: id, text: big }] }),
      m('assistant', 'ok'),
      m('user', 'go'),
    ];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine = (slow: boolean) => ({
      clock: { sleep: () => new Promise(() => {}), now: async () => Date.now() },
      http: {
        fetch: async (_url: string, init: { body: string }) => {
          if (slow) await gate;
          const { questions } = JSON.parse(init.body) as { questions: Record<string, unknown> };
          const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.01 }]));
          return { status: 200, ok: true, text: JSON.stringify({ answers }) };
        },
      },
      ui: { log: () => {}, toast: () => {} },
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
    });
    const next = () =>
      Object.assign(async (e: unknown) => e, { signal: new AbortController().signal, budget: { ms: 1e4, remainingMs: 1e4 } });
    const main = hooks['session.compact']!(engine(true), { trigger: 'auto', messages: transcript('MAIN') }, next());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await hooks['session.compact']!(engine(false), { trigger: 'auto', agentId: 'sub', messages: transcript('SUB') }, next());
    release();
    await main;
    const { text } = await hooks['command.run']!(engine(false), { command: 'jev', args: '' }, next());
    expect(text).toMatch(/^Last compaction just now \(auto\)\nCompacted with Jev: /);
    expect(text).toContain('  kept 4/5 messages');
  });
});
