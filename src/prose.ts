import { splitsSurrogatePair } from './compact.js';
import { ERROR_LINE, SCAN, salvageBlock } from './salvage.js';

/**
 * Clause splitter for assistant prose and prose tool inputs, plus rule-based
 * elision of code bodies. Pure string work: no Node, timer or Intl APIs, so it
 * runs in the hook's JavaScriptCore runtime.
 */

/** A slice `[start, end)` of the text. Units tile the text; `scored` units may be asked about. */
export type ProseUnit = { start: number; end: number; scored: boolean };

// SCAN is /g; a non-global copy keeps `test` free of lastIndex state.
const SCAN_ONCE = new RegExp(SCAN.source);
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const FENCE = /^[ \t]*(?:```|~~~)/;
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf']);
const QUOTED = /"[^"\n]{4,}"|“[^”\n]{4,}”|(?<![\w])'[^'\n]{4,}'(?![\w])/;
const BOUND =
  /\b(?:not|no|never|none|nothing|neither|nor|without|cannot|if|unless|only|except|until|before|after|when|otherwise|instead|but|however|although|though|yet|because|since|so that|must|needs?|required|always|avoid)\b|n't\b|n’t\b/i;
const MARKER_LINE = '[fast-jev-compaction ';

/** Whether `s` holds any protected span (P3, P5-P9; line-level spans are handled by the caller). */
function isProtected(s: string): boolean {
  if (s.includes('`') || SCAN_ONCE.test(s) || QUOTED.test(s)) return true;
  for (const raw of s.split(/\s+/)) {
    const lead = raw.replace(/^[("'[{“‘]+/, '');
    if (/^--?[A-Za-z]/.test(lead)) return true;
    const token = lead.replace(/[.,;:!?)"'\]}”’]+$/, '');
    if (token === '' || ABBREVIATIONS.has(token.toLowerCase())) continue;
    if (/\d/.test(token) || /[._/]|::/.test(token) || /[a-z][A-Z]/.test(token)) return true;
  }
  return false;
}

/** Whole-line protection: P1 (fence lines are tracked by the caller), P2, P4, P8, P9 and the marker line. */
function isProtectedLine(line: string): boolean {
  return (
    /^(?: {4,}|\t)/.test(line) ||
    /^ {0,3}[|#]/.test(line) ||
    /^[ \t]*[$%] /.test(line) ||
    line.startsWith(MARKER_LINE) ||
    ERROR_LINE.test(line) ||
    !/[A-Za-z]/.test(line)
  );
}

type Span = { cs: number; ce: number; scored: boolean };

/** Sentence ranges `[from, to)` inside `text`, ending at . ! ? plus whitespace, except after an abbreviation. */
function sentences(text: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let begin = from;
  const end = /[.!?]+["')\]]*(?=\s|$)/g;
  const body = text.slice(0, to);
  end.lastIndex = from;
  for (let m = end.exec(body); m !== null; m = end.exec(body)) {
    const stop = m.index + m[0].length;
    const word = body.slice(begin, m.index + (m[0].startsWith('.') ? 0 : 1)).split(/\s+/).pop() ?? '';
    if (m[0] === '.' && ABBREVIATIONS.has(word.toLowerCase())) continue;
    out.push([begin, stop]);
    begin = stop;
    while (begin < to && /\s/.test(text.charAt(begin))) begin++;
  }
  if (begin < to) out.push([begin, to]);
  return out;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /\w/.test(w)).length;
}

/** Cut points (exclusive end of each clause) inside `[from, to)` of an unbound sentence. */
function clauseCuts(text: string, from: number, to: number): number[] {
  const body = text.slice(from, to);
  const cuts: number[] = [];
  for (const m of body.matchAll(/;(?=\s)|(?<=\s)(?:—|–|--?)(?=\s)|,(?=\s+(?:and|so|then|also|plus|which)\b)/g)) {
    cuts.push(from + m.index + m[0].length);
  }
  return cuts;
}

function sentenceSpans(text: string, from: number, to: number): Span[] {
  // Protection wins: a sentence holding a protected span is one kept unit.
  if (isProtected(text.slice(from, to))) return [{ cs: from, ce: to, scored: false }];
  const units: [number, number][] = [];
  let at = from;
  // Opener: a short lead-in ending in , or ; stands alone, unless it holds a bound word.
  const lead = /^[^,;\n]*[,;](?=\s)/.exec(text.slice(from, to));
  if (lead && wordCount(lead[0]) <= 4 && !BOUND.test(lead[0]) && /\S/.test(text.slice(from + lead[0].length, to))) {
    units.push([from, from + lead[0].length]);
    at = from + lead[0].length;
    while (at < to && /\s/.test(text.charAt(at))) at++;
  }
  if (!BOUND.test(text.slice(at, to))) {
    const pieces: [number, number][] = [];
    let begin = at;
    for (const cut of [...clauseCuts(text, at, to), to]) {
      if (cut <= begin) continue;
      pieces.push([begin, cut]);
      begin = cut;
      while (begin < to && /\s/.test(text.charAt(begin))) begin++;
    }
    // A clause under 3 words merges into the next one, or into the previous at the end.
    for (let i = 0; i < pieces.length && pieces.length > 1; ) {
      const piece = pieces[i] as [number, number];
      if (wordCount(text.slice(piece[0], piece[1])) >= 3) {
        i++;
      } else if (i + 1 < pieces.length) {
        pieces.splice(i, 2, [piece[0], (pieces[i + 1] as [number, number])[1]]);
      } else {
        pieces.splice(i - 1, 2, [(pieces[i - 1] as [number, number])[0], piece[1]]);
        i--;
      }
    }
    units.push(...pieces);
  } else if (at < to) {
    units.push([at, to]);
  }
  return units.map(([cs, ce]) => ({ cs, ce, scored: true }));
}

/**
 * Splits `text` into units that tile it exactly. A unit holds its own content, the
 * spaces that follow it on its line, and the line break, indent and list marker that
 * lead its line when it starts one. `scored` is false for protected units.
 */
export function splitProse(text: string): ProseUnit[] {
  const spans: Span[] = [];
  let fenced = false;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed !== '') {
      const cs = pos + line.indexOf(trimmed);
      const ce = cs + trimmed.length;
      if (FENCE.test(line)) {
        fenced = !fenced;
        spans.push({ cs, ce, scored: false });
      } else if (fenced || isProtectedLine(line)) {
        spans.push({ cs, ce, scored: false });
      } else {
        const lead = LIST_MARKER.exec(line)?.[0].length ?? line.length - line.trimStart().length;
        for (const [from, to] of sentences(text, pos + lead, ce)) {
          spans.push(...sentenceSpans(text, from, to));
        }
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return spans.map((s, i) => {
    const prev = spans[i - 1];
    const start = i === 0 ? 0 : text.slice((prev as Span).ce, s.cs).includes('\n') ? (prev as Span).ce : s.cs;
    const next = spans[i + 1];
    const end = next === undefined ? text.length : text.slice(s.ce, next.cs).includes('\n') ? s.ce : next.cs;
    return { start, end, scored: s.scored };
  });
}

const SENTENCE_END = /([.!?])["')\]]*$/;
const DANGLING = /(?:[,;]|\s(?:—|–|--?))([ \t]*)$/;

/**
 * The text with every unit `keep` rejects removed. A kept unit keeps its bytes; a dropped unit
 * takes its trailing separator; a dangling `,` `;` or dash at a cut edge takes the sentence's end mark;
 * a list item left with no kept unit loses its marker; 3+ newlines collapse to 2.
 */
export function reassemble(text: string, units: ProseUnit[], keep: (u: ProseUnit) => boolean): string {
  const kept = units.map((u) => keep(u));
  if (kept.every(Boolean)) return text;
  const slice = (i: number): string => text.slice((units[i] as ProseUnit).start, (units[i] as ProseUnit).end);
  const startsBlock = (i: number): boolean => i === 0 || /^\s*\n/.test(slice(i));
  let out = '';
  let dropped = false;
  for (let i = 0; i < units.length; i++) {
    let piece = slice(i);
    if (!kept[i]) {
      dropped = true;
      // A list item whose first unit goes but later ones stay keeps its marker.
      if (startsBlock(i)) {
        let j = i + 1;
        while (j < units.length && !startsBlock(j)) j++;
        const marker = /^\s*(?:[-*+]|\d+[.)])[ \t]+/.exec(piece)?.[0];
        if (marker && kept.slice(i + 1, j).some(Boolean)) out += marker;
      }
      continue;
    }
    if (dropped && /^\s*\n/.test(piece)) out = out.replace(/[ \t]+$/, '');
    dropped = false;
    if (i + 1 < units.length && !kept[i + 1] && DANGLING.test(piece)) {
      const mark = endMark(i);
      if (mark) piece = piece.replace(DANGLING, (_m, ws: string) => `${mark}${ws}`);
    }
    out += piece;
  }
  if (dropped) out = out.replace(/[ \t]+$/, '');
  if (!kept[0]) out = out.replace(/^\n+/, '');
  return out.replace(/\n{3,}/g, '\n\n');

  /** The end mark for a cut sentence, or '' when a kept unit continues it. */
  function endMark(i: number): string {
    for (let j = i + 1; j < units.length; j++) {
      if (kept[j]) return '';
      const mark = SENTENCE_END.exec(slice(j).trimEnd())?.[1];
      if (mark) return mark;
      if (j + 1 >= units.length || startsBlock(j + 1)) return '.';
    }
    return '.';
  }
}

/** Body spans of the heredocs in a shell command. The command line and the closing marker lie outside. */
export function heredocBodies(command: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const queue: { mark: string; dash: boolean }[] = [];
  let current: { mark: string; dash: boolean; bodyStart: number } | null = null;
  let pos = 0;
  while (pos < command.length) {
    const nl = command.indexOf('\n', pos);
    const lineEnd = nl === -1 ? command.length : nl;
    const next = nl === -1 ? command.length : nl + 1;
    const line = command.slice(pos, lineEnd).replace(/\r$/, '');
    if (current) {
      if ((current.dash ? line.replace(/^\t+/, '') : line) === current.mark) {
        spans.push({ start: current.bodyStart, end: pos });
        const following = queue.shift();
        current = following ? { ...following, bodyStart: next } : null;
      }
    } else {
      for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_]\w*))/g)) {
        queue.push({ mark: (m[2] ?? m[3] ?? m[4]) as string, dash: m[1] === '-' });
      }
      const first = queue.shift();
      if (first) current = { ...first, bodyStart: next };
    }
    pos = next;
  }
  if (current && current.bodyStart < command.length) spans.push({ start: current.bodyStart, end: command.length });
  return spans;
}

function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A code body cut to its first `headChars`, a note naming what was elided (`label` is
 * "Tool.field for path"), and a salvage block for the tail. The original when that is not shorter.
 */
export function elideBody(text: string, label: string, headChars: number, salvageChars: number): string {
  if (text.length <= headChars + 120) return text;
  const cut = Math.max(0, splitsSurrogatePair(text, headChars) ? headChars - 1 : headChars);
  const head = cut > 0 ? `${text.slice(0, cut)}\n` : '';
  const note = `[fast-jev-compaction elided ${withCommas(text.length - cut)} chars of ${label}; Read the file if needed]`;
  const salvaged = salvageBlock(text.slice(cut), salvageChars);
  const out = salvaged ? `${head}${note}\n${salvaged}` : `${head}${note}`;
  return out.length < text.length ? out : text;
}
