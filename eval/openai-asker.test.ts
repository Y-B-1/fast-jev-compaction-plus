import { describe, expect, it } from 'vitest';
import type { HookFetch, HookFetchResponse } from '../hooks/fast-jev.js';
import { buildJevRequest } from '../src/request.js';
import type { JevQuestions } from '../src/types.js';
import { openaiAsker } from './openai-asker.js';

const KEY = 'sk-canary-OPENAI-0123456789';
const QUESTIONS: JevQuestions = {
  keep: { type: 'noul', instructions: 'Keep it?', criteria: { true: 'still used', false: 'stale' } },
  pick: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: null } },
  rate: { type: 'score', instructions: 'How bad?', criteria: ['mild', 'severe'] },
};
const STATE = { goal: 'g', history: [{ i: 0, text: 'hello' }] };
const OK_BODY = {
  answers: [
    { type: 'score', name: 'rate', score: 0.7, probabilities: [{ value: 0, label: 'level 0', probability: 0.3 }, { value: 1, label: 'level 1', probability: 0.7 }], confidence: 0.6 },
    { type: 'predicate', name: 'keep', probability: 0.2 },
    { type: 'choice', name: 'pick', choice: 'a', probabilities: [{ value: 'a', probability: 0.9 }, { value: 'b', probability: 0.1 }], confidence: 0.8 },
  ],
};
const reply = (status: number, body: unknown): HookFetchResponse => ({ status, ok: status >= 200 && status < 300, text: typeof body === 'string' ? body : JSON.stringify(body) });

function fake(responses: HookFetchResponse[]) {
  const calls: { url: string; init: Parameters<HookFetch>[1] }[] = [];
  const fetchFn: HookFetch = async (url, init) => {
    calls.push({ url, init });
    return responses[Math.min(calls.length - 1, responses.length - 1)]!;
  };
  return { fetchFn, calls };
}

describe('openaiAsker', () => {
  it('sends the Decisions body and maps the answers back to a JevResponse', async () => {
    const f = fake([reply(200, OK_BODY)]);
    const res = await openaiAsker(f.fetchFn, KEY).ask(STATE, QUESTIONS);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/decisions');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.headers).toEqual({ authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(JSON.parse(call.init!.body!)).toEqual({
      model: 'gpt-6-luna',
      input: JSON.stringify(STATE),
      questions: [
        { type: 'predicate', name: 'keep', instructions: 'Keep it?\nTrue when: still used\nFalse when: stale' },
        { type: 'choice', name: 'pick', instructions: 'Which?', choices: [{ value: 'a', description: 'first' }, { value: 'b', description: 'b' }] },
        { type: 'score', name: 'rate', instructions: 'How bad?', levels: [{ label: 'level 0', description: 'mild' }, { label: 'level 1', description: 'severe' }] },
      ],
    });
    expect(res.answers).toEqual({
      keep: { type: 'noul', noul: 0.2 },
      pick: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } },
      rate: { type: 'score', score: 0.7, confidence: 0.6, probabilities: { '0': 0.3, '1': 0.7 } },
    });
  });

  it('renders a string state as is and an object state like the Jev client does', async () => {
    const f = fake([reply(200, { answers: [{ type: 'predicate', name: 'keep', probability: 0.5 }] })]);
    await openaiAsker(f.fetchFn, KEY).ask('plain state', { keep: QUESTIONS.keep! });
    expect(JSON.parse(f.calls[0]!.init!.body!).input).toBe('plain state');
    // The same text the Jev request carries as `state`.
    const jev = JSON.parse(buildJevRequest({ apiKey: 'k' }, STATE, QUESTIONS).body);
    expect(JSON.stringify(jev.state)).toBe(JSON.stringify(STATE));
  });

  it('keeps a reported usage', async () => {
    const f = fake([reply(200, { ...OK_BODY, usage: { input_tokens: 1234, output_tokens: 5 } })]);
    expect((await openaiAsker(f.fetchFn, KEY).ask(STATE, QUESTIONS)).usage).toEqual({ input_tokens: 1234, output_tokens: 5 });
  });

  it('has no usage when the API reports none', async () => {
    const f = fake([reply(200, OK_BODY)]);
    expect((await openaiAsker(f.fetchFn, KEY).ask(STATE, QUESTIONS)).usage).toBeUndefined();
  });

  it('redacts the key from the request input', async () => {
    const f = fake([reply(200, { answers: [{ type: 'predicate', name: 'keep', probability: 0.5 }] })]);
    await openaiAsker(f.fetchFn, KEY).ask({ note: `token ${KEY}` }, { keep: QUESTIONS.keep! });
    expect(f.calls[0]!.init!.body).not.toContain(KEY);
  });

  const failures: [string, HookFetchResponse[]][] = [
    ['a refusal answer', [reply(200, { answers: [{ type: 'refusal', name: 'keep' }, OK_BODY.answers[2], OK_BODY.answers[0]] })]],
    ['a 400', [reply(400, `bad request echoing ${KEY}`)]],
    ['a 500 that stays', [reply(500, `server error ${KEY}`)]],
    ['a missing answer', [reply(200, { answers: [OK_BODY.answers[1]] })]],
    ['a body without answers', [reply(200, { nope: true })]],
    ['malformed JSON', [reply(200, 'not json')]],
  ];
  it.each(failures)('throws on %s, and the thrown text holds no key', async (_name, responses) => {
    const f = fake(responses);
    const err = await openaiAsker(f.fetchFn, KEY).ask(STATE, QUESTIONS).then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(`${err!.name} ${err!.message}`).not.toContain(KEY);
  });

  it('retries one 429 and then succeeds', async () => {
    const f = fake([reply(429, 'slow down'), reply(200, { answers: [{ type: 'predicate', name: 'keep', probability: 0.5 }] })]);
    const res = await openaiAsker(f.fetchFn, KEY).ask(STATE, { keep: QUESTIONS.keep! });
    expect(f.calls).toHaveLength(2);
    expect(res.answers.keep).toEqual({ type: 'noul', noul: 0.5 });
  });
});
