import { describe, expect, it } from 'vitest';

import { redactCompactionState, redactText } from '../src/redact.js';
import type { CompactionState } from '../src/types.js';

describe('redactText', () => {
  it('redacts common credential shapes', () => {
    expect(redactText('key is sk-abcdefghijklmnopqrstuvwx', undefined)).toBe(
      'key is [REDACTED]',
    );
    expect(redactText('token ghp_abcdefghijklmnopqrstuvwxyz01', undefined)).toBe(
      'token [REDACTED]',
    );
    expect(redactText('AWS key AKIAABCDEFGHIJKLMNOP', undefined)).toBe(
      'AWS key [REDACTED]',
    );
    expect(
      redactText(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        undefined,
      ),
    ).toBe('[REDACTED]');
    expect(redactText('Authorization: Bearer abcdef123456xyz', undefined)).toBe(
      'Authorization: [REDACTED]',
    );
    expect(redactText('postgres://user:hunter2@db.example.com/prod', undefined)).toBe(
      '[REDACTED]db.example.com/prod',
    );
    expect(redactText('--api-key sk_live_abcdefghijklmnop', undefined)).toBe('[REDACTED]');
    expect(redactText('export SERVICE_API_KEY=sk-v1-abcdef1234567890', undefined)).toBe(
      'export [REDACTED]',
    );
  });

  it('redacts a PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIBOgIBAAJBAK...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redactText(pem, undefined)).toBe('[REDACTED]');
  });

  it('leaves ordinary prose and code untouched', () => {
    const text = 'Fix the failing test in src/a.ts and rerun npm test.';
    expect(redactText(text, undefined)).toBe(text);
  });

  it('leaves git SHAs, hex digests, paths and lockfile integrity hashes untouched', () => {
    for (const text of [
      'commit 3bfad06e1c2d4f5a6b7c8d9e0f1a2b3c4d5e6f7a',
      'sha256 E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
      '/Users/yusri/Documents/Claude/Orchestra2/notes/Session2026Log/Entry42.md',
      '"integrity": "sha512-Xk1pQmZ3v9Lr4TtY8wBn2Hc6Jd0Fs5Ga7Ke1Mu3Nq9Rp4Sx8Vy2Wz6AbCdEfGhIjKlMnOpQrStUvWx12+AbCd=="',
    ]) {
      expect(redactText(text, undefined)).toBe(text);
    }
  });

  it('still redacts a long mixed-case opaque token', () => {
    expect(redactText('token=Xk1pQmZ3v9Lr4TtY8wBn2Hc6Jd0Fs5Ga7Ke1Mu3Nq9R end', undefined)).toBe(
      'token=[REDACTED] end',
    );
  });

  it('redacts an exact match of the hook\'s own API key even in a non-standard shape', () => {
    expect(redactText('using key myCustom.key-42', 'myCustom.key-42')).toBe('using key [REDACTED]');
  });
});

describe('redactCompactionState', () => {
  it('redacts text, goal, and tool inputs throughout the state without mutating the input', () => {
    const state: CompactionState = {
      context: 'ctx',
      goal: 'deploy with AKIAABCDEFGHIJKLMNOP',
      history: [
        {
          i: 0,
          role: 'user',
          text: 'export SERVICE_API_KEY=sk-v1-abcdef1234567890',
          tool_calls: [
            { id: 't1', tool: 'Bash', input: 'AKIAABCDEFGHIJKLMNOP', result: 'ok, 3 chars (omitted)' },
          ],
          pending_calls: [
            { tool_use_id: 'x', tool: 'Bash', input: 'AKIAABCDEFGHIJKLMNOP' },
          ],
        },
      ],
    };
    const original = JSON.parse(JSON.stringify(state));
    const redacted = redactCompactionState(state, undefined);
    expect(redacted.goal).toBe('deploy with [REDACTED]');
    expect(redacted.history[0]!.text).toBe('export [REDACTED]');
    expect((redacted.history[0]!.tool_calls![0] as { input: string }).input).toBe('[REDACTED]');
    expect(redacted.history[0]!.pending_calls![0]!.input).toBe('[REDACTED]');
    expect(state).toEqual(original);
  });
});

describe('secret-named fields and more provider keys', () => {
  it('redacts the value of secret-named keys in config, JSON, headers and query strings', () => {
    const cases: [string, string][] = [
      ['password: hunter2xyz', 'password: [REDACTED]'],
      ['"password": "hunter2xyz"', '"password": "[REDACTED]"'],
      ['db_password=hunter2xyz', 'db_password=[REDACTED]'],
      ['DB_PASS=s3cr3tValue', 'DB_PASS=[REDACTED]'],
      ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = [REDACTED]'],
      ['curl -H "X-Api-Key: 9f8e7d6c5b4a39281706f5e4d3c2b1a0"', 'curl -H "X-Api-Key: [REDACTED]"'],
      ['https://api.x.com/v1?api_key=AbCdEf123456&q=1', 'https://api.x.com/v1?api_key=[REDACTED]&q=1'],
      ['"apiKey": "AbC123xyz789"', '"apiKey": "[REDACTED]"'],
    ];
    for (const [input, output] of cases) expect(redactText(input, undefined)).toBe(output);
  });

  it('redacts more provider key formats and Authorization schemes', () => {
    for (const secret of [
      'sk_live_51HabcdefGHIJKLmnop1234',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz12345',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'glpat-abcdefghij1234567890',
      'Authorization: token abcdef0123456789',
    ]) {
      expect(redactText(`x ${secret} y`, undefined)).toBe('x [REDACTED] y');
    }
  });

  it('leaves code that only names a secret alone', () => {
    for (const code of [
      'const token = getToken();',
      'token = req.headers.authorization',
      'password: ${PASSWORD}',
      'API_KEY: $API_KEY',
      'max_tokens: 4096',
      'tests passed: 12 of 12',
    ]) {
      expect(redactText(code, undefined)).toBe(code);
    }
  });
});
