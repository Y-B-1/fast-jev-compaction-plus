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
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
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
  // `Authorization: token abc…` and other schemes beyond Bearer and Basic.
  /\bAuthorization:\s*[A-Za-z]+\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Opaque base64-looking runs long enough to be a secret rather than prose:
  // 40+ chars with upper case, lower case and a digit. Single-case runs (git
  // SHAs, hex digests), anything touching a `/` (file paths), and a lockfile's
  // `sha512-` integrity value are left alone, so ordinary tool output is not
  // blanked (and still archived verbatim).
  /(?<![A-Za-z0-9+/])(?<!sha(?:1|256|384|512)-)(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[0-9])[A-Za-z0-9+]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
];

/**
 * A key named like a secret, in any case and as a YAML/JSON key, header, query
 * parameter or assignment (`password: x`, `"apiKey": "x"`, `db_pass=x`,
 * `X-Api-Key: x`, `?api_key=x`, `aws_secret_access_key = x`): only the value is
 * replaced, so the key stays readable. The value must look like a literal (6+
 * characters, quoted or holding a digit, no call, brackets or `$` reference),
 * so code such as `token = getToken()` or `password: ${PASSWORD}` is left alone.
 */
const SECRET_FIELD =
  /(\b[A-Za-z0-9_.-]*?(?:password|passwd|pass|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*)(?:(["'])([^"'\s$]{6,})\2|(?=[^\s"',;&()[\]{}<>$]*\d)([^\s"',;&()[\]{}<>$]{6,}))/gi;

/** Replaces credential-shaped substrings in `text` with a fixed placeholder. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted.replace(SECRET_FIELD, (match, key: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    const value = quoted ?? bare ?? '';
    if (value.startsWith('[REDACTED]')) return match;
    return quote ? `${key}${quote}[REDACTED]${quote}` : `${key}[REDACTED]`;
  });
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
