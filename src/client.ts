import { buildJevRequest, isRetryableStatus, parseJevResponse, retryDelayMs } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

/** `OPENROUTER_API_KEY`, falling back to `TYPESAFE_API_KEY`; an empty string counts as unset. */
function apiKeyFromEnv(): string {
  return process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY || '';
}

export interface JevClientOptions {
  /** Defaults to `OPENROUTER_API_KEY`, falling back to `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Deadline for each attempt, including its response body. Default 20000 ms. */
  timeoutMs?: number;
  /** Optional caller cancellation, shared by this client's requests. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? apiKeyFromEnv();
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647) {
      throw new RangeError('timeoutMs must be an integer between 1 and 2147483647');
    }
    this.signal = options.signal;
  }

  /** One HTTP attempt, bounded by `timeoutMs` and by the caller's `signal`. */
  private async attempt(
    request: ReturnType<typeof buildJevRequest>,
  ): Promise<{ status: number; ok: boolean; text: string; retryAfter: string | null }> {
    if (this.signal?.aborted) throw this.signal.reason ?? new Error('Jev request aborted');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const reason = this.signal?.reason ?? new Error('Jev request aborted');
        controller.abort(reason);
        reject(reason);
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new Error(`Jev request timed out after ${this.timeoutMs} ms`);
        error.name = 'TimeoutError';
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
      if (this.signal?.aborted) onAbort();
    });
    try {
      const response = await Promise.race([
        this.fetcher(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        }),
        cancelled,
      ]);
      const text = await Promise.race([response.text(), cancelled]);
      return {
        status: response.status,
        ok: response.ok,
        text,
        retryAfter: response.headers.get('retry-after'),
      };
    } finally {
      clearTimeout(timer);
      if (onAbort) this.signal?.removeEventListener('abort', onAbort);
    }
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY (or TYPESAFE_API_KEY) is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const first = await this.attempt(request);
    if (first.ok || !isRetryableStatus(first.status)) {
      return parseJevResponse(first.status, first.ok, first.text);
    }
    const delay = retryDelayMs(first.retryAfter);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const second = await this.attempt(request);
    return parseJevResponse(second.status, second.ok, second.text);
  }
}
