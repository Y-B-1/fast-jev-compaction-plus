import { COMPACTED_MARKER, dedupeBlocks, supersededCalls } from './dedupe.js';
import { MAX_QUESTIONS_PER_REQUEST, noulAnswer } from './request.js';
import { salvageBlock } from './salvage.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  ArchiveResult,
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  /**
   * A Noul of 0.5 is Jev saying it is unsure, not "half". Distance from 0.5 is
   * the confidence signal, so a threshold of 0.5 puts every uncertain answer on
   * the delete side of an irreversible decision. Deleting context is the
   * high-stakes action here, so the gate sits on the drop: a call is removed
   * only when Jev is fairly sure it is no longer needed. See
   * https://docs.typesafe.ai/confidence.
   */
  keepThreshold: 0.15,
  /** See `CompactOptions.keepCallThreshold`. */
  keepCallThreshold: 0.05,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 60_000,
  maxConcurrentRequests: 4,
  truncateHeadChars: 150,
  resultPreviewChars: 300,
  salvageChars: 150,
  minResultChars: 500,
  maxKeptResultChars: 4000,
  dedupeRepeats: true,
  minKeepSignalCalls: 3,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/**
 * Jev's second context limit: the state plus the *single longest* question must
 * fit this, independently of the whole-request budget. See
 * https://docs.typesafe.ai/models — "64k tokens per request; 32k tokens for
 * `state` plus the longest question".
 */
const MAX_STATE_PLUS_QUESTION_TOKENS = 32_000;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const keepThreshold = finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold);
  if (keepThreshold < 0 || keepThreshold > 1) {
    throw new RangeError('keepThreshold must be between 0 and 1');
  }
  const keepCallThreshold = finite(options.keepCallThreshold, DEFAULT_OPTIONS.keepCallThreshold);
  if (keepCallThreshold < 0 || keepCallThreshold > 1) {
    throw new RangeError('keepCallThreshold must be between 0 and 1');
  }
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold,
    keepCallThreshold,
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    maxConcurrentRequests: Math.max(
      1,
      Math.floor(finite(options.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    resultPreviewChars: Math.max(
      0,
      Math.floor(finite(options.resultPreviewChars, DEFAULT_OPTIONS.resultPreviewChars)),
    ),
    salvageChars: Math.max(
      0,
      Math.floor(finite(options.salvageChars, DEFAULT_OPTIONS.salvageChars)),
    ),
    minResultChars: Math.max(
      0,
      Math.floor(finite(options.minResultChars, DEFAULT_OPTIONS.minResultChars)),
    ),
    maxKeptResultChars: Math.max(
      0,
      Math.floor(finite(options.maxKeptResultChars, DEFAULT_OPTIONS.maxKeptResultChars)),
    ),
    dedupeRepeats: options.dedupeRepeats ?? DEFAULT_OPTIONS.dedupeRepeats,
    minKeepSignalCalls: Math.max(
      0,
      Math.floor(finite(options.minKeepSignalCalls, DEFAULT_OPTIONS.minKeepSignalCalls)),
    ),
  };
}

/**
 * The two `noul` questions asked about one call: keep the call, keep its
 * result. Both carry criteria, because the boundary is subtle and the docs ask
 * for `true`/`false` sides whenever it is: https://docs.typesafe.ai/primitives/noul.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call \`${call.id}\` (${call.tool}) should stay in \`history\`: knowing this call was made, with its input, still matters for what the assistant does next`,
      criteria: {
        true: 'The call records a change to the world, or a constraint the assistant must not violate again: an edit or write that changed a file, a command that installed, moved or deleted something, a check whose outcome the user was told about',
        false: 'The call only gathered information that has since been superseded or acted upon: a search used to locate a file that was then edited, a read of a file that has since changed, a failing check that has since been fixed',
      },
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call \`${call.id}\` (${call.tool}, ${call.resultChars} chars) should stay in \`history\` verbatim: the assistant still needs its contents, and re-running the tool would not do${
        call.resultPreview ? `. Output preview: ${call.resultPreview}` : ''
      }`,
      criteria: {
        true: 'The exact contents are still in use and could not be recovered by re-running the tool: an error the assistant is still diagnosing, output the user asked about, the current state of a file being edited',
        false: 'The contents are stale, already stated in the assistant text, or trivially re-obtainable: a directory listing already used, a passing test run, a file read before it was rewritten',
      },
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  let currentQuestions = 0;
  for (const call of calls) {
    const questions = questionsFor(call);
    const tokens = estimateTokens(JSON.stringify(questions));
    const count = Object.keys(questions).length;
    if (stateTokens + tokens + REQUEST_OVERHEAD_TOKENS > MAX_STATE_PLUS_QUESTION_TOKENS) {
      throw new Error(
        `state plus one question exceeds Jev's ${MAX_STATE_PLUS_QUESTION_TOKENS}-token limit ` +
          `(~${stateTokens} state + ~${tokens} question); lower maxStateTokens`,
      );
    }
    if (current.length > 0 && (currentTokens + tokens > budget || currentQuestions + count > MAX_QUESTIONS_PER_REQUEST)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
      currentQuestions = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
    currentQuestions += count;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> &
    Partial<Pick<ResolvedCompactOptions, 'keepCallThreshold'>>,
): CallDecision {
  if (
    !Number.isFinite(options.keepThreshold) ||
    options.keepThreshold < 0 ||
    options.keepThreshold > 1
  ) {
    throw new RangeError('keepThreshold must be between 0 and 1');
  }
  // `keepCallThreshold` is newer than this exported function; a caller built
  // against the old signature must not silently start comparing against
  // `undefined` (which would drop every call), so it falls back to the default.
  const keepCallThreshold = finite(options.keepCallThreshold, DEFAULT_OPTIONS.keepCallThreshold);
  if (keepCallThreshold < 0 || keepCallThreshold > 1) {
    throw new RangeError('keepCallThreshold must be between 0 and 1');
  }
  if (
    ![answer.keepCall, answer.keepResult].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    )
  ) {
    throw new Error('Invalid keep probabilities');
  }
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= keepCallThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

/**
 * Runs the batches over a bounded pool of concurrent requests. A batch that
 * fails (after whatever retries the asker itself makes) is salvaged rather
 * than sinking the whole compaction: its calls are simply left unanswered, so
 * `compact` falls back to its safe default (keep) for them, and the other
 * batches' answers still apply. Only when every batch fails is the last
 * failure re-thrown, so a caller that can fall back to a built-in summary
 * still learns why nothing was pruned.
 */
async function askBatches(
  asker: JevAsker,
  state: CompactionState,
  batches: readonly ToolCall[][],
  concurrency: number,
): Promise<{ answered: Map<string, CallAnswer>[]; failed: number }> {
  const answered: Map<string, CallAnswer>[] = new Array(batches.length);
  let cursor = 0;
  let failed = 0;
  let lastFailure: unknown;
  const worker = async (): Promise<void> => {
    while (cursor < batches.length) {
      const index = cursor++;
      try {
        answered[index] = await askBatch(asker, state, batches[index]!);
      } catch (error) {
        failed += 1;
        lastFailure = error;
        answered[index] = new Map();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (failed > 0 && failed === batches.length) throw lastFailure;
  return { answered, failed };
}

/** Whether ending `text` at `index` would separate the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function truncatedResultText(
  text: string,
  isError: boolean,
  headChars: number,
  archivedPath?: string,
  salvageChars = 0,
): string {
  if (text.length <= headChars + 120) return text;
  // End the head on a code point boundary: cutting a surrogate pair in half
  // would leave a lone surrogate in the rebuilt transcript, which the
  // Messages API rejects on every subsequent turn.
  const cut = splitsSurrogatePair(text, headChars) ? headChars - 1 : headChars;
  const head = cut > 0 ? `${text.slice(0, cut)}\n` : '';
  const where = archivedPath ? `; full output: ${archivedPath}` : '; re-run the tool if needed';
  const note = `[fast-jev-compaction truncated ${text.length - cut} chars${isError ? ' (error)' : ''}${where}]`;
  // Identifiers and error lines recovered from the dropped tail: the head is
  // preamble for a listing or a build log, and the useful parts live further
  // down where they would otherwise be lost until the tool is re-run.
  const salvaged = salvageBlock(text.slice(cut), salvageChars);
  return salvaged ? `${head}${note}\n${salvaged}` : `${head}${note}`;
}

/** One line standing in for a dropped call, naming where its output went. */
function droppedCallNote(tool: ToolUse, archivedPath: string | undefined): string {
  let input = '';
  try {
    input = JSON.stringify(tool.input);
  } catch {
    input = '{}';
  }
  if (input.length > 160) input = `${input.slice(0, 159)}…`;
  return `[fast-jev-compaction removed the ${tool.tool} call ${input}${
    archivedPath ? `; full output: ${archivedPath}` : ''
  }]`;
}

function isEmptyMessage(message: {
  text: string;
  toolUses: readonly unknown[];
  toolResults?: readonly unknown[];
}): boolean {
  return (
    message.text.trim().length === 0 &&
    message.toolUses.length === 0 &&
    (message.toolResults?.length ?? 0) === 0
  );
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  archive?: ArchiveResult,
  salvageChars = 0,
  capChars = 0,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  // `cap`: a result Jev kept whole that is longer than `capChars`, cut to its
  // first `capChars` like a dropped result.
  const actions = new Map<string, CallDecision['action'] | 'cap'>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (!call) continue;
    if (decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
    else if (decision.reason === 'kept' && capChars > 0 && call.resultChars > capChars + 120) {
      actions.set(call.tool_use_id, 'cap');
    }
  }
  const cutResult = (id: string, text: string, isError: boolean): string => {
    const action = actions.get(id);
    if (action !== 'drop_result' && action !== 'cap') return text;
    return action === 'cap'
      ? truncatedResultText(text, isError, capChars, archive?.(id, text), 0)
      : truncatedResultText(text, isError, headChars, archive?.(id, text), salvageChars);
  };
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      // An assistant message that came in already fully empty (no text, no
      // tool call, no tool result) carries nothing for Jev's history and
      // nothing to answer with later; a user or tool-carrier message is
      // never dropped this way, since even an empty user turn is a real
      // step in the conversation.
      if (message.role === 'assistant' && isEmptyMessage(message)) continue;
      kept.push(message);
      continue;
    }
    // A dropped call leaves one line naming it and where its output was
    // archived, so a detail inside it can still be recovered.
    const droppedCallNotes = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) === 'drop_call')
      .map((tool) => droppedCallNote(tool, archive?.(tool.tool_use_id, tool.text ?? '')));
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        const text = cutResult(tool.tool_use_id, tool.text ?? '', tool.isError ?? false);
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        const text = cutResult(result.tool_use_id, result.text, result.isError ?? false);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    const text =
      droppedCallNotes.length > 0
        ? [message.text, ...droppedCallNotes].filter(Boolean).join('\n')
        : message.text;
    if (isEmptyMessage({ text, toolUses, toolResults })) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);
  const deduped = resolved.dedupeRepeats
    ? dedupeBlocks(messages, resolved.preserveRecentMessages)
    : { messages: messages.slice(), removed: 0 };
  const source = deduped.messages;
  const calls = collectToolCalls(
    source,
    resolved.preserveRecentMessages,
    resolved.resultPreviewChars,
  );
  // Settled without asking Jev, most protective first: a result an earlier
  // compaction already cut (cutting it again would overwrite its archived
  // full output with the stub), a result too small to be worth a question,
  // then an earlier copy of a call a later identical call supersedes.
  const resultTexts = new Map<string, string>();
  for (const message of source) {
    for (const result of message.toolResults ?? []) resultTexts.set(result.tool_use_id, result.text);
  }
  const superseded = resolved.dedupeRepeats ? supersededCalls(calls) : new Set<string>();
  const settled = new Map<string, CallDecision>();
  for (const call of calls) {
    if (call.pinned) continue;
    const base = { id: call.id, tool: call.tool, keepCall: 1, keepResult: 1 };
    if ((resultTexts.get(call.tool_use_id) ?? '').includes(COMPACTED_MARKER)) {
      settled.set(call.id, { ...base, action: 'keep', reason: 'compacted' });
    } else if (call.resultChars < resolved.minResultChars) {
      settled.set(call.id, { ...base, action: 'keep', reason: 'small' });
    } else if (superseded.has(call.id)) {
      settled.set(call.id, { ...base, keepResult: 0, action: 'drop_result', reason: 'duplicate' });
    }
  }
  const candidates = calls.filter((call) => !call.pinned && !settled.has(call.id));

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  let failedRequests = 0;
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    // Reserve room for the largest question before fitting the state, so a
    // tight maxRequestTokens shrinks the state instead of batching down to a
    // state that leaves no room for even one question.
    const largestQuestion = candidates.reduce(
      (largest, call) => Math.max(largest, estimateTokens(JSON.stringify(questionsFor(call)))),
      0,
    );
    const stateBudget = resolved.maxRequestTokens - REQUEST_OVERHEAD_TOKENS - largestQuestion;
    if (stateBudget < 1) {
      throw new Error('request budget leaves no room for state and questions');
    }
    const state = fitState(source, calls, {
      ...resolved,
      maxStateTokens: Math.min(resolved.maxStateTokens, stateBudget),
    });
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const { answered, failed } = await askBatches(
      asker,
      state.state,
      batches,
      resolved.maxConcurrentRequests,
    );
    failedRequests = failed;
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map(
    (call) =>
      settled.get(call.id) ??
      decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  // Answers that keep nothing at all, not even a call, are what a Jev
  // answering 0 to every question produces: they say nothing about the
  // transcript, yet they pass any reduction floor with the largest cut there
  // is. Treat them as a failure so the caller can fall back.
  const answered = decisions.filter((decision) => answers.has(decision.id));
  if (
    resolved.minKeepSignalCalls > 0 &&
    answered.length >= resolved.minKeepSignalCalls &&
    answered.every((decision) => decision.action === 'drop_call')
  ) {
    throw new Error(
      `no keep signal: Jev dropped all ${answered.length} calls it answered`,
    );
  }
  const kept = applyDecisions(
    source,
    decisions,
    calls,
    resolved.truncateHeadChars,
    options.archive,
    resolved.salvageChars,
    resolved.maxKeptResultChars,
  );
  const capped = new Set(
    calls
      .filter((call) => resolved.maxKeptResultChars > 0 && call.resultChars > resolved.maxKeptResultChars + 120)
      .map((call) => call.id),
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      small: count(decisions, 'small'),
      compacted: count(decisions, 'compacted'),
      duplicates: count(decisions, 'duplicate'),
      resultsCapped: decisions.filter((d) => d.reason === 'kept' && capped.has(d.id)).length,
      inputsElided: 0,
      blocksDeduped: deduped.removed,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      failedRequests,
      ms: Date.now() - started,
    },
  };
}
