import { describe, expect, test } from 'vitest';

import { ERROR_LINE, SCAN } from '../src/salvage.js';
import { elideBody, heredocBodies, reassemble, splitProse } from '../src/prose.js';

/** One entry per unit: `c` scored, `k` kept, then the unit's text without its separators. */
function view(text: string): string[] {
  return splitProse(text).map((u) => `${u.scored ? 'c' : 'k'} ${text.slice(u.start, u.end).trim()}`);
}

describe('splitProse: design table', () => {
  test('opener, then a clause split before "and"', () => {
    expect(view('Okay, let me take a look at this, and see what I can figure out.')).toEqual([
      'c Okay,',
      'c let me take a look at this,',
      'c and see what I can figure out.',
    ]);
  });

  test('a negation binds the whole sentence', () => {
    expect(view("Don't run the migration on prod, it drops the users table.")).toEqual([
      "c Don't run the migration on prod, it drops the users table.",
    ]);
  });

  test('inline code keeps the whole sentence', () => {
    expect(view('Run the build, but only after `npm ci` finishes.')).toEqual([
      'k Run the build, but only after `npm ci` finishes.',
    ]);
  });

  test('opener split, bound remainder scored whole', () => {
    expect(view('Great question; the cache is stale because the TTL never resets.')).toEqual([
      'c Great question;',
      'c the cache is stale because the TTL never resets.',
    ]);
  });
});

describe('splitProse: protected spans', () => {
  // [name, text, needle]: every unit that holds the needle must be kept unscored.
  const kept: [string, string, string][] = [
    ['P1 fenced code', 'Intro here today.\n```\nplain words in a fence\n```\nOutro here today.', 'plain words'],
    ['P1 tilde fence', '~~~\nplain words in a fence\n~~~', 'plain words'],
    ['P1 unclosed fence', 'Intro here today.\n```\nplain words in a fence\nmore plain words', 'more plain'],
    ['P2 indented line', 'Intro here today.\n    plain words indented here', 'plain words'],
    ['P2 tab line', 'Intro here today.\n\tplain words tabbed here', 'plain words'],
    ['P3 inline code', 'Please look at `this` now.', 'look at'],
    ['P4 table row', '| plain | words |', 'plain'],
    ['P4 heading', '# Plain heading words', 'Plain'],
    ['P5 url', 'Please open https://example.com/page now.', 'open'],
    ['P5 posix path', 'Please open src/app/main.ts now.', 'open'],
    ['P5 windows path', 'Please open C:\\repos\\app\\main.ts now.', 'open'],
    ['P5 name=value', 'Please set NODE_ENV=production now.', 'set'],
    ['P6 number', 'We saw 42 users today.', 'saw'],
    ['P6 version', 'We shipped v0.6.1 today.', 'shipped'],
    ['P6 id', 'We closed #88 today.', 'closed'],
    ['P7 dot', 'Please read req.session now.', 'read'],
    ['P7 underscore', 'Please read my_value now.', 'read'],
    ['P7 double colon', 'Please read Foo::bar now.', 'read'],
    ['P7 camel', 'Please add the cookieParser middleware now.', 'add'],
    ['P8 command line', '$ ls the plain folder', 'plain'],
    ['P8 percent command', '% ls the plain folder', 'plain'],
    ['P8 flag', 'Please use --force carefully now.', 'use'],
    ['P8 short flag', 'Please use -rf carefully now.', 'use'],
    ['P9 error line', 'The plain build failed here today.', 'plain'],
    ['P9 quoted', 'Please say "hello there" now.', 'say'],
    ['marker line', '[fast-jev-compaction elided 5 chars of Write.content for a.ts; Read the file if needed]', 'elided'],
  ];

  test.each(kept)('%s is kept unscored', (_name, text, needle) => {
    const hits = splitProse(text).filter((u) => text.slice(u.start, u.end).includes(needle));
    expect(hits.length).toBeGreaterThan(0);
    for (const u of hits) expect(u.scored).toBe(false);
  });

  test('an acronym is scored, a camelCase identifier is kept', () => {
    expect(view('Please check the TTL value again.')[0]).toMatch(/^c /);
    expect(view('Please check the cookieParser value again.')[0]).toMatch(/^k /);
  });

  test('a short apostrophe pair is not a quote', () => {
    expect(view("We didn't know it, and they can't say.")[0]).toMatch(/^c /);
  });
});

describe('splitProse: sentences and clauses', () => {
  test.each(['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.'])('no split after %s', (abbr) => {
    const text = `Pick one ${abbr} the first choice here today.`;
    expect(splitProse(text)).toHaveLength(1);
  });

  test('sentences split at a terminal mark', () => {
    expect(view('The cache is stale. The queue is empty!')).toEqual(['c The cache is stale.', 'c The queue is empty!']);
  });

  test.each([
    ['condition', 'Some long lead text goes here, if the cache is stale, and then more words follow.'],
    ['contrast', 'Some long lead text goes here, and more words follow, but fewer remain now.'],
    ['obligation', 'Some long lead text goes here, and then you must restart, and more follow.'],
    ['cause', 'Some long lead text goes here, and then it broke since the cache was cold.'],
  ])('bound word class %s scores whole', (_name, text) => {
    expect(splitProse(text)).toHaveLength(1);
  });

  test('a clause under 3 words merges into its neighbour', () => {
    expect(view('Take a look at the cache layout today, and go.')).toEqual(['c Take a look at the cache layout today, and go.']);
  });

  test('a semicolon splits unbound sentences', () => {
    expect(view('Take a look at the cache layout; then look at the queue layout.')).toEqual([
      'c Take a look at the cache layout;',
      'c then look at the queue layout.',
    ]);
  });

  test('a spaced dash splits unbound sentences', () => {
    expect(view('Take a look at the cache layout - then look at the queue layout.')).toEqual([
      'c Take a look at the cache layout -',
      'c then look at the queue layout.',
    ]);
  });

  test('every byte belongs to exactly one unit, in order', () => {
    const text = '\nOkay, let me look at this, and see.\n\n- first item here. second item here.\n```\ncode\n```\nTail words here today.\n';
    const units = splitProse(text);
    expect(units[0]?.start).toBe(0);
    expect(units.at(-1)?.end).toBe(text.length);
    for (let i = 1; i < units.length; i++) expect(units[i]?.start).toBe(units[i - 1]?.end);
    expect(units.map((u) => text.slice(u.start, u.end)).join('')).toBe(text);
  });

  test('blank text has no units', () => {
    expect(splitProse('')).toEqual([]);
    expect(splitProse('  \n\n ')).toEqual([]);
  });
});

describe('reassemble', () => {
  const dropScored = () => false;

  test('keeping everything returns the text unchanged', () => {
    const text = 'Okay, look here. Then more words follow.\n\n\n\nEnd.';
    expect(reassemble(text, splitProse(text), () => true)).toBe(text);
  });

  test('kept units are byte-identical and in order', () => {
    const text = 'Alpha beta gamma here. Delta epsilon zeta here. Eta theta iota here.';
    const units = splitProse(text);
    const out = reassemble(text, units, (u) => units.indexOf(u) !== 1);
    expect(out).toBe('Alpha beta gamma here. Eta theta iota here.');
  });

  test('a cut-edge comma takes the sentence end mark', () => {
    const text = 'Okay, let me take a look at this, and see what I can figure out.';
    const units = splitProse(text);
    expect(reassemble(text, units, (u) => units.indexOf(u) < 2)).toBe('Okay, let me take a look at this.');
  });

  test('a cut-edge semicolon takes the sentence end mark', () => {
    const text = 'Take a look at the cache layout; then look at the queue layout!';
    const units = splitProse(text);
    expect(reassemble(text, units, (u) => units.indexOf(u) < 1)).toBe('Take a look at the cache layout!');
  });

  test('a comma followed by a kept clause is left alone', () => {
    const text = 'Okay, let me take a look at this, and see what I can figure out.';
    const units = splitProse(text);
    expect(reassemble(text, units, (u) => units.indexOf(u) !== 1)).toBe('Okay, and see what I can figure out.');
  });

  test('an emptied list block loses its marker, and the line break goes with it', () => {
    const text = 'Intro words here today.\n- drop this whole item.\n- keep `this` item.';
    const units = splitProse(text);
    const out = reassemble(text, units, (u) => !u.scored || text.slice(u.start, u.end).includes('keep'));
    expect(out).toBe('- keep `this` item.');
  });

  test('a list item with a kept later sentence keeps its marker', () => {
    const text = '- first words here today. second words here today.';
    const units = splitProse(text);
    expect(reassemble(text, units, (u) => units.indexOf(u) === 1)).toBe('- second words here today.');
  });

  test('3 or more newlines collapse to 2 after a drop', () => {
    const text = 'Keep `one` here.\n\nDrop this paragraph here.\n\nKeep `two` here.';
    const units = splitProse(text);
    expect(reassemble(text, units, (u) => !u.scored)).toBe('Keep `one` here.\n\nKeep `two` here.');
    const gappy = 'Keep `one` here.\n\n\nDrop this paragraph here.\n\n\n\nKeep `two` here.';
    expect(reassemble(gappy, splitProse(gappy), (u) => !u.scored)).toBe('Keep `one` here.\n\nKeep `two` here.');
  });

  test('no trailing space is left before a line break', () => {
    const text = 'Keep `one` here. Drop this sentence here.\nNext line `kept` here.';
    expect(reassemble(text, splitProse(text), (u) => !u.scored)).toBe('Keep `one` here.\nNext line `kept` here.');
  });

  test('dropping everything yields an empty string', () => {
    const text = 'Drop this sentence here. And this one too.';
    expect(reassemble(text, splitProse(text), dropScored)).toBe('');
  });
});

describe('heredocBodies', () => {
  const cases: [string, string, string][] = [
    ['<<EOF', 'cat > a.txt <<EOF\nline one\nline two\nEOF\n', 'EOF'],
    ["<<'EOF'", "cat > a.txt <<'EOF'\nline one\nline two\nEOF\n", 'EOF'],
    ['<<"EOF"', 'cat > a.txt <<"EOF"\nline one\nline two\nEOF\n', 'EOF'],
    ['<<-EOF', 'cat > a.txt <<-EOF\n\tline one\n\tline two\n\tEOF\n', '\tEOF'],
  ];

  test.each(cases)('%s: command line and closing marker lie outside the body', (_name, command, closing) => {
    const spans = heredocBodies(command);
    expect(spans).toHaveLength(1);
    const { start, end } = spans[0] as { start: number; end: number };
    expect(command.slice(start, end)).toMatch(/^\t?line one\n\t?line two\n$/);
    expect(command.slice(0, start)).toMatch(/<<-?['"]?EOF['"]?\n$/);
    expect(command.slice(end)).toBe(`${closing}\n`);
  });

  test('a command without a heredoc has none', () => {
    expect(heredocBodies('echo hi && cat <<< "here string"')).toEqual([]);
  });

  test('an unclosed heredoc runs to the end', () => {
    const command = 'cat <<EOF\nline one\nline two';
    const [span] = heredocBodies(command);
    expect(command.slice(span?.start, span?.end)).toBe('line one\nline two');
  });

  test('two heredocs on one line get two bodies in order', () => {
    const command = 'diff <(cat <<A\nfirst\nA\n) <(cat <<B\nsecond\nB\n)';
    const bodies = heredocBodies(command).map((s) => command.slice(s.start, s.end));
    expect(bodies).toEqual(['first\n', 'second\n']);
  });
});

describe('elideBody', () => {
  const label = 'Write.content for src/app.ts';

  test('returns the text itself when it is not past head + 120', () => {
    const text = 'x'.repeat(420);
    expect(elideBody(text, label, 300, 0)).toBe(text);
  });

  test('keeps a byte-identical head and a note naming tool, field, path and length', () => {
    const text = `${'a'.repeat(300)}${'b'.repeat(12000)}`;
    const out = elideBody(text, label, 300, 0);
    expect(out.startsWith(`${'a'.repeat(300)}\n`)).toBe(true);
    expect(out).toContain('[fast-jev-compaction elided 12,000 chars of Write.content for src/app.ts; Read the file if needed]');
    expect(out.length).toBeLessThan(text.length);
  });

  test('never splits a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(299)}\u{1F600}${'b'.repeat(1000)}`;
    const out = elideBody(text, label, 300, 0);
    expect(out.startsWith(`${'a'.repeat(299)}\n`)).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  test('salvages a path from the cut tail', () => {
    const text = `${'a'.repeat(300)}${'filler words\n'.repeat(60)}see src/deep/file.ts for more\n`;
    expect(elideBody(text, label, 300, 200)).toContain('src/deep/file.ts');
  });

  test('returns the original when the output would not be shorter', () => {
    const text = 'a'.repeat(425);
    expect(elideBody(text, 'L'.repeat(400), 300, 0)).toBe(text);
  });
});

describe('salvage exports', () => {
  test('SCAN and ERROR_LINE are usable through the public module', () => {
    expect([...'see src/a/b.ts'.matchAll(new RegExp(SCAN.source, SCAN.flags))]).toHaveLength(1);
    expect(ERROR_LINE.test('boom: fatal')).toBe(true);
  });
});
