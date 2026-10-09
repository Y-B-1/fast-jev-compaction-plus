/**
 * Pulls the high-value tokens out of a tool result that is about to be
 * dropped. A dropped result keeps only a short head, and for a listing, a
 * test run or a build log the head is preamble: the paths, identifiers and
 * failures live further down. Scanning the whole text for those tokens keeps
 * the parts that cannot be reconstructed from memory.
 */

/**
 * Ordered alternation, scanned once so results come back in the order they
 * appear. Two orderings matter and are load-bearing:
 *
 * - An assignment comes first and consumes `NAME=VALUE` whole. Only the name
 *   is ever kept, and because the match swallows the value, no later
 *   alternative can pick the value up. Salvage must never turn a leaked
 *   secret in a tool result into a secret in the retained context.
 * - A URL comes before the path pattern, so the slashes inside it are not
 *   mistaken for a path.
 *
 * A SHA must carry a digit: without that, ordinary words spelled from a-f
 * ("defaced") read as hashes.
 */
export const SCAN =
  /\b([A-Za-z_][A-Za-z0-9_]{2,})=\S+|https?:\/\/[^\s)'"<>\]]+|[A-Za-z]:\\[^\s:*?"<>|]+|(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;

/**
 * `fail` needs its own word-bounded alternative: test runners emit a bare
 * "FAIL", which neither "failed" nor "failure" matches.
 */
export const ERROR_LINE = /error|exception|\bfail(ed|ure|ing|s)?\b|fatal|traceback|panic|refused/i;
const EXIT_CODE = /\bexit (?:code|status)\s+(\d+)/i;

/** The same assignment shape `SCAN` consumes, for redacting kept lines. */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]{2,})=\S+/g;

/**
 * Strips assigned values out of a line that is kept whole. A failing line is
 * often the one carrying a credential ("auth failed for TOKEN=..."), and the
 * name is the useful part; the value must not survive into the context.
 */
function redact(line: string): string {
  return line.replace(ASSIGNMENT, '$1=<redacted>');
}

/**
 * Every identifier in `text`, in the order it first appears, without repeats.
 * For an assignment only the name is returned, never the value.
 */
export function salvageIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(SCAN)) {
    seen.add(match[1] ?? match[0]);
  }
  return [...seen];
}

/**
 * The lines of `text` that report a failure, in order, without repeats. An
 * exit line counts only when the status is non-zero.
 */
export function salvageErrorLines(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const exit = EXIT_CODE.exec(line);
    if (exit) {
      if (exit[1] !== '0') seen.add(redact(line));
      continue;
    }
    if (ERROR_LINE.test(line)) seen.add(redact(line));
  }
  return [...seen];
}

/** As many items as fit `budget`, in order. */
function capped(items: readonly string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = item.length + 2;
    if (used + cost > budget) break;
    out.push(item);
    used += cost;
  }
  return out;
}

/**
 * A bounded block of identifiers and error lines recovered from `text` (the
 * part of a dropped tool result that will not stay in the transcript), or the
 * empty string when nothing was found or `maxChars` is 0.
 *
 * Salvage is an improvement to a path that already works, so it must never be
 * the reason compaction fails: any error here falls back to nothing salvaged.
 */
export function salvageBlock(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  try {
    const errors = capped(salvageErrorLines(text), maxChars);
    const spent = errors.reduce((sum, line) => sum + line.length + 2, 0);
    const refs = capped(salvageIdentifiers(text), maxChars - spent);
    return [
      errors.length > 0 ? `errors: ${errors.join(' | ')}` : '',
      refs.length > 0 ? `refs: ${refs.join(' ')}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  } catch {
    return '';
  }
}
