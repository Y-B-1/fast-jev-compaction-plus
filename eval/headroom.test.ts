import { describe, expect, it } from 'vitest';
import { elideBody } from '../src/prose.js';
import type { Message } from '../src/types.js';
import { shares, tolerance } from './headroom.js';

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
    expect(r.upperBoundOver25).toBe(r.total >= 25);
  });

  it('skips fenced code inside prose and ignores pinned messages', () => {
    const fenced = [user('g'), asst('Intro words here.\n```\n' + 'code line\n'.repeat(50) + '```\nOutro words.'), ...pad(6)];
    const f = shares(fenced, 6);
    expect(f.prose).toBeLessThan(((('Intro words here.\nOutro words.').length + 4) / f.chars) * 100);
    expect(shares([user('g'), ...pad(1), asst(prose)], 6).prose).toBe(0);
  });

  it('counts only scored prose units: protected spans and inline code add nothing', () => {
    const plain = 'We checked the logs and found the queue stalled overnight.';
    const protectedOnly = 'Run `npm test` and read /etc/hosts for 42 retries.';
    const mixed = shares([user('g'), asst(plain + '\n' + protectedOnly), ...pad(6)], 6);
    const plainOnly = shares([user('g'), asst(plain), ...pad(6)], 6);
    const none = shares([user('g'), asst(protectedOnly), ...pad(6)], 6);
    expect(none.prose).toBe(0);
    // the plain line contributes its own chars (plus its line break) either way
    expect((mixed.prose / 100) * mixed.chars).toBeCloseTo((plainOnly.prose / 100) * plainOnly.chars, 6);
    expect(plainOnly.prose).toBeGreaterThan(0);
  });

  it('counts MultiEdit bodies from input.edits like Edit bodies', () => {
    const edits = [{ old_string: body, new_string: body + 'tail();\n' }, { old_string: 'a', new_string: 'b' }];
    const multi = shares([user('g'), asst('', [use('MultiEdit', { file_path: '/a/b.ts', edits })]), ...pad(6)], 6);
    const single = shares([user('g'), asst('', [use('Edit', { file_path: '/a/b.ts', old_string: body, new_string: body + 'tail();\n' })]), ...pad(6)], 6);
    expect(multi.code).toBeGreaterThan(0);
    // elision markers name the tool, so the two differ by a few label chars only
    expect(Math.abs((multi.code / 100) * multi.chars - (single.code / 100) * single.chars)).toBeLessThan(20);
    // independent bound: each 2600-char body keeps at most head + salvage + a short marker
    const removed = (multi.code / 100) * multi.chars;
    expect(removed).toBeGreaterThan(2 * (body.length - 1000));
    expect(removed).toBeLessThan(2 * body.length + 8);
  });

  it('flags a case whose bodies are most of the chars as over the 25 pct upper bound', () => {
    const big = 'const value = compute(1);\n'.repeat(400);
    const r = shares([user('g'), asst('', [use('Write', { file_path: '/a/b.ts', content: big })]), ...pad(6)], 6);
    expect(r.code).toBeGreaterThan(25);
    expect(r.upperBoundOver25).toBe(true);
    expect(shares([user('g'), ...pad(6)], 6).upperBoundOver25).toBe(false);
  });
});

describe('tolerance', () => {
  it('reports reference, delta and withinTolerance per metric without throwing', () => {
    const t = tolerance({ prose: 2.9, code: 8.0, heredoc: 2.0 });
    expect(t.reference).toEqual({ prose: 2.6, code: 7.1, heredoc: 2.0 });
    expect(t.delta.prose).toBeCloseTo(0.3, 9);
    expect(t.delta.code).toBeCloseTo(0.9, 9);
    expect(t.withinTolerance).toEqual({ prose: true, code: false, heredoc: true });
  });
});
