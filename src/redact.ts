/**
 * Pattern-based redaction of credential-shaped text before it is sent to the
 * Jev endpoint. The state built from a transcript already includes tool
 * inputs and raw message text verbatim (see `historyEntries` in state.ts),
 * so anything a tool call embedded — an exported env var, a `--token` flag,
 * a pasted key — would otherwise leave the machine unredacted.
 *
 * This is a best-effort net, not a guarantee: it catches common credential
 * shapes, not every possible secret.
 */

const PATTERNS: RegExp[] = [
  // Known provider key prefixes, e.g. sk-..., ghp_..., AKIA...
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JSON Web Tokens: three base64url segments.
  /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // PEM-encoded private keys, whole block.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Authorization headers.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  // user:password@host, e.g. inside a connection string or URL.
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/g,
  // A `--token`/`--api-key`/`--password`-style CLI flag and its value.
  /--(?:token|api[-_]?key|secret|password|passwd)[= ]\S+/gi,
  // NAME=value env-style assignment where NAME looks like a secret and the
  // value is a plausible opaque token (avoids matching e.g. `MODE=production`).
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?=\S{6,}/g,
  // Opaque base64-looking runs long enough to be a secret rather than prose.
  /\b(?=[A-Za-z0-9+/=]{32,}\b)(?=[A-Za-z0-9+/=]*[A-Za-z])(?=[A-Za-z0-9+/=]*[0-9])[A-Za-z0-9+/]{32,}={0,2}\b/g,
];

/** Replaces credential-shaped substrings in `text` with a fixed placeholder. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

/**
 * Redacts credential-shaped text, plus an exact match on the hook's own API
 * key wherever it appears verbatim (it is not always shaped like the
 * patterns above, e.g. a short or custom-format key).
 */
export function redactText(text: string, apiKey: string | undefined): string {
  const redacted = redactSecrets(text);
  if (!apiKey) return redacted;
  return redacted.split(apiKey).join('[REDACTED]');
}

/**
 * Redacts every free-text field of a Jev `CompactionState` before it leaves
 * the machine: message text, the goal, and every tool call's `input` (both
 * the structured and the one-line compacted forms come through as plain
 * strings by the time the state is built). A deep clone, so the caller's
 * state is untouched.
 */
export function redactCompactionState<T>(state: T, apiKey: string | undefined): T {
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redactText(value, apiKey);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactValue(v);
      }
      return out;
    }
    return value;
  };
  return redactValue(state) as T;
}
