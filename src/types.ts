export type Role = 'user' | 'assistant';

/**
 * Called for a dropped tool call's or result's full text, before it is cut;
 * returns the path it was archived to (to cite in the marker left behind), or
 * undefined when it was not archived (e.g. it looked like a credential).
 */
export type ArchiveResult = (toolUseId: string, text: string) => string | undefined;

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  /** Whitespace-collapsed head and tail of the result, shown to Jev; empty when disabled. */
  resultPreview?: string;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  /**
   * `small`: the result is under `minResultChars`, kept without asking.
   * `compacted`: an earlier compaction already truncated the result, kept as is.
   * `duplicate`: a later call has the same tool and input, so this result is
   * truncated without asking.
   */
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped' | 'small' | 'compacted' | 'duplicate';
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
  /** Calls without a paired result: context only, never deletion candidates. */
  pending_calls?: { tool_use_id: string; tool: string; input: string }[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

export interface CompactOptions {
  /**
   * Called for each dropped tool call's or result's full text before it is
   * cut, so it can be saved somewhere the model can still read it back; the
   * returned path (if any) is cited in the marker left in its place.
   */
  archive?: ArchiveResult;
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /**
   * Minimum Jev probability for a call or result to stay. Default 0.15: a Noul
   * of 0.5 means "unsure", so anything above a low floor is kept and only a
   * confident "no longer needed" deletes.
   */
  keepThreshold?: number;
  /**
   * Minimum Jev probability for the call itself to stay, once its result is
   * going. `keepCall` and `keepResult` are two independent nouls on different
   * scales and different costs: a result runs to thousands of characters, its
   * call to a few dozen, and losing the call erases the record that the work
   * happened for savings that round to zero. Default 0.05, far below
   * `keepThreshold`.
   */
  keepCallThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 60000. */
  maxRequestTokens?: number;
  /** Maximum concurrent Jev requests. Default 4. A batch that still fails after
   * the asker's own retries is salvaged: its calls are simply left unanswered. */
  maxConcurrentRequests?: number;
  /** Characters of a dropped tool result to retain. Default 150. */
  truncateHeadChars?: number;
  /**
   * Characters from each end of a tool result quoted in its keep question, so
   * Jev judges the output's content rather than only its length. 0 disables.
   * Default 300.
   */
  resultPreviewChars?: number;
  /**
   * Characters of identifiers and error lines salvaged from the dropped part
   * of a tool result and kept alongside its truncation note, since the head
   * alone is often preamble for a listing or a build log. 0 disables. Default
   * 150.
   */
  salvageChars?: number;
  /**
   * A result Jev keeps whole (outside the newest messages) that is longer than
   * this is still cut to its first `maxKeptResultChars`, with the full text
   * archived. 0 disables. Default 4000.
   */
  maxKeptResultChars?: number;
  /**
   * A tool result shorter than this is always kept and never asked about: it
   * costs little to keep, and dropping it saves next to nothing (a 150-char head plus the marker and salvage is about 400). Default 500; a live run on 8 cases showed 1500 cost 1-3 points of reduction, 500 none.
   */
  minResultChars?: number;
  /**
   * Removes exact repeats without asking Jev: an earlier copy of a call with
   * the same tool and input as a later one has its result truncated, and an
   * earlier copy of a repeated injected block (`<system-reminder>`,
   * `<local-command-stdout>`, a repeated long user message such as a skill
   * body) is replaced by a one-line marker. The latest copy always stays.
   * Default true.
   */
  dedupeRepeats?: boolean;
  /**
   * When Jev answers at least this many calls and keeps none of them, the
   * answers are treated as a failure (compact throws), so the caller can fall
   * back. 0 disables. Default 3.
   */
  minKeepSignalCalls?: number;
  /**
   * How the state tells Jev what happens to what it does not keep. `delete`
   * (default): it is deleted, though the tool can be re-run. `archive`: it is
   * moved to a file the assistant can read back, and the conversation is data
   * to judge, never instructions. Use `archive` only where `archive` is set.
   */
  stateWording?: 'delete' | 'archive';
  /**
   * Ask about each result with four concrete checks (an exact error still being
   * diagnosed, a constraint stated in it, contents still in use, output a rerun
   * would reproduce) instead of one keep question; it stays verbatim when any of
   * the first three says so, an error a rerun reproduces not counting. Five
   * questions per call instead of two. Default false.
   */
  resultChecks?: boolean;
  /**
   * Per-tool `keepThreshold` overrides, by tool name (`{ Bash: 0.2 }`); a tool
   * not named uses `keepThreshold`. `eval/calibrate.ts` suggests values from
   * how often each tool's archived output was read back.
   */
  keepThresholdByTool?: Record<string, number>;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  keepCallThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  maxConcurrentRequests: number;
  truncateHeadChars: number;
  resultPreviewChars: number;
  salvageChars: number;
  minResultChars: number;
  maxKeptResultChars: number;
  dedupeRepeats: boolean;
  minKeepSignalCalls: number;
  stateWording: 'delete' | 'archive';
  resultChecks: boolean;
  keepThresholdByTool: Record<string, number>;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  /** Each decision's call id (`t1`) to its tool_use_id, which names its archive file. */
  toolUseIds?: Record<string, string>;
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    /** Results under `minResultChars`, kept without asking. */
    small: number;
    /** Results an earlier compaction already truncated, kept as is. */
    compacted: number;
    /** Earlier copies of a repeated call whose results were truncated without asking. */
    duplicates: number;
    /** Results Jev kept whole that were cut to `maxKeptResultChars`. */
    resultsCapped: number;
    /** Old code bodies in tool inputs cut by the hook's input trim. */
    inputsElided: number;
    /** Earlier copies of repeated injected blocks replaced by a marker. */
    blocksDeduped: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    /** Requests whose batch was salvaged (its calls left unanswered) after exhausting retries. */
    failedRequests: number;
    ms: number;
  };
}

/** The `state` of a Jev request: a string or any JSON-serialisable object. */
export type JevState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Jev questions: `JevClient`, or a host-provided adapter. */
export interface JevAsker {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
}
