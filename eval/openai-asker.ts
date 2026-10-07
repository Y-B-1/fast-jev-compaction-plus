// Dev-only (T15): OpenAI's Decisions API as a JevAsker, so compact() can run unchanged with either decider.
// Jev noul -> predicate, choice -> choice, score -> score. Key is a parameter, redacted from anything thrown.
import type { HookFetch, HookFetchResponse } from '../hooks/fast-jev.js';
import { redactCompactionState, redactText } from '../src/redact.js';
import { isRetryableStatus, retryDelayMs } from '../src/request.js';
import type { JevAnswer, JevAsker, JevQuestion, JevResponse } from '../src/types.js';

export const DECISIONS_URL = 'https://api.openai.com/v1/decisions';
export const DECISIONS_MODEL = 'gpt-6-luna';

/** `kind` names the failure for the request log: http, refusal, missing_answer or malformed. */
export class DecisionsError extends Error {
  constructor(message: string, readonly kind: string, readonly status?: number) {
    super(message);
    this.name = 'DecisionsError';
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function toQuestion(name: string, q: JevQuestion): Rec {
  if (q.type === 'noul') {
    const parts = [q.instructions, ...(q.criteria?.true ? [`True when: ${q.criteria.true}`] : []), ...(q.criteria?.false ? [`False when: ${q.criteria.false}`] : [])];
    return { type: 'predicate', name, instructions: parts.join('\n') };
  }
  if (q.type === 'choice') {
    return { type: 'choice', name, instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description: description ?? value })) };
  }
  return { type: 'score', name, instructions: q.instructions, levels: q.criteria.map((description, i) => ({ label: `level ${i}`, description })) };
}

/** `{value, probability}` entries as a record keyed by value. */
function probabilities(name: string, raw: unknown): Record<string, number> {
  if (!Array.isArray(raw)) throw new DecisionsError(`Invalid Decisions answer for ${name}`, 'malformed');
  const out: Record<string, number> = {};
  for (const e of raw) {
    if (!isRec(e) || !isProb(e.probability) || (typeof e.value !== 'string' && typeof e.value !== 'number')) throw new DecisionsError(`Invalid Decisions answer for ${name}`, 'malformed');
    out[String(e.value)] = e.probability;
  }
  return out;
}

function toAnswer(name: string, a: Rec): JevAnswer {
  if (a.type === 'predicate' && isProb(a.probability)) return { type: 'noul', noul: a.probability };
  if (a.type === 'choice' && typeof a.choice === 'string' && isProb(a.confidence)) {
    return { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: probabilities(name, a.probabilities) };
  }
  if (a.type === 'score' && typeof a.score === 'number' && Number.isFinite(a.score) && isProb(a.confidence)) {
    return { type: 'score', score: a.score, confidence: a.confidence, probabilities: probabilities(name, a.probabilities) };
  }
  throw new DecisionsError(`Invalid Decisions answer for ${name}`, 'malformed');
}

/** `usage` as the API reports it, under the Jev field names; undefined when it reports none. The docs show no usage field. */
function usageOf(body: Rec): JevResponse['usage'] {
  if (!isRec(body.usage)) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const input = num(body.usage.input_tokens) ?? num(body.usage.prompt_tokens);
  const output = num(body.usage.output_tokens) ?? num(body.usage.completion_tokens);
  return input === undefined && output === undefined ? undefined : { ...(input !== undefined ? { input_tokens: input } : {}), ...(output !== undefined ? { output_tokens: output } : {}) };
}

/** Per-attempt deadline, the same as jevAsker's. */
const TIMEOUT_MS = 20_000;

/** Rejects with a TimeoutError when the attempt takes longer than `ms` (a thrown attempt is not retried, as in jevAsker). */
function bounded<T>(attempt: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Decisions request timed out after ${ms} ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([attempt, late]).finally(() => clearTimeout(timer));
}

export function openaiAsker(fetchFn: HookFetch, key: string, model: string = DECISIONS_MODEL, options: { timeoutMs?: number } = {}): JevAsker {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const clean = (text: string) => redactText(text, key);
  return {
    async ask(state, questions) {
      // The same text the Jev request carries as `state`, redacted the same way.
      const redacted = redactCompactionState(state, key);
      const names = Object.keys(questions);
      const init = {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          input: typeof redacted === 'string' ? redacted : JSON.stringify(redacted),
          questions: names.map((n) => toQuestion(n, redactCompactionState(questions[n]!, key))),
        }),
      };
      let r: HookFetchResponse = await bounded(fetchFn(DECISIONS_URL, init), timeoutMs);
      if (!r.ok && isRetryableStatus(r.status)) {
        const delay = retryDelayMs(r.headers?.['retry-after']);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        r = await bounded(fetchFn(DECISIONS_URL, init), timeoutMs);
      }
      if (!r.ok) throw new DecisionsError(`Decisions request failed (${r.status}): ${clean(r.text).slice(0, 200)}`, 'http', r.status);
      let body: unknown;
      try {
        body = JSON.parse(r.text);
      } catch {
        throw new DecisionsError('Decisions returned malformed JSON', 'malformed', r.status);
      }
      if (!isRec(body) || !Array.isArray(body.answers)) throw new DecisionsError('Decisions response is missing answers', 'malformed', r.status);
      const byName = new Map<string, Rec>();
      for (const a of body.answers) if (isRec(a) && typeof a.name === 'string') byName.set(a.name, a);
      const answers: Record<string, JevAnswer> = {};
      for (const name of names) {
        const a = byName.get(name);
        if (!a) throw new DecisionsError(`Missing Decisions answer for ${name}`, 'missing_answer', r.status);
        if (a.type === 'refusal') throw new DecisionsError(`Decisions refused ${name}`, 'refusal', r.status);
        answers[name] = toAnswer(name, a);
      }
      const usage = usageOf(body);
      return { model: typeof body.model === 'string' ? body.model : model, answers, ...(usage ? { usage } : {}) };
    },
  };
}
