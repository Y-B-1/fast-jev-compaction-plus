import { describe, expect, it } from 'vitest';
import { calibrate, render } from './calibrate.js';

const compaction = (calls: [string, string, string, number, number, string][]) => JSON.stringify({ calls });
const read = (...files: string[]) => JSON.stringify({ readBack: files });

describe('calibrate', () => {
  const bash = Array.from({ length: 12 }, (_, i) => ['Bash', 'drop_result', 'result_dropped', 0.9, i === 0 ? 0.22 : 0.05, `b${i}.txt`] as [string, string, string, number, number, string]);
  const reads = Array.from({ length: 12 }, (_, i) => ['Read', 'drop_result', 'result_dropped', 0.9, 0.04, `r${i}.txt`] as [string, string, string, number, number, string]);

  it('suggests the threshold that would have kept every read-back drop, per tool', () => {
    const out = calibrate([compaction([...bash, ...reads]), read('b0.txt'), read('b3.txt'), read('*')]);
    expect(out.rows.find((r) => r.tool === 'Bash')).toMatchObject({ dropped: 12, readBack: 2, maxReadBackScore: 0.22, suggested: 0.25 });
    expect(out.rows.find((r) => r.tool === 'Read')).toMatchObject({ dropped: 12, readBack: 0 });
    expect(out.rows.find((r) => r.tool === 'Read')!.suggested).toBeUndefined();
    expect(out.unattributed).toBe(1);
    expect(out.option).toBe('Bash=0.25');
    expect(render(out)).toContain('keepThresholdByTool: Bash=0.25');
  });

  it('ignores reads that came before the cut, tools with too few cuts, and kept results', () => {
    const out = calibrate([read('b0.txt'), compaction([...bash.slice(0, 5), ['Grep', 'keep', 'kept', 0.9, 0.9, '']])]);
    expect(out.rows.find((r) => r.tool === 'Bash')).toMatchObject({ dropped: 5, readBack: 0 });
    expect(out.rows.some((r) => r.tool === 'Grep')).toBe(false);
    expect(out.option).toBe('');
  });

  it('caps a suggestion and skips torn lines', () => {
    const high = bash.map((c, i) => (i === 0 ? ([...c.slice(0, 4), 0.8, c[5]] as typeof c) : c));
    expect(calibrate([compaction(high), '{"calls": [', read('b0.txt')]).option).toBe('Bash=0.45');
  });
});
