import { describe, expect, it } from 'vitest';
import {
  archiveWriter,
  compactSession,
  decisionLog,
  decisionLogLines,
  getApiKey,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      archiveResults: true,
      compactAtPercent: 60,
      compactCooldownTurns: 3,
      minReductionRatio: 0.25,
      model: 'typesafe/jev-1.13',
      builtinFallback: 'auto',
      jevPruneBashOutput: false,
      jevPruneMinChars: 4_000,
    });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      archiveResults: true,
      compactAtPercent: 60,
      compactCooldownTurns: 3,
      minReductionRatio: 0.25,
      builtinFallback: 'auto',
      jevPruneBashOutput: false,
      jevPruneMinChars: 4_000,
    });
  });

  it('reads jevPruneBashOutput from userConfig', () => {
    expect(resolveHookConfig({}).jevPruneBashOutput).toBe(false);
    expect(resolveHookConfig({ jevPruneBashOutput: true }).jevPruneBashOutput).toBe(true);
    expect(resolveHookConfig({ jevPruneBashOutput: 'yes' }).jevPruneBashOutput).toBe(false);
    expect(resolveHookConfig({ jevPruneMinChars: 500 }).jevPruneMinChars).toBe(500);
  });

  it('reads builtinFallback from userConfig, ignoring an invalid value', () => {
    expect(resolveHookConfig({ builtinFallback: 'always' }).builtinFallback).toBe('always');
    expect(resolveHookConfig({ builtinFallback: 'never' }).builtinFallback).toBe('never');
    expect(resolveHookConfig({ builtinFallback: 'sometimes' }).builtinFallback).toBe('auto');
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.01), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.01/result=0.01 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.01));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.01/result=0.01',
      'decisions (2/2): t2:Bash:drop_call/call=0.01/result=0.01',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });

  it('redacts secrets in tool results out of the whole request body, keep questions included', async () => {
    const bodies: string[] = [];
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const messages = transcript();
    messages.splice(
      5,
      0,
      call('tool-3', 'Bash', { command: 'cat .env' }, 'env'),
      result('tool-3', `API_KEY=${secret} DB_PASSWORD=hunter2hunter2\n${'filler line\n'.repeat(200)}`),
    );
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    await compactSession(messages, config, jevFetch(() => 0.9, bodies));
    expect(bodies.length).toBeGreaterThan(0);
    const all = bodies.join('\n');
    expect(all).toContain('result_t3');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('hunter2hunter2');
  });

  it('gives up on a Jev call that never answers instead of stalling the compaction', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const never = () => new Promise<never>(() => {});
    await expect(
      compactSession(transcript(), config, never, undefined, { timeoutMs: 30 }),
    ).rejects.toThrow(/timed out after 30 ms/);
    const controller = new AbortController();
    const pending = compactSession(transcript(), config, never, undefined, { signal: controller.signal });
    controller.abort(new Error('dispatch ended'));
    await expect(pending).rejects.toThrow(/dispatch ended/);
  });

  it('retries a 429 or 5xx once, and not a 4xx', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const ok = jevFetch(() => 0.01);
    let calls = 0;
    const flaky = async (url: string, init?: { body?: string }) =>
      ++calls === 1 ? { status: 503, ok: false, text: 'busy', headers: { 'retry-after': '0' } } : ok(url, init);
    const { result } = await compactSession(transcript(), config, flaky);
    expect(calls).toBe(2);
    expect(result.decisions).toHaveLength(2);
    calls = 0;
    const bad = async () => (++calls, { status: 400, ok: false, text: 'bad request' });
    await expect(compactSession(transcript(), config, bad)).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('archives a dropped call and cites the file in the note left behind, when an archive writer is given', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const files = new Map<string, string>();
    const writer = archiveWriter({
      fs: {
        exists: async (path: string) => files.has(path),
        write: async (path: string, text: string) => void files.set(path, text),
      },
    });
    const { result } = await compactSession(transcript(), config, jevFetch(() => 0.01), writer);
    const dropped = result.messages.find((m) => m.text.includes('removed the Read call'));
    expect(dropped?.text).toContain('.claude/fast-jev-compaction/tool-1.txt');
    expect(files.get('.claude/fast-jev-compaction/tool-1.txt')).toBe(fileA);
    expect(files.get('.claude/fast-jev-compaction/.gitignore')).toBe('*\n');
  });
});

describe('archiveWriter', () => {
  const fsStub = () => {
    const files = new Map<string, string>();
    return {
      files,
      fs: {
        exists: async (path: string) => files.has(path),
        write: async (path: string, text: string) => void files.set(path, text),
      },
    };
  };

  it('names a file per cited call, writes them on flush, and adds a .gitignore', async () => {
    const stub = fsStub();
    const writer = archiveWriter(stub);
    const path = writer.cite('toolu_1', 'a'.repeat(5000));
    expect(path).toBe('.claude/fast-jev-compaction/toolu_1.txt');
    expect(stub.files.size).toBe(0);
    await writer.flush();
    expect(stub.files.get('.claude/fast-jev-compaction/.gitignore')).toBe('*\n');
    expect(stub.files.get(path!)?.length).toBe(5000);
  });

  it('never archives text that looks like a credential', async () => {
    const stub = fsStub();
    const writer = archiveWriter(stub);
    expect(writer.cite('toolu_2', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI7K7MDENG')).toBeUndefined();
    await writer.flush();
    expect(stub.files.size).toBe(0);
  });

  it('writes nothing when nothing was cited', async () => {
    const stub = fsStub();
    await archiveWriter(stub).flush();
    expect(stub.files.size).toBe(0);
  });
});

describe('getApiKey', () => {
  const engine = (env: Record<string, string> = {}, settingsEnv: Record<string, string> = {}) => ({
    env: { get: async (name: string) => env[name] },
    settings: { read: async () => ({ env: settingsEnv }) },
  });

  it('prefers config.apiKey, then OPENROUTER_API_KEY, then TYPESAFE_API_KEY', async () => {
    expect(await getApiKey(engine(), { ...resolveHookConfig({}), apiKey: 'configured' })).toBe(
      'configured',
    );
    expect(
      await getApiKey(engine({ OPENROUTER_API_KEY: 'router', TYPESAFE_API_KEY: 'typesafe' }), resolveHookConfig({})),
    ).toBe('router');
    expect(await getApiKey(engine({ TYPESAFE_API_KEY: 'typesafe' }), resolveHookConfig({}))).toBe(
      'typesafe',
    );
    expect(await getApiKey(engine(), resolveHookConfig({}))).toBeUndefined();
  });

  it('treats an empty-string OPENROUTER_API_KEY as unset instead of blocking the fallback', async () => {
    expect(
      await getApiKey(engine({ OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: 'typesafe' }), resolveHookConfig({})),
    ).toBe('typesafe');
    expect(
      await getApiKey(
        engine({}, { OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: 'typesafe' }),
        resolveHookConfig({}),
      ),
    ).toBe('typesafe');
  });

  it('falls back to the settings env block when the process environment has nothing', async () => {
    expect(
      await getApiKey(engine({}, { OPENROUTER_API_KEY: 'from-settings' }), resolveHookConfig({})),
    ).toBe('from-settings');
  });
});

describe('register', () => {
  type Hook = (...args: any[]) => Promise<unknown>;
  function registered(options: Record<string, unknown> = {}) {
    const hooks: Record<string, Hook> = {};
    (register as any)((event: string, matcherOrHook: unknown, maybeHook?: Hook) => {
      hooks[event] = typeof maybeHook === 'function' ? maybeHook : (matcherOrHook as Hook);
    }, { apiKey: 'k', ...options });
    return hooks;
  }
  function engine(fetchFn: ReturnType<typeof jevFetch>) {
    const logs: string[] = [];
    const toasts: string[] = [];
    const $ = {
      http: {
        fetch: async (url: string, init?: { body?: string }) => fetchFn(url, init),
      },
      ui: {
        log: (t: string) => logs.push(t),
        toast: (t: string) => toasts.push(t),
      },
      session: {
        usage: async () => ({ context: { percent: 100 } }),
        compact: async () => ({ messages: [] }),
      },
    };
    return { $, logs, toasts };
  }
  function next(signal: AbortSignal = new AbortController().signal) {
    return Object.assign(async (e: unknown) => e, { signal });
  }

  it('does not request compaction from a subagent turn', async () => {
    const hooks = registered({ compactAtPercent: 0 });
    let compactCalls = 0;
    const $ = {
      session: {
        usage: async () => ({ context: { percent: 100 } }),
        compact: async () => {
          compactCalls++;
          return { messages: [] };
        },
      },
      ui: { log: () => {} },
    };
    const n = next();
    await hooks['turn.complete']!($, { agentId: 'sub-1', reason: 'answer' }, n);
    expect(compactCalls).toBe(0);

    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(1);
  });

  it('does not request compaction from a turn that did not answer', async () => {
    const hooks = registered({ compactAtPercent: 0 });
    let compactCalls = 0;
    const $ = {
      session: {
        usage: async () => ({ context: { percent: 100 } }),
        compact: async () => {
          compactCalls++;
          return { messages: [] };
        },
      },
      ui: { log: () => {} },
    };
    const n = next();
    await hooks['turn.complete']!($, { reason: 'aborted' }, n);
    await hooks['turn.complete']!($, { reason: 'error' }, n);
    expect(compactCalls).toBe(0);

    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(1);
  });

  it('does not re-request compaction every turn while the window stays at the threshold', async () => {
    const hooks = registered({ compactAtPercent: 0, compactCooldownTurns: 2 });
    let compactCalls = 0;
    const $ = {
      session: {
        usage: async () => ({ context: { percent: 100 } }),
        compact: async () => {
          compactCalls++;
          return { messages: [] };
        },
      },
      ui: { log: () => {} },
    };
    const n = next();
    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(1);
    // Next turn while the window is still at the threshold: held off by the cooldown.
    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(1);
    // Cooldown elapsed: the next turn may attempt again.
    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(2);
  });

  it('does not wait out the cooldown once the window drops below the threshold', async () => {
    const hooks = registered({ compactAtPercent: 50, compactCooldownTurns: 5 });
    let compactCalls = 0;
    let percent = 100;
    const $ = {
      session: {
        usage: async () => ({ context: { percent } }),
        compact: async () => {
          compactCalls++;
          return { messages: [] };
        },
      },
      ui: { log: () => {} },
    };
    const n = next();
    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(1);
    percent = 20;
    // Below compactAtPercent: the usage check itself skips, cooldown never consulted.
    await hooks['turn.complete']!($, { reason: 'answer' }, n);
    expect(compactCalls).toBe(1);
  });

  it('vetoes an interrupted dispatch instead of falling back to a summary', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const controller = new AbortController();
    const e = engine(async () => {
      controller.abort();
      throw new Error('gateway down');
    });
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript() },
      next(controller.signal),
    );
    expect(out).toEqual({ skip: 'fast-jev-compaction: interrupted' });
    expect(e.toasts).toEqual([]);
  });

  it('leaves a subagent transcript to the engine', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const e = engine(async () => ({ status: 200, ok: true, text: '{"answers":{}}' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'plugin', agentId: 'sub-1', messages: transcript() },
      next(),
    );
    expect(out).toEqual({ trigger: 'plugin', agentId: 'sub-1', messages: transcript() });
  });

  it('skips a speculative precompute instead of running Jev on it', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const e = engine(async () => ({ status: 200, ok: true, text: '{"answers":{}}' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'precompute', messages: transcript() },
      next(),
    );
    expect(out).toEqual({
      skip: 'fast-jev-compaction does not handle speculative compactions',
    });
  });

  it('reports a real failure as a fallback for the engine\'s own auto trigger', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const e = engine(async () => ({ status: 500, ok: false, text: 'down' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'auto', messages: transcript() },
      next(),
    );
    expect(out).toEqual({ trigger: 'auto', messages: transcript() });
    expect(e.toasts).toHaveLength(1);
    expect(e.toasts[0]).toMatch(/fallback to built-in summary/);
  });

  it('skips instead of falling back to a summary for a manual /compact', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const e = engine(async () => ({ status: 500, ok: false, text: 'down' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript() },
      next(),
    );
    expect(out).toEqual({ skip: 'fast-jev-compaction: request failed, builtin fallback disabled' });
    expect(e.toasts).toHaveLength(1);
    expect(e.toasts[0]).toMatch(/builtin fallback disabled/);
  });

  it('skips a below-minimum reduction instead of falling back for a manual /compact', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 1 });
    const e = engine(jevFetch(() => 1));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript() },
      next(),
    );
    expect(out).toEqual({
      skip: 'fast-jev-compaction: below minimum reduction, builtin fallback disabled',
    });
  });

  it('always falls back when builtinFallback is set to always', async () => {
    const hooks = registered({
      preserveRecentMessages: 1,
      minReductionRatio: 0,
      builtinFallback: 'always',
    });
    const e = engine(async () => ({ status: 500, ok: false, text: 'down' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript() },
      next(),
    );
    expect(out).toEqual({ trigger: 'manual', messages: transcript() });
  });

  it('never falls back when builtinFallback is set to never, even for the auto trigger', async () => {
    const hooks = registered({
      preserveRecentMessages: 1,
      minReductionRatio: 0,
      builtinFallback: 'never',
    });
    const e = engine(async () => ({ status: 500, ok: false, text: 'down' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'auto', messages: transcript() },
      next(),
    );
    expect(out).toEqual({ skip: 'fast-jev-compaction: request failed, builtin fallback disabled' });
  });

  it('passes /compact instructions through as extra goal context', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0, goal: 'base goal' });
    let sentGoal: string | undefined;
    const e = engine(async (url, init) => {
      sentGoal = JSON.parse(String((init as RequestInit).body)).state.goal;
      return { status: 200, ok: true, text: '{"answers":{}}' };
    });
    await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript(), instructions: 'focus on the auth bug' },
      next(),
    );
    expect(sentGoal).toContain('base goal');
    expect(sentGoal).toContain('focus on the auth bug');
  });
});

describe('register: tool.call (Bash output trimming)', () => {
  type Hook = (...args: any[]) => Promise<unknown>;
  function registeredMatchers(options: Record<string, unknown> = {}) {
    const hooks: Record<string, { matcher: unknown; hook: Hook }> = {};
    (register as any)(
      (event: string, matcherOrHook: unknown, maybeHook?: Hook) => {
        hooks[event] =
          typeof maybeHook === 'function'
            ? { matcher: matcherOrHook, hook: maybeHook }
            : { matcher: undefined, hook: matcherOrHook as Hook };
      },
      { apiKey: 'k', ...options },
    );
    return hooks;
  }
  function bashEngine(fetchFn: (url: string, init?: { body?: string }) => Promise<unknown>) {
    return {
      env: { get: async () => undefined },
      settings: { read: async () => ({}) },
      ui: { log: () => {}, toast: () => {} },
      http: { fetch: fetchFn as any },
    };
  }

  it('matches only the Bash tool', () => {
    const { matcher } = registeredMatchers()['tool.call']!;
    expect(matcher).toEqual({ tool: 'Bash' });
  });

  it('leaves output untouched when jevPruneBashOutput is off', async () => {
    const { hook } = registeredMatchers({ jevPruneBashOutput: false })['tool.call']!;
    let asked = false;
    const $ = bashEngine(async () => {
      asked = true;
      return { status: 200, ok: true, text: '{"answers":{}}' };
    });
    const long = 'line\n'.repeat(2000);
    const out = (await hook($, { command: 'npm test' }, next(async () => ({ result: { stdout: long } })))) as {
      result: { stdout: string };
    };
    expect(out.result.stdout).toBe(long);
    expect(asked).toBe(false);
  });

  it('trims long Bash stdout through Jev when opted in', async () => {
    const { hook } = registeredMatchers({ jevPruneBashOutput: true, jevPruneMinChars: 10 })['tool.call']!;
    const $ = bashEngine(async () => {
      // 60 lines / 20 per chunk = 3 chunks (c1, c2, c3). The first and last
      // are always kept regardless of score, so drop the middle one to make
      // trimming observable and deterministic.
      const answers = {
        c1: { type: 'noul', noul: 1 },
        c2: { type: 'noul', noul: 0 },
        c3: { type: 'noul', noul: 1 },
      };
      return { status: 200, ok: true, text: JSON.stringify({ answers }) };
    });
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const out = (await hook(
      $,
      { command: 'npm test' },
      next(async () => ({ result: { stdout: long } })),
    )) as { result: { stdout: string } };
    expect(out.result.stdout.length).toBeLessThan(long.length);
    expect(out.result.stdout).toContain('fast-jev-compaction trimmed');
  });

  it('leaves a short Bash result untouched even when opted in', async () => {
    const { hook } = registeredMatchers({ jevPruneBashOutput: true, jevPruneMinChars: 4000 })['tool.call']!;
    let asked = false;
    const $ = bashEngine(async () => {
      asked = true;
      return { status: 200, ok: true, text: '{"answers":{}}' };
    });
    const out = (await hook(
      $,
      { command: 'echo hi' },
      next(async () => ({ result: { stdout: 'hi' } })),
    )) as { result: { stdout: string } };
    expect(out.result.stdout).toBe('hi');
    expect(asked).toBe(false);
  });

  it('skips an image result, a background task, or output already persisted to disk', async () => {
    const { hook } = registeredMatchers({ jevPruneBashOutput: true, jevPruneMinChars: 1 })['tool.call']!;
    let asked = false;
    const $ = bashEngine(async () => {
      asked = true;
      return { status: 200, ok: true, text: '{"answers":{}}' };
    });
    for (const result of [
      { stdout: 'x'.repeat(50), isImage: true },
      { stdout: 'x'.repeat(50), backgroundTaskId: 'bg-1' },
      { stdout: 'x'.repeat(50), persistedOutputPath: '/tmp/out.txt' },
    ]) {
      const out = (await hook($, { command: 'x' }, next(async () => ({ result })))) as {
        result: typeof result;
      };
      expect(out.result).toBe(result);
    }
    expect(asked).toBe(false);
  });

  function next(fn: () => Promise<unknown>) {
    return Object.assign(fn, { signal: new AbortController().signal });
  }
});
