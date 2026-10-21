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

  it('passes $ only to functions declared at the top of the file or imported', () => {
    const source = readFileSync(new URL('../hooks/fast-jev.ts', import.meta.url), 'utf8');
    const callees = new Set([...source.matchAll(/([A-Za-z_]\w*)\(\s*\$\s*[,)]/g)].map((m) => m[1]!));
    const topLevel = (name: string) =>
      new RegExp(`^(?:export )?(?:async )?function ${name}\\b|^(?:export )?const ${name}\\b`, 'm').test(source) ||
      new RegExp(`^import [^;]*\\b${name}\\b`, 'm').test(source);
    expect(callees.size).toBeGreaterThan(3);
    expect([...callees].filter((name) => !topLevel(name))).toEqual([]);
  });

  it('never declares or assigns a name that a function handed $ also has', () => {
    const source = readFileSync(new URL('../hooks/fast-jev.ts', import.meta.url), 'utf8');
    const callees = new Set([...source.matchAll(/([A-Za-z_]\w*)\(\s*\$\s*[,)]/g)].map((m) => m[1]!));
    const shadowed = [...callees].filter((name) =>
      new RegExp(`(?:\\b(?:let|var)\\s+${name}\\b|^\\s+const\\s+${name}\\b|[^.\\w]${name}\\s*=(?![=>]))`, 'm').test(source),
    );
    expect(shadowed).toEqual([]);
  });
});
