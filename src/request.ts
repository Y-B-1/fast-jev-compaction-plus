import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-1.13';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    if (status === 403 && /<\s*(?:!doctype\s+html|html)\b/i.test(text.slice(0, 1024))) {
      throw new Error(
        'Jev request failed (403): the endpoint returned an HTML error page; a web firewall or proxy may be blocking this request',
      );
    }
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** A 429 or a 5xx is worth one retry; anything else is the caller's problem. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Milliseconds to wait before a retry, from a `retry-after` header value
 * (either delay-seconds or an HTTP date), capped so a hostile or malformed
 * header cannot stall the caller for long. Returns 0 when the header is
 * absent or unparsable.
 */
export function retryDelayMs(value: string | null | undefined, capMs = 30_000): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), capMs);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.min(Math.max(0, at - Date.now()), capMs);
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer: unknown = isRecord(answers) && Object.hasOwn(answers, name)
    ? answers[name]
    : undefined;
  if (
    !isRecord(answer) ||
    !Object.hasOwn(answer, 'noul') ||
    (answer.type !== undefined && answer.type !== 'noul') ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul) ||
    answer.noul < 0 ||
    answer.noul > 1
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
