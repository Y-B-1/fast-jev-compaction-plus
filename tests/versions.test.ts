import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

describe('release versions', () => {
  it('keeps every manifest on the package version so marketplace installs see updates', () => {
    const version = json('package.json').version;
    const market = json('.claude-plugin/marketplace.json');
    expect(json('.claude-plugin/plugin.json').version).toBe(version);
    expect(market.version).toBe(version);
    expect(json('package-lock.json').version).toBe(version);
    expect(json('package-lock.json').packages[''].version).toBe(version);
    for (const plugin of market.plugins) expect(plugin.version).toBe(version);
  });
});
