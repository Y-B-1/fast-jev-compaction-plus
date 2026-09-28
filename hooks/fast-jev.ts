import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { trimOutput } from '../src/output.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
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
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  builtinFallback: 'auto' as BuiltinFallback,
  /**
   * Turns to wait, after a compaction attempt that leaves the window still at
   * or above `compactAtPercent`, before requesting another one. Without a
   * cooldown, a round that Jev cannot usefully shrink (nothing left to prune,
   * or a result too small to clear `minReductionRatio`) re-fires a paid Jev
   * call on every following turn while the window sits at the threshold.
   */
  compactCooldownTurns: 3,
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
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  archiveResults: boolean;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  builtinFallback: BuiltinFallback;
  compactCooldownTurns: number;
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
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    builtinFallback: optionFallback(options),
    compactCooldownTurns: Math.max(
      0,
      Math.floor(optionNumber(options, 'compactCooldownTurns', HOOK_DEFAULTS.compactCooldownTurns)),
    ),
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

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      // The state carries transcript text and tool inputs verbatim; a
      // command, an env var, or a pasted key in there must not leave the
      // machine before every request is sent.
      const request = buildJevRequest({ apiKey, model }, redactCompactionState(state, apiKey), questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
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

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
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
 * buried in a dropped call or result can still be read back later. Text that
 * looks like a credential is never written, matching what the Jev request
 * itself redacts.
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
      if (!text || redactText(text, undefined) !== text) return undefined;
      const path = `${ARCHIVE_DIR}/${toolUseId}.txt`;
      pending.set(path, text);
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
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('OPENROUTER_API_KEY (or TYPESAFE_API_KEY) is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), {
    ...config,
    ...(archive ? { archive: archive.cite } : {}),
  });
  if (archive) await archive.flush();
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
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
 * OPENROUTER_API_KEY, falling back to TYPESAFE_API_KEY, each checked in the
 * environment and then in the settings' `env` block; an empty string counts
 * as unset at every step, so it falls through to the next source instead of
 * blocking the fallback chain.
 */
export async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const settings = await $.settings.read();
  for (const name of ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY'] as const) {
    const key = (await $.env.get(name)) || settingsEnv(settings, name);
    if (key) return key;
  }
  return undefined;
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
  let compacting = false;
  // Turn index (not wall-clock time) a next compaction attempt may run at,
  // set after an attempt that left the window at or above compactAtPercent.
  // The usage check below still runs every turn, so a window that drops
  // below the threshold on its own is not held back by the cooldown.
  let nextAttemptAtTurn = 0;
  let turnIndex = 0;

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
      const { result, messages } = await compactSession(
        event.messages,
        config,
        async (url, init) => {
          const response = await $.http.fetch(url, init);
          return { status: response.status, ok: response.ok, text: response.text };
        },
        config.archiveResults ? archiveWriter($) : undefined,
      );
      if (next.signal.aborted) return interrupted($);
      for (const line of decisionLogLines(result)) log($, line);
      if (reductionRatio(result) < config.minReductionRatio) {
        if (!mayUseBuiltin(event.trigger, config.builtinFallback)) {
          notify(
            $,
            `skipped (below ${percent(config.minReductionRatio)} minimum, builtin fallback disabled for ${event.trigger ?? 'this'} trigger: ${summarize(result)})`,
          );
          return { skip: 'fast-jev-compaction: below minimum reduction, builtin fallback disabled' };
        }
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
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

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // A subagent's turn is not the main conversation; requesting the main
    // loop's compaction from it would target the wrong loop while the
    // subagent's own turn still runs. Only a turn that actually answered
    // should trigger auto-compaction: an aborted, refused or errored turn
    // is not a point where the context has settled into something worth
    // scoring speculatively.
    const turn = ++turnIndex;
    if (event.agentId || event.reason !== 'answer' || compacting) return next(event);
    // Locked before the first await: two turns completing back to back must
    // not both read `compacting` as false and both dispatch a compaction.
    compacting = true;
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      // A previous attempt already ran and left the window at or above the
      // threshold (nothing left to prune, or a reduction too small to keep);
      // wait out the cooldown instead of re-asking Jev every single turn.
      if (turn < nextAttemptAtTurn) return next(event);
      nextAttemptAtTurn = turn + configured.compactCooldownTurns;
      await $.session.compact();
    } catch (error) {
      log(
        $,
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
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
          return { status: response.status, ok: response.ok, text: response.text };
        },
        apiKey,
        configured.model,
      );
      const trimmed = await trimOutput(
        { command: e.command, goal: configured.goal ?? '', output: stdout },
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
