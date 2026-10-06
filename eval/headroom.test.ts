import { describe, expect, it } from 'vitest';
import { elideBody } from '../src/prose.js';
import type { Message } from '../src/types.js';
import { shares } from './headroom.js';

const asst = (text: string, toolUses: Message['toolUses'] = []): Message => ({ role: 'assistant', text, toolUses });
const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const use = (tool: string, input: Record<string, unknown>) => ({ tool_use_id: 't', tool, input });

describe('shares', () => {
  const prose = 'We checked the logs and found the queue stalled overnight. '.repeat(20);
  const body = 'const value = compute(1);\n'.repeat(100);
  const script = 'cat > out.sh <<EOF\n' + 'echo line of the generated script\n'.repeat(80) + 'EOF\n';
  const pad = (n: number) => Array.from({ length: n }, () => user('x'));
  // index 0 and the last 6 are pinned; the unpinned middle holds the content.
  const messages: Message[] = [
    user('goal'),
    asst(prose),
    asst('', [use('Write', { file_path: '/a/b.ts', content: body })]),
    asst('', [use('Bash', { command: script })]),
    ...pad(6),
  ];

  it('counts prose, code bodies and heredoc bodies apart, as shares of all chars', () => {
    const total = messages.reduce(
      (s, m) => s + m.text.length + m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length, 0),
      0,
    );
    const heredocBody = 'echo line of the generated script\n'.repeat(80);
    const r = shares(messages, 6);
    expect(r.chars).toBe(total);
    expect(r.prose).toBeCloseTo((prose.length / total) * 100, 6);
    expect(r.code).toBeCloseTo(((body.length - elideBody(body, 'Write.content for /a/b.ts', 300, 300).length) / total) * 100, 6);
    expect(r.heredoc).toBeCloseTo(((heredocBody.length - elideBody(heredocBody, 'Bash.command heredoc', 300, 300).length) / total) * 100, 6);
    expect(r.total).toBeCloseTo(r.prose + r.code + r.heredoc, 9);
    expect(r.over25).toBe(r.total >= 25);
  });

  it('skips fenced code inside prose and ignores pinned messages', () => {
    const fenced = [user('g'), asst('Intro words here.\n```\n' + 'code line\n'.repeat(50) + '```\nOutro words.'), ...pad(6)];
    const f = shares(fenced, 6);
    expect(f.prose).toBeLessThan(((('Intro words here.\nOutro words.').length + 4) / f.chars) * 100);
    expect(shares([user('g'), ...pad(1), asst(prose)], 6).prose).toBe(0);
  });
});
