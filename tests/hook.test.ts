import { readFileSync } from 'node:fs';
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
import { messageChars } from '../src/compact.js';

type SessionMessage = Message & { handle?: string };

/** The engine's `$.clock`: a sleep that never elapses, only aborts. */
const clock = {
  calls: 0,
  sleep: (_ms: number, options?: { signal?: AbortSignal }) =>
    ++clock.calls &&
    new Promise<void>((_resolve, reject) =>
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }),
    ),
};

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
      minReductionRatio: 0.25,
      model: 'jev-latest',
      builtinFallback: 'auto',
      jevPruneBashOutput: false,
      jevPruneMinChars: 4_000,
      proseTrim: 'off',
    });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      archiveResults: true,
      minReductionRatio: 0.25,
      builtinFallback: 'auto',
      jevPruneBashOutput: false,
      jevPruneMinChars: 4_000,
      proseTrim: 'off',
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

  it('bounds a Jev call with the injected sleep when the runtime has no AbortSignal.timeout or .any', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const never = () => new Promise<never>(() => {});
    const { timeout, any } = AbortSignal;
    // The hook runtime (JavaScriptCore) has neither, nor setTimeout.
    Object.assign(AbortSignal, { timeout: undefined, any: undefined });
    const sleeps: number[] = [];
    // Elapses at once for the 30 ms deadline; otherwise waits for the signal.
    const sleep = (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      if (ms === 30) return Promise.resolve();
      return new Promise<void>((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    };
    try {
      await expect(
        compactSession(transcript(), config, never, undefined, { timeoutMs: 30, sleep }),
      ).rejects.toThrow(/timed out after 30 ms/);
      expect(sleeps).toContain(30);
      const controller = new AbortController();
      const aborted = compactSession(transcript(), config, never, undefined, { signal: controller.signal, sleep });
      controller.abort(new Error('dispatch ended'));
      await expect(aborted).rejects.toThrow(/dispatch ended/);
    } finally {
      Object.assign(AbortSignal, { timeout, any });
    }
  });

  it('skips a retry whose wait the hook budget cannot afford', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    let calls = 0;
    const busy = async () => (++calls, { status: 429, ok: false, text: 'slow down', headers: { 'retry-after': '15' } });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    await expect(
      compactSession(transcript(), config, busy, undefined, { sleep, remainingMs: () => 9_000 }),
    ).rejects.toThrow(/429/);
    expect(calls).toBe(1);
    expect(sleeps).not.toContain(15_000);
    calls = 0;
    await expect(
      compactSession(transcript(), config, busy, undefined, { sleep, remainingMs: () => 60_000 }),
    ).rejects.toThrow(/429/);
    expect(calls).toBe(2);
    expect(sleeps).toContain(15_000);
  });

  it('reports a failed deadline timer as itself, not as an abort', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const never = () => new Promise<never>(() => {});
    const sleep = async () => {
      throw new Error('clock.sleep refused');
    };
    await expect(compactSession(transcript(), config, never, undefined, { sleep })).rejects.toThrow(
      /clock.sleep refused/,
    );
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

  it('archives text with credentials redacted, rather than skipping it', async () => {
    const stub = fsStub();
    const writer = archiveWriter(stub);
    const path = writer.cite('toolu_2', 'ok\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI7K7MDENG\ndone');
    await writer.flush();
    expect(stub.files.get(path!)).toBe('ok\n[REDACTED]\ndone');
  });

  it('archives git output and paths verbatim', async () => {
    const stub = fsStub();
    const writer = archiveWriter(stub);
    const text = 'commit 3bfad06e1c2d4f5a6b7c8d9e0f1a2b3c4d5e6f7a\n/Users/yusri/Documents/Claude/Orchestra2/notes';
    const path = writer.cite('toolu_3', text);
    await writer.flush();
    expect(stub.files.get(path!)).toBe(text);
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

  it('prefers config.apiKey, then TYPESAFE_API_KEY from the environment, then the settings env block', async () => {
    expect(
      await getApiKey(engine({ TYPESAFE_API_KEY: 'typesafe' }), { ...resolveHookConfig({}), apiKey: 'configured' }),
    ).toBe('configured');
    expect(
      await getApiKey(engine({ TYPESAFE_API_KEY: 'from-env' }, { TYPESAFE_API_KEY: 'from-settings' }), resolveHookConfig({})),
    ).toBe('from-env');
    expect(await getApiKey(engine({}, { TYPESAFE_API_KEY: 'from-settings' }), resolveHookConfig({}))).toBe(
      'from-settings',
    );
    expect(await getApiKey(engine(), resolveHookConfig({}))).toBeUndefined();
  });

  it('treats an empty-string TYPESAFE_API_KEY in the environment as unset', async () => {
    expect(
      await getApiKey(engine({ TYPESAFE_API_KEY: '' }, { TYPESAFE_API_KEY: 'from-settings' }), resolveHookConfig({})),
    ).toBe('from-settings');
  });

  it('ignores OPENROUTER_API_KEY entirely', async () => {
    expect(await getApiKey(engine({ OPENROUTER_API_KEY: 'router' }), resolveHookConfig({}))).toBeUndefined();
    expect(await getApiKey(engine({}, { OPENROUTER_API_KEY: 'router' }), resolveHookConfig({}))).toBeUndefined();
  });

  it('refuses an OpenRouter sk-or- key from any source', async () => {
    const refusal = 'an OpenRouter key is configured; fast-jev now uses TypeSafe: set TYPESAFE_API_KEY';
    await expect(
      getApiKey(engine(), { ...resolveHookConfig({}), apiKey: 'sk-or-v1-abc' }),
    ).rejects.toThrow(refusal);
    await expect(getApiKey(engine({ TYPESAFE_API_KEY: 'sk-or-v1-abc' }), resolveHookConfig({}))).rejects.toThrow(
      refusal,
    );
    await expect(
      getApiKey(engine({}, { TYPESAFE_API_KEY: 'sk-or-v1-abc' }), resolveHookConfig({})),
    ).rejects.toThrow(refusal);
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
      clock,
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
    return Object.assign(async (e: unknown) => e, { signal, budget: { ms: 10_000, remainingMs: 10_000 } });
  }

  it('installs no turn.complete hook, so compaction only runs when Claude Code compacts', () => {
    expect(Object.keys(registered()).sort()).toEqual(['session.compact', 'tool.call']);
  });

  it('skips a 429 retry the hook budget from next.budget cannot afford', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 0 });
    const run = async (remainingMs: number) => {
      let calls = 0;
      const e = engine(async () => (++calls, {
        status: 429,
        ok: false,
        text: 'slow down',
        headers: { 'retry-after': '0' },
      }));
      const n = Object.assign(async (x: unknown) => x, {
        signal: new AbortController().signal,
        budget: { ms: 10_000, remainingMs },
      });
      await hooks['session.compact']!(e.$, { trigger: 'manual', messages: transcript() }, n);
      return calls;
    };
    const roomy = await run(10_000);
    expect(roomy).toBeGreaterThan(1);
    // Same 429, but too little budget left to afford a retry: each Jev request is attempted once.
    expect(await run(1_000)).toBeLessThan(roomy);
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

  it('sends nothing to the network when the configured key is an OpenRouter key', async () => {
    const hooks = registered({ apiKey: 'sk-or-v1-abc', preserveRecentMessages: 1, minReductionRatio: 0 });
    let calls = 0;
    const e = engine(async () => (++calls, { status: 200, ok: true, text: '{}' }));
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript() },
      next(),
    );
    expect(calls).toBe(0);
    expect(out).toEqual({ skip: 'fast-jev-compaction: request failed, builtin fallback disabled' });
  });

  it('skips a below-minimum reduction instead of falling back for a manual /compact', async () => {
    const hooks = registered({ preserveRecentMessages: 1, minReductionRatio: 1 });
    const e = engine(jevFetch(() => 1));
    // The runtime has no setTimeout: each Jev call must be timed by $.clock.
    const before = clock.calls;
    const out = await hooks['session.compact']!(
      e.$,
      { trigger: 'manual', messages: transcript() },
      next(),
    );
    expect(out).toEqual({
      skip: 'fast-jev-compaction: below minimum reduction, builtin fallback disabled',
    });
    expect(clock.calls).toBeGreaterThan(before);
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
      clock,
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
    const before = clock.calls;
    const out = (await hook(
      $,
      { command: 'npm test' },
      next(async () => ({ result: { stdout: long } })),
    )) as { result: { stdout: string } };
    expect(out.result.stdout.length).toBeLessThan(long.length);
    expect(out.result.stdout).toContain('fast-jev-compaction trimmed');
    expect(clock.calls).toBeGreaterThan(before);
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
    return Object.assign(fn, { signal: new AbortController().signal, budget: { ms: 10_000, remainingMs: 10_000 } });
  }
});

describe('proseTrim', () => {
  const FLUFF = 'Let me have a good look at the layout of this module now.';
  const FACT = 'The cache layer returns stale entries after a restart.';
  const body = 'const value = compute();\n'.repeat(80);

  function proseTranscript(): SessionMessage[] {
    return [
      message('user', 'Fix the stale cache.', { handle: 'p-0' }),
      message('assistant', `${FLUFF} ${FACT}`, { handle: 'p-1' }),
      call('w1', 'Write', { file_path: 'src/c.ts', content: body }, 'wrote'),
      result('w1', 'ok'),
      message('user', 'thanks', { handle: 'p-4' }),
      message('assistant', 'Done.', { handle: 'p-5' }),
      message('user', 'ok', { handle: 'p-6' }),
    ];
  }

  /** Tool questions get `tool`, prose parts (`c<n>`) get `prose`; a number throws when prose is 'fail'. */
  function fetchWith(prose: number | 'fail', tool = 0.9, seen: string[] = []) {
    return async (_url: string, init?: { body?: string }) => {
      const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
      const keys = Object.keys(questions);
      seen.push(...keys);
      if (prose === 'fail' && keys.some((k) => /^c\d+$/.test(k))) {
        return { status: 500, ok: false, text: 'down' };
      }
      const answers = Object.fromEntries(
        keys.map((k) => [k, { type: 'noul', noul: /^c\d+$/.test(k) ? prose : tool }]),
      );
      return { status: 200, ok: true, text: JSON.stringify({ answers }) };
    };
  }

  const cfg = (extra: Record<string, unknown> = {}) => ({
    ...resolveHookConfig({ preserveRecentMessages: 2, archiveResults: false, ...extra }),
    apiKey: 'k',
  });
  const strip = (r: Awaited<ReturnType<typeof compactSession>>) => ({
    messages: r.messages,
    decisions: r.result.decisions,
    stats: { ...r.result.stats, ms: 0 },
    prose: r.prose,
  });

  it('parses proseTrim like builtinFallback: unknown values become off', () => {
    expect(resolveHookConfig({}).proseTrim).toBe('off');
    expect(resolveHookConfig({ proseTrim: 'trim' }).proseTrim).toBe('trim');
    expect(resolveHookConfig({ proseTrim: 'tidy' }).proseTrim).toBe('tidy');
    expect(resolveHookConfig({ proseTrim: 'aggressive' }).proseTrim).toBe('off');
    expect(resolveHookConfig({ proseTrim: true }).proseTrim).toBe('off');
  });

  it('declares proseTrim in the manifest as a string option defaulting to off', () => {
    const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    expect(manifest.userConfig.proseTrim).toMatchObject({ type: 'string', default: 'off' });
  });

  it('gives equal output when proseTrim is omitted and when it is "off", with no prose text', async () => {
    for (const make of [transcript, proseTranscript]) {
      const omitted = await compactSession(make(), cfg(), fetchWith(0.01));
      const off = await compactSession(make(), cfg({ proseTrim: 'off' }), fetchWith(0.01));
      expect(strip(off)).toEqual(strip(omitted));
      expect(off.prose).toBeUndefined();
      expect(summarize(off.result, off.prose)).toBe(summarize(omitted.result));
      expect(summarize(off.result, off.prose)).not.toContain('prose:');
    }
  });

  it('trims prose and inputs, and the savings equal the drop in final chars', async () => {
    const off = await compactSession(proseTranscript(), cfg(), fetchWith(0.01));
    const on = await compactSession(proseTranscript(), cfg({ proseTrim: 'trim' }), fetchWith(0.01));
    expect(on.prose?.scored).toBeGreaterThan(0);
    expect(on.prose?.dropped).toBeGreaterThan(0);
    expect(on.prose?.inputsElided).toBe(1);
    expect(on.prose?.proseCharsSaved).toBeGreaterThan(0);
    expect(on.prose?.inputCharsSaved).toBeGreaterThan(0);
    expect(on.result.stats.charsAfter).toBe(on.messages.reduce((n, m) => n + messageChars(m), 0));
    expect(on.result.decisions).toEqual(off.result.decisions);
    expect(on.messages.map((m) => m.handle)).toContain('p-0');
    expect(on.messages.find((m) => m.handle === 'p-5')?.text).toBe('Done.');
    expect(summarize(on.result, on.prose)).toMatch(
      /; prose: [1-9]\d* scored, [1-9]\d* dropped; inputs: 1 elided; [1-9]\d* chars$/,
    );
    // Prose is counted in plain characters. A tool input is counted as JSON, where each line
    // break is two characters, so the drop in `charsAfter` exceeds the stage's own count by one
    // per line break the cut removed.
    const content = (r: typeof on) =>
      String(r.messages.flatMap((m) => m.toolUses).find((t) => t.tool_use_id === 'w1')?.input['content']);
    const breaksCut = body.split('\n').length - content(on).split('\n').length;
    expect(breaksCut).toBeGreaterThan(0);
    expect(off.result.stats.charsAfter - on.result.stats.charsAfter).toBe(
      (on.prose?.proseCharsSaved ?? 0) + (on.prose?.inputCharsSaved ?? 0) + breaksCut,
    );
  });

  it('prose savings alone equal the drop in final chars exactly', async () => {
    const make = (): SessionMessage[] => [
      message('user', 'Fix the stale cache.'),
      message('assistant', `${FLUFF} ${FACT}`),
      message('user', 'thanks'),
      message('assistant', 'Done.'),
      message('user', 'ok'),
    ];
    const off = await compactSession(make(), cfg(), fetchWith(0.01));
    const on = await compactSession(make(), cfg({ proseTrim: 'trim' }), fetchWith(0.01));
    expect(on.prose?.dropped).toBeGreaterThan(0);
    expect(on.prose?.inputCharsSaved).toBe(0);
    expect(off.result.stats.charsAfter - on.result.stats.charsAfter).toBe(on.prose?.proseCharsSaved);
  });

  it('treats tidy like trim here', async () => {
    const trim = await compactSession(proseTranscript(), cfg({ proseTrim: 'trim' }), fetchWith(0.01));
    const tidy = await compactSession(proseTranscript(), cfg({ proseTrim: 'tidy' }), fetchWith(0.01));
    expect(strip(tidy)).toEqual(strip(trim));
  });

  it('discards the whole stage when every prose request fails', async () => {
    const off = await compactSession(proseTranscript(), cfg(), fetchWith(0.01));
    const failed = await compactSession(proseTranscript(), cfg({ proseTrim: 'trim' }), fetchWith('fail'));
    expect(failed.prose).toBeUndefined();
    expect(strip(failed)).toEqual(strip(off));
  });

  describe('through the hook', () => {
    const hook = (options: Record<string, unknown>) => {
      const hooks: Record<string, (...args: any[]) => Promise<any>> = {};
      (register as any)(
        (event: string, a: unknown, b?: any) => {
          hooks[event] = typeof b === 'function' ? b : (a as any);
        },
        { apiKey: 'k', preserveRecentMessages: 2, archiveResults: false, ...options },
      );
      const logs: string[] = [];
      const toasts: string[] = [];
      const $ = {
        clock,
        http: { fetch: async (url: string, init?: { body?: string }) => fetchWith(0.9)(url, init) },
        ui: { log: (t: string) => logs.push(t), toast: (t: string) => toasts.push(t) },
      };
      const next = Object.assign(async (e: unknown) => e, {
        signal: new AbortController().signal,
        budget: { ms: 10_000, remainingMs: 10_000 },
      });
      const run = (event: Record<string, unknown>) => hooks['session.compact']!($, event, next);
      return { run, logs, toasts };
    };

    it('input-only savings lift a run over the gate, and the result is {messages}', async () => {
      const event = { trigger: 'auto', messages: proseTranscript() };
      const off = hook({});
      expect(await off.run(event)).toBe(event);
      expect(off.toasts.join('\n')).toContain('fallback to built-in summary');

      const on = hook({ proseTrim: 'trim' });
      const out = await on.run(event);
      expect(Object.keys(out)).toEqual(['messages']);
      expect(out.messages.length).toBe(event.messages.length);
      expect(on.toasts.join('\n')).toMatch(/kept 7\/7 messages, no summary \(.*prose: [1-9]\d* scored, 0 dropped; inputs: 1 elided; [1-9]\d* chars\)/);
      expect(on.logs.some((l) => l.startsWith('decisions: '))).toBe(true);
    });

    it('below the gate the fallback is unchanged and shows no prose text', async () => {
      const event = { trigger: 'auto', messages: transcript() };
      const off = hook({ minReductionRatio: 0.99 });
      const on = hook({ minReductionRatio: 0.99, proseTrim: 'trim' });
      expect(await on.run(event)).toBe(event);
      expect(await off.run(event)).toBe(event);
      for (const run of [on, off]) {
        expect(run.toasts).toHaveLength(1);
        expect(run.toasts[0]).toMatch(/^fallback to built-in summary \(below 99% minimum: /);
      }
      expect(off.toasts[0]).not.toContain('prose:');
    });
  });
});
