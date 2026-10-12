import {
  type NotificationApplied,
  type NotificationScores,
  type NotificationStats,
  type Rung,
  applyNotifications,
  ladderRescueWith,
  mergeNotifications,
  scoreNotifications,
} from './notifications.js';
import {
  PROSE_KEEP_LADDER,
  type ProseScores,
  type ProseStats,
  applyProse,
  callActions,
  scoreProse,
} from './prose.js';
import { type InjectApplied, type InjectStats, applyInjected, scoreInjected } from './inject.js';
import { sha256Hex } from './sha256.js';
import type { CompactResult, JevAsker, Message, ResolvedCompactOptions } from './types.js';

/** The prose stats of a stage that threw before any answer came back. */
export function failedProseStats(error: unknown): ProseStats {
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

export type TrimApplied = {
  messages: Message[];
  prose?: ReturnType<typeof applyProse>;
  notified?: NotificationApplied;
  injected?: InjectApplied;
};

export type TrimRescue = {
  /** The stages' scoring outcome, kept even when no rung is chosen. */
  out: { prose?: { stats: ProseStats }; notifications?: { stats: NotificationStats }; injected?: { stats: InjectStats } };
  /** The first rung whose result reaches `minRatio`; undefined when none does or every stage failed. */
  rescue?: { rung: Rung; result: CompactResult; applied: TrimApplied };
  /** The notification scores, for a caller that wants to reapply them offline. */
  scores?: NotificationScores;
};

/**
 * The rescue with notification trim on: scores the prose (when `proseTrim` is on) and the
 * `<task-notification>` reports once each, then walks the prose ladder and a final `all` rung
 * offline, applying both stages at each rung, and takes the first whose result reaches
 * `minRatio` against the original messages. Only the chosen rung's archive files are
 * handed to `archive.cite`. A stage that fails is skipped and the other still runs.
 */
/** A notification's archive id: its task id plus a short hash of its text, unique across compactions. */
export function notificationArchiveId(id: string, text: string): string {
  return `${id}-${sha256Hex(text).slice(0, 8)}`;
}

export async function trimRescue(input: {
  messages: readonly Message[];
  result: CompactResult;
  asker: JevAsker;
  options: ResolvedCompactOptions;
  proseTrim: boolean;
  /** Score and fold `<task-notification>` reports; default true. */
  notificationTrim?: boolean;
  /** Score and fold injected blocks in user rows (`src/inject.ts`); off unless set (the hook passes its default). */
  injectTrim?: boolean;
  /** Archive and mark each prose cut (`replyTrim`); without it prose cuts as in 0.10.0. */
  replyTrim?: boolean;
  minRatio: number;
  archive: { cite: (id: string, text: string) => string | undefined };
  /** The path `archive.cite` will return for an archive id. */
  pathOf: (id: string) => string;
}): Promise<TrimRescue> {
  const { messages, result, asker, options, archive, pathOf } = input;
  const out: TrimRescue['out'] = {};
  let proseScores: ProseScores | undefined;
  if (input.proseTrim) {
    try {
      proseScores = await scoreProse(
        result.messages,
        callActions(messages, result.decisions, options.preserveRecentMessages),
        asker,
        { ...options, archive: archive.cite },
      );
    } catch (error) {
      out.prose = { stats: failedProseStats(error) };
    }
    if (proseScores?.stats.failed !== undefined) {
      out.prose = { stats: proseScores.stats };
      proseScores = undefined;
    }
  }
  const notifying = input.notificationTrim ?? true;
  // Both stages catch their own failures, so they can ask Jev side by side.
  const [scores, injectScores] = await Promise.all([
    notifying ? scoreNotifications(result.messages, asker, options) : undefined,
    input.injectTrim ? scoreInjected(result.messages, asker, options) : undefined,
  ]);
  if (scores) out.notifications = { stats: scores.stats };
  const notificationsUsable = scores !== undefined && scores.stats.failed === undefined && scores.entries.length > 0;
  if (injectScores && (injectScores.stats.eligible > 0 || injectScores.stats.failed !== undefined)) out.injected = { stats: injectScores.stats };
  const injectUsable = injectScores !== undefined && injectScores.stats.failed === undefined && injectScores.blocks.length > 0;
  if (!proseScores && !notificationsUsable && !injectUsable) return { out, ...(scores ? { scores } : {}) };

  const lastProse = PROSE_KEEP_LADDER[PROSE_KEEP_LADDER.length - 1] as number;
  const apply = (rung: Rung): TrimApplied => {
    const prose = proseScores ? applyProse(proseScores, rung === 'all' ? lastProse : rung, input.replyTrim ? (id) => pathOf(id) : undefined) : undefined;
    const notified = notificationsUsable && scores ? applyNotifications(scores, rung, (id, text) => pathOf(notificationArchiveId(id, text))) : undefined;
    const injected = injectUsable && injectScores ? applyInjected(injectScores, rung, (id) => pathOf(id)) : undefined;
    let merged = prose?.messages ?? result.messages;
    if (notified) merged = mergeNotifications(merged, notified.replaced);
    if (injected) merged = mergeNotifications(merged, injected.replaced);
    return { messages: merged, prose, notified, injected };
  };
  const rescue = ladderRescueWith(apply, result, input.minRatio);
  if (proseScores) out.prose = { stats: proseScores.stats };
  if (!rescue) return { out, ...(scores ? { scores } : {}) };
  for (const item of rescue.applied.notified?.archived ?? []) {
    if (archive.cite(notificationArchiveId(item.id, item.text), item.text) !== item.path) {
      throw new Error(`archive path for ${item.id} is not ${item.path}`);
    }
  }
  for (const item of rescue.applied.prose?.archived ?? []) {
    if (archive.cite(item.id, item.text) !== item.path) throw new Error(`archive path for ${item.id} is not ${item.path}`);
  }
  for (const item of rescue.applied.injected?.archived ?? []) {
    if (archive.cite(item.id, item.text) !== item.path) throw new Error(`archive path for ${item.id} is not ${item.path}`);
  }
  return { out, rescue, ...(scores ? { scores } : {}) };
}
