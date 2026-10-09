import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
} from 'claude-code';

import { compact, messageChars, reductionRatio, resolveOptions } from '../src/compact.js';
import { trimOutput } from '../src/output.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  isRetryableStatus,
  parseJevResponse,
  retryDelayMs,
} from '../src/request.js';
import { applyProse, callActions, PROSE_KEEP_LADDER, scoreProse, type ProseStats } from '../src/prose.js';
import { redactCompactionState, redactText } from '../src/redact.js';
import { goalFromMessages } from '../src/state.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

/**
 * Which compactions Jev could not do may go on to Claude Code's built-in
 * summary: `auto` (default) only the engine's own, `always` every one,
 * `never` none.
 */
export type BuiltinFallback = 'auto' | 'always' | 'never';

const HOOK_DEFAULTS = {
  archiveResults: true,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  builtinFallback: 'auto' as BuiltinFallback,
  /** Opt-in: when tool compaction falls short of `minReductionRatio`, also drop filler from old assistant prose before falling back. */
  proseTrim: false,
  /** Opt-in: trims a Bash command's stdout through Jev at tool.call time, before compaction ever sees it. Off by default — a second Jev call site of its own, see `jevPruneBashOutput`. */
  jevPruneBashOutput: false,
  /** stdout shorter than this is never sent to Jev for trimming. */
  jevPruneMinChars: 4_000,
};


export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
  /** Lower-cased response headers, when the engine gives them (for `retry-after`). */
  headers?: Record<string, string>;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  archiveResults: boolean;
  minReductionRatio: number;
  model: string;
  builtinFallback: BuiltinFallback;
  proseTrim: boolean;
  jevPruneBashOutput: boolean;
  jevPruneMinChars: number;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionFallback(options: PluginOptions): BuiltinFallback {
  const value = options['builtinFallback'];
  return value === 'auto' || value === 'always' || value === 'never'
    ? value
    : HOOK_DEFAULTS.builtinFallback;
}

/**
 * Whether a compaction Jev could not do may be handed to the built-in summary.
 * Only the engine's own `auto` compaction (its threshold, or a prompt too
 * long) must shrink the conversation; `/compact` (`manual`), a plugin's
 * request and a `precompute` can leave it as it is, which is free, where the
 * summary is a long model call that rewrites the verbatim history.
 */
export function mayUseBuiltin(trigger: string | undefined, mode: BuiltinFallback): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return trigger === 'auto';
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'keepCallThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'resultPreviewChars',
    'salvageChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    archiveResults:
      typeof options['archiveResults'] === 'boolean'
        ? options['archiveResults']
        : HOOK_DEFAULTS.archiveResults,
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    builtinFallback: optionFallback(options),
    proseTrim:
      typeof options['proseTrim'] === 'boolean' ? options['proseTrim'] : HOOK_DEFAULTS.proseTrim,
    jevPruneBashOutput:
      typeof options['jevPruneBashOutput'] === 'boolean'
        ? options['jevPruneBashOutput']
        : HOOK_DEFAULTS.jevPruneBashOutput,
    jevPruneMinChars: Math.max(
      0,
      Math.floor(optionNumber(options, 'jevPruneMinChars', HOOK_DEFAULTS.jevPruneMinChars)),
    ),
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** Resolves after `ms`; rejects with the signal's reason when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type JevAskerOptions = {
  /** Deadline for each attempt. Default 20000 ms. */
  timeoutMs?: number;
  /** The hook's `next.signal`: ends a pending request when the dispatch ends. */
  signal?: AbortSignal;
  /**
   * The timer behind the deadline and the retry delay. The hook passes
   * `$.clock.sleep`: its runtime has no `setTimeout`, `AbortSignal.timeout`
   * or `AbortSignal.any`. Defaults to `setTimeout`, for use outside a hook.
   */
  sleep?: Sleep;
  /**
   * The hook's remaining budget (`next.budget.remainingMs`). A `$.clock` wait
   * is the one `$` call that spends it, so a retry delay it cannot afford is
   * skipped rather than overrunning the hook.
   */
  remainingMs?: () => number;
};

const JEV_TIMEOUT_MS = 20_000;
/** Budget a retry must leave for its own request and the hook's work after it. */
const RETRY_MARGIN_MS = 2_000;

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('Jev request aborted');
}

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const timerSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    // Not in the hook runtime's globals; only reached outside a hook.
    const { setTimeout, clearTimeout } = globalThis as unknown as Timers;
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Races `promise` against `timeoutMs` and `signal`. `$.http.fetch` takes no
 * signal of its own, so a hung call is abandoned rather than cancelled; what
 * matters is that the hook stops waiting on it. Once the race settles, the
 * deadline's wait is cancelled too.
 */
async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  what: string,
  sleep: Sleep,
): Promise<T> {
  // A call abandoned by a lost race may still reject later; that is expected.
  promise.catch(() => {});
  if (signal?.aborted) throw abortReason(signal);
  const stop = new AbortController();
  const forward = () => stop.abort(abortReason(signal));
  signal?.addEventListener('abort', forward, { once: true });
  const deadline = sleep(timeoutMs, stop.signal).then(
    () => {
      const error = new Error(`${what} timed out after ${timeoutMs} ms`);
      error.name = 'TimeoutError';
      throw error;
    },
    (error: unknown) => {
      throw signal?.aborted ? abortReason(signal) : error;
    },
  );
  deadline.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    signal?.removeEventListener('abort', forward);
    if (!stop.signal.aborted) stop.abort();
  }
}

/**
 * A `JevAsker` over the engine's `$.http.fetch`: each attempt is bounded by a
 * timeout and the hook's signal, and a 429 or 5xx is retried once, after the
 * `retry-after` delay when the engine reports one.
 */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  options: JevAskerOptions = {},
): JevAsker {
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const { signal } = options;
  const sleep = options.sleep ?? timerSleep;
  const remainingMs = options.remainingMs ?? (() => Infinity);
  return {
    async ask(state, questions) {
      // The state carries transcript text and tool inputs verbatim, and each
      // keep question quotes a head and tail of its tool result; a command,
      // an env var, or a pasted key in either must not leave the machine.
      const request = buildJevRequest(
        { apiKey, model },
        redactCompactionState(state, apiKey),
        redactCompactionState(questions, apiKey),
      );
      const attempt = () =>
        bounded(
          fetchFn(request.url, { method: request.method, headers: request.headers, body: request.body }),
          timeoutMs,
          signal,
          'Jev request',
          sleep,
        );
      let response = await attempt();
      if (!response.ok && isRetryableStatus(response.status)) {
        const delay = retryDelayMs(response.headers?.['retry-after']);
        if (delay < remainingMs() - RETRY_MARGIN_MS) {
          if (delay > 0) await sleep(delay, signal);
          response = await attempt();
        }
      }
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

/** What the prose-trim rescue did: the keep cut-off it settled on, or none when no cut-off reached the minimum or the stage failed. */
export type ProseOutcome = { cutoff?: number; stats: ProseStats };

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
  /** Set only when `proseTrim` is on and tool compaction fell short. */
  prose?: ProseOutcome;
};

const ARCHIVE_DIR = '.claude/fast-jev-compaction';

export type ArchiveWriter = {
  /** Names the file a dropped call's or result's full text will be written to. */
  cite: (toolUseId: string, text: string) => string | undefined;
  /** Writes the files named so far. */
  flush: () => Promise<void>;
};

/**
 * Saves what compaction drops to `.claude/fast-jev-compaction/`, so a detail
 * buried in a dropped call or result can still be read back later. The text is
 * written with the same redaction the Jev request applies, so a credential in
 * it is replaced by `[REDACTED]` rather than stored, and the rest is kept.
 */
export function archiveWriter($: {
  fs: {
    exists: (path: string) => Promise<boolean>;
    write: (path: string, text: string) => Promise<void>;
  };
}): ArchiveWriter {
  const pending = new Map<string, string>();
  return {
    cite(toolUseId, text) {
      if (!text) return undefined;
      const path = `${ARCHIVE_DIR}/${toolUseId}.txt`;
      pending.set(path, redactText(text, undefined));
      return path;
    },
    async flush() {
      if (pending.size === 0) return;
      const ignorePath = `${ARCHIVE_DIR}/.gitignore`;
      if (!(await $.fs.exists(ignorePath))) await $.fs.write(ignorePath, '*\n');
      for (const [path, text] of pending) await $.fs.write(path, text);
      pending.clear();
    },
  };
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  archive?: ArchiveWriter,
  askerOptions: JevAskerOptions = {},
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const asker = jevAsker(fetchFn, config.apiKey, config.model, askerOptions);
  const result = await compact(messages, asker, {
    ...config,
    ...(archive ? { archive: archive.cite } : {}),
  });
  if (archive) await archive.flush();
  const tool = { result, messages: toSessionMessages(messages, result.messages) };
  if (!config.proseTrim || reductionRatio(result) >= config.minReductionRatio) return tool;
  return { ...tool, ...(await rescueWithProse(messages, result, asker, config)) };
}

/**
 * Scores the prose of tool compaction's result with Jev once, then walks `PROSE_KEEP_LADDER` offline
 * on those scores and takes the first cut-off whose result reaches `minReductionRatio` against the
 * original messages. Returns only `prose` when none does or the stage fails, so the caller keeps
 * tool compaction's result.
 */
async function rescueWithProse(
  messages: readonly SessionMessage[],
  result: CompactResult,
  asker: JevAsker,
  config: HookConfig,
): Promise<Partial<SessionCompaction> & { prose: ProseOutcome }> {
  const options = resolveOptions(config);
  let scores;
  try {
    scores = await scoreProse(
      result.messages,
      callActions(messages, result.decisions, options.preserveRecentMessages),
      asker,
      options,
    );
  } catch (error) {
    return { prose: { stats: failedStats(error) } };
  }
  if (scores.stats.failed !== undefined) return { prose: { stats: scores.stats } };
  for (const cutoff of PROSE_KEEP_LADDER) {
    const trimmed = applyProse(scores, cutoff);
    const charsAfter = trimmed.messages.reduce((sum, message) => sum + messageChars(message), 0);
    const candidate = { ...result, messages: trimmed.messages, stats: { ...result.stats, charsAfter } };
    if (reductionRatio(candidate) >= config.minReductionRatio) {
      return {
        result: candidate,
        messages: toSessionMessages(messages, trimmed.messages),
        prose: { cutoff, stats: trimmed.stats },
      };
    }
  }
  return { prose: { stats: scores.stats } };
}

function failedStats(error: unknown): ProseStats {
  return {
    scored: 0,
    dropped: 0,
    inputsElided: 0,
    proseCharsSaved: 0,
    inputCharsSaved: 0,
    requests: 0,
    failedRequests: 0,
    failed: error instanceof Error ? error.message : String(error),
  };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult, prose?: ProseOutcome): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    prose?.cutoff === undefined
      ? ''
      : `; prose trim at ${prose.cutoff}: ${prose.stats.dropped} dropped, ${prose.stats.inputsElided} inputs elided, ${
          prose.stats.proseCharsSaved + prose.stats.inputCharsSaved
        } chars`
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

function settingsEnv(settings: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const env = settings['env'];
  if (!env || typeof env !== 'object') return undefined;
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The `apiKey` option, then TYPESAFE_API_KEY from the environment and then
 * the settings' `env` block; an empty string counts as unset at every step.
 * An OpenRouter key (`sk-or-`) is refused, never sent to TypeSafe.
 */
export async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  let key = config.apiKey;
  if (!key) {
    const settings = await $.settings.read();
    // $.env.get needs a literal name at each call site so the plugin's env
    // reads can be listed statically.
    key = (await $.env.get('TYPESAFE_API_KEY')) || settingsEnv(settings, 'TYPESAFE_API_KEY');
  }
  if (key?.startsWith('sk-or-')) {
    throw new Error('an OpenRouter key is configured; fast-jev now uses TypeSafe: set TYPESAFE_API_KEY');
  }
  return key || undefined;
}

/** `$.clock.sleep` as a `Sleep`: the hook runtime's only timer. */
function clockSleep($: {
  clock: { sleep: (ms: number, options?: { signal?: AbortSignal }) => Promise<void> };
}): Sleep {
  return (ms, signal) => $.clock.sleep(ms, signal ? { signal } : undefined);
}

function log($: { ui: { log: (text: string) => void } }, text: string): void {
  try {
    $.ui.log(text);
  } catch {
    // Diagnostics are best-effort; the compaction result must still be returned.
  }
}

/** An interrupted dispatch is vetoed quietly: no summary, nothing replaced. */
function interrupted($: { ui: { log: (text: string) => void } }): { skip: string } {
  log($, 'compaction interrupted; nothing changed');
  return { skip: 'fast-jev-compaction: interrupted' };
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  log($, text);
  try {
    $.ui.toast(text, { timeoutMs: 15_000 });
  } catch {
    // A disconnected UI must not prevent the native fallback.
  }
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);

  on('session.compact', async ($, event, next) => {
    // A subagent's or a fork's own transcript is not the main conversation
    // this plugin is tuned for; let the engine handle it as it normally
    // would. `precompute` computes nothing yet and installs no result, so
    // there is nothing useful for Jev to do here either.
    if (event.agentId) return next(event);
    if (event.trigger === 'precompute') {
      return { skip: 'fast-jev-compaction does not handle speculative compactions' };
    }
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      if (event.instructions?.trim()) {
        const goal = config.goal || goalFromMessages(event.messages);
        config.goal = `${goal}\n\nCompaction instructions: ${event.instructions}`;
      }
      const { result, messages, prose } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text, headers: response.headers };
        },
        config.archiveResults ? archiveWriter($) : undefined,
        { signal: next.signal, sleep: clockSleep($), remainingMs: () => next.budget.remainingMs },
      );
      if (next.signal.aborted) return interrupted($);
      for (const line of decisionLogLines(result)) log($, line);
      if (reductionRatio(result) < config.minReductionRatio) {
        const tried = prose ? ', prose trim tried' : '';
        if (!mayUseBuiltin(event.trigger, config.builtinFallback)) {
          notify(
            $,
            `skipped (below ${percent(config.minReductionRatio)} minimum${tried}, builtin fallback disabled for ${event.trigger ?? 'this'} trigger: ${summarize(result)})`,
          );
          return { skip: 'fast-jev-compaction: below minimum reduction, builtin fallback disabled' };
        }
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum${tried}: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result, prose)})`,
      );
      return { messages };
    } catch (error) {
      if (next.signal.aborted) return interrupted($);
      if (!mayUseBuiltin(event.trigger, configured.builtinFallback)) {
        notify(
          $,
          `skipped (builtin fallback disabled for ${event.trigger ?? 'this'} trigger: ${error instanceof Error ? error.message : String(error)})`,
        );
        return { skip: 'fast-jev-compaction: request failed, builtin fallback disabled' };
      }
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  // Opt-in (see HOOK_DEFAULTS.jevPruneBashOutput): trims a Bash command's
  // stdout through Jev before the model ever sees it, the same idea as
  // compaction applied at tool.call time to one result. A short-circuit on
  // length runs before anything else, so a plugin left enabled costs nothing
  // on the ordinary, short-output case.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e);
    if (!configured.jevPruneBashOutput || result.deny || !result.result) return result;
    const output = result.result as {
      stdout?: string;
      isImage?: boolean;
      backgroundTaskId?: string;
      persistedOutputPath?: string;
      rawOutputPath?: string;
    };
    // Never touch an image result, a still-running background command, or an
    // output the engine already moved to disk for being too large — trimming
    // those would be either meaningless or redundant.
    if (
      output.isImage ||
      output.backgroundTaskId ||
      output.persistedOutputPath ||
      output.rawOutputPath
    ) {
      return result;
    }
    const stdout = output.stdout ?? '';
    if (stdout.length < configured.jevPruneMinChars) return result;
    try {
      const apiKey = await getApiKey($, configured);
      if (!apiKey) return result;
      const asker = jevAsker(
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text, headers: response.headers };
        },
        apiKey,
        configured.model,
        { signal: next.signal, sleep: clockSleep($), remainingMs: () => next.budget.remainingMs },
      );
      const trimmed = await trimOutput(
        { command: typeof e.command === 'string' ? e.command : '', goal: configured.goal ?? '', output: stdout },
        asker,
        { minChars: configured.jevPruneMinChars },
      );
      if (!trimmed.trimmed) return result;
      return { result: { ...output, stdout: trimmed.output }, context: result.context };
    } catch (error) {
      log($, `bash output trim skipped (${error instanceof Error ? error.message : String(error)})`);
      return result;
    }
  });
};

export { resolveOptions };
