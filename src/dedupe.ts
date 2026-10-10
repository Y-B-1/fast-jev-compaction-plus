import { isPinned } from './state.js';
import type { Message, ToolCall } from './types.js';

/**
 * Blocks Claude Code injects into user text that repeat verbatim across a
 * session: reminders, and the output of local slash commands such as
 * `/context`.
 */
const INJECTED_BLOCK = /<(system-reminder|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

/** A repeated block shorter than this is left alone: its marker would save little. */
export const MIN_BLOCK_CHARS = 200;

/** A repeated whole user message (a skill body, a pasted file) shorter than this is left alone. */
export const MIN_REPEATED_MESSAGE_CHARS = 500;

/** Marks text an earlier compaction already cut, so it is never cut or archived again. */
export const COMPACTED_MARKER = '[fast-jev-compaction truncated ';

function blockMarker(tag: string, chars: number): string {
  return `[fast-jev-compaction removed a repeated <${tag}> block (${chars} chars); a later copy is kept]`;
}

function messageMarker(chars: number): string {
  return `[fast-jev-compaction removed a repeated message (${chars} chars); a later copy is kept]`;
}

/**
 * Replaces the earlier copies of text that repeats verbatim in user messages:
 * a whole long message (a skill body loaded twice) or an injected block.
 * The newest copy always stays. Pinned messages and user prompts that carry
 * an engine handle are never changed, though their copies count as the
 * later one. A changed message is a new
 * object built from `role`, `text` and the tool blocks only, so no engine
 * identity carries over to it; every other message is returned as is.
 */
export function dedupeBlocks(
  messages: readonly Message[],
  preserveRecentMessages: number,
): { messages: Message[]; removed: number } {
  const seenMessages = new Set<string>();
  const seenBlocks = new Set<string>();
  const out = messages.slice();
  let removed = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'user' || !message.text) continue;
    const original = message.text;
    const blocks = original.match(INJECTED_BLOCK) ?? [];
    // A user prompt that still carries the engine's handle may hold images
    // the hook API does not show; rebuilding it would drop them. Tool-result
    // rows and messages without a handle carry nothing beyond their text.
    const engineHeld = (message as { handle?: string }).handle !== undefined && (message.toolResults?.length ?? 0) === 0;
    if (!engineHeld && !isPinned(index, messages.length, preserveRecentMessages)) {
      let text = original;
      if (original.length >= MIN_REPEATED_MESSAGE_CHARS && seenMessages.has(original)) {
        text = messageMarker(original.length);
        removed += 1;
      } else {
        text = original.replace(INJECTED_BLOCK, (block, tag: string) => {
          if (block.length < MIN_BLOCK_CHARS || !seenBlocks.has(block)) return block;
          removed += 1;
          return blockMarker(tag, block.length);
        });
      }
      if (text !== original) {
        const rebuilt: Message = { role: message.role, text, toolUses: message.toolUses };
        if (message.toolResults) rebuilt.toolResults = message.toolResults;
        out[index] = rebuilt;
      }
    }
    seenMessages.add(original);
    for (const block of blocks) seenBlocks.add(block);
  }
  return { messages: out, removed };
}

function callKey(call: Pick<ToolCall, 'tool' | 'input'>): string | undefined {
  try {
    return `${call.tool}\u0000${JSON.stringify(call.input)}`;
  } catch {
    return undefined;
  }
}

/**
 * The ids of calls that a later call repeats exactly (same tool, same input):
 * the later output supersedes the earlier one. The latest copy of each is
 * never in the set.
 */
export function supersededCalls(calls: readonly ToolCall[]): Set<string> {
  const seen = new Set<string>();
  const superseded = new Set<string>();
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    const key = callKey(call);
    if (key === undefined) continue;
    if (seen.has(key)) superseded.add(call.id);
    else seen.add(key);
  }
  return superseded;
}
