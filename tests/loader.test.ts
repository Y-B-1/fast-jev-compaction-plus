import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Claude Code's hooks-module loader refuses a module (and the plugin then does
// nothing) unless every `$` use is spelled `$.noun.verb(...)` at its call site:
// `$.env?.get(...)` or passing `$.env` around fails to load, which unit tests
// with a plain `$` object never notice.
describe('hooks module shape', () => {
  it('spells every $ call as $.noun.verb( at the call site', () => {
    const source = readFileSync(new URL('../hooks/fast-jev.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const uses = [...source.matchAll(/\$\??\.[A-Za-z_]+(?:\??\.[A-Za-z_]+)?\s*\(?/g)].map((m) => m[0]);
    expect(uses.length).toBeGreaterThan(10);
    expect(uses.filter((use) => !/^\$\.[a-z]+\.[A-Za-z]+\s*\($/.test(use))).toEqual([]);
  });
});
