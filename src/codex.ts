import { compact } from './compact.js';
import type { CompactOptions, JevAsker, Message } from './types.js';

export type CodexItem = Record<string, unknown>;
export interface CodexEdit { index: number; output: string }
export interface CodexResult {
  version: 1;
  edits: CodexEdit[];
  stats: { bytesBefore: number; bytesAfter: number; requests: number; failedRequests: number };
}

function text(item: CodexItem): string {
  const content = item.type === 'reasoning' ? item.summary : item.content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

/** Preserve native items; translate only completed, scalar tool results into edits. */
export async function compactCodexItems(
  items: CodexItem[],
  jev: JevAsker,
  options: CompactOptions & { minReductionRatio?: number } = {},
): Promise<CodexResult> {
  const messages: Message[] = items.map((item) => ({ role: item.role === 'user' ? 'user' : 'assistant', text: text(item), toolUses: [] }));
  const calls = new Map<string, number>();
  const outputs = new Map<string, number>();
  const ambiguous = new Set<string>();
  items.forEach((item, index) => {
    if (typeof item.call_id !== 'string') return;
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (calls.has(item.call_id)) ambiguous.add(item.call_id);
      calls.set(item.call_id, index);
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (outputs.has(item.call_id)) ambiguous.add(item.call_id);
      outputs.set(item.call_id, index);
    }
  });
  for (const [id, outputIndex] of outputs) {
    const callIndex = calls.get(id);
    const output = items[outputIndex];
    if (callIndex === undefined || callIndex >= outputIndex || ambiguous.has(id) || typeof output.output !== 'string') continue;
    const call = items[callIndex];
    if ((call.type === 'custom_tool_call') !== (output.type === 'custom_tool_call_output')) continue;
    // Preserve raw arguments as context rather than guessing an argument schema.
    messages[callIndex].toolUses = [{ tool_use_id: id, tool: String(call.name ?? 'tool'), input: { arguments: call.arguments ?? call.input }, text: output.output, isError: output.success === false }];
    messages[outputIndex].toolResults = [{ tool_use_id: id, text: output.output, isError: output.success === false }];
  }
  let result;
  try {
    result = await compact(messages, jev, { ...options, keepCallThreshold: 0, preserveRecentMessages: Math.max(6, options.preserveRecentMessages ?? 6) });
  } catch {
    const bytes = Buffer.byteLength(JSON.stringify(items));
    return { version: 1, edits: [], stats: { bytesBefore: bytes, bytesAfter: bytes, requests: 1, failedRequests: 1 } };
  }
  const edits: CodexEdit[] = [];
  for (const message of result.messages) {
    for (const output of message.toolResults ?? []) {
      const index = outputs.get(output.tool_use_id);
      if (index === undefined) continue;
      const original = items[index].output;
      if (typeof original === 'string' && Buffer.byteLength(output.text) < Buffer.byteLength(original) && Buffer.byteLength(output.text) <= 40_000) edits.push({ index, output: output.text });
    }
  }
  const bytesBefore = Buffer.byteLength(JSON.stringify(items));
  const replacement = items.map((item) => ({ ...item }));
  for (const edit of edits) replacement[edit.index].output = edit.output;
  const bytesAfter = Buffer.byteLength(JSON.stringify(replacement));
  const minimum = options.minReductionRatio ?? 0.25;
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new RangeError('minReductionRatio must be between 0 and 1');
  return {
    version: 1,
    edits: bytesBefore > 0 && (bytesBefore - bytesAfter) / bytesBefore >= minimum ? edits : [],
    stats: { bytesBefore, bytesAfter, requests: result.stats.requests, failedRequests: result.stats.failedRequests },
  };
}
