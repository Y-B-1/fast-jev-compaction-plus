import { describe, expect, it } from 'vitest';
import { compactCodexItems } from '../src/codex.js';
import type { JevAsker } from '../src/types.js';

const discardResults: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: key.startsWith('call_') ? 1 : 0 }])) };
  },
};

const items = () => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep this exact task and its decisions.' }] },
  { type: 'function_call', call_id: 'old', name: 'exec_command', arguments: '{"cmd":"ls"}' },
  { type: 'function_call_output', call_id: 'old', output: 'obsolete listing\n'.repeat(3000) },
  ...Array.from({ length: 6 }, (_, i) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Exact recent message ${i}` }] })),
];

describe('Codex compaction adapter', () => {
  it('returns indexed output edits while retaining calls, prose, and the original input', async () => {
    const original = items();
    const copy = structuredClone(original);
    const result = await compactCodexItems(original, discardResults);
    expect(original).toEqual(copy);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]?.index).toBe(2);
    expect(result.edits[0]?.output.length).toBeLessThan(1000);
    expect(result.stats.bytesAfter).toBeLessThan(result.stats.bytesBefore / 2);
  });

  it('does not prune structured image output, pending calls, or recent outputs', async () => {
    const original = items();
    original[2] = { type: 'function_call_output', call_id: 'old', output: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }] } as never;
    original.push({ type: 'function_call', call_id: 'pending', name: 'exec_command', arguments: '{}' } as never);
    original.push({ type: 'function_call_output', call_id: 'missing', output: 'orphan'.repeat(2000) } as never);
    original.push({ type: 'custom_tool_call', call_id: 'recent', name: 'apply_patch', input: 'patch' } as never);
    original.push({ type: 'custom_tool_call_output', call_id: 'recent', output: 'new result'.repeat(2000) } as never);
    expect((await compactCodexItems(original, discardResults)).edits).toEqual([]);
  });

  it('keeps history intact when Jev requests fail', async () => {
    const failing: JevAsker = { async ask() { throw new Error('fixture provider unavailable'); } };
    expect((await compactCodexItems(items(), failing)).edits).toEqual([]);
  });

  it('supports freeform tool outputs and preserves unsuccessful-result status outside the edit', async () => {
    const original = items();
    original[1] = { type: 'custom_tool_call', call_id: 'old', name: 'apply_patch', input: 'fixture patch' } as never;
    original[2] = { type: 'custom_tool_call_output', call_id: 'old', output: 'obsolete result\n'.repeat(3000), success: false } as never;
    const result = await compactCodexItems(original, discardResults);
    expect(result.edits[0]?.index).toBe(2);
    expect(original[2]).toHaveProperty('success', false);
  });

  it('reports unchanged bytes when savings fall below the configured minimum', async () => {
    const result = await compactCodexItems(items(), discardResults, { minReductionRatio: 1 });
    expect(result.edits).toEqual([]);
    expect(result.stats.bytesAfter).toBe(result.stats.bytesBefore);
  });

  it('rejects an invalid minimum before making a Jev request', async () => {
    let requested = false;
    const jev: JevAsker = { async ask() { requested = true; throw new Error('must not request'); } };
    await expect(compactCodexItems(items(), jev, { minReductionRatio: 2 })).rejects.toThrow(RangeError);
    expect(requested).toBe(false);
  });

  it('preserves output from an unfinished custom call', async () => {
    const original = items();
    original[1] = { type: 'custom_tool_call', call_id: 'old', name: 'apply_patch', input: 'fixture patch', status: 'in_progress' } as never;
    original[2] = { type: 'custom_tool_call_output', call_id: 'old', output: 'partial result'.repeat(3000) } as never;
    expect((await compactCodexItems(original, discardResults)).edits).toEqual([]);
  });

});
