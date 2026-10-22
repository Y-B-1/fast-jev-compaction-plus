import { sha256Hex } from './sha256.js';
import type { Message } from './types.js';

/** One image or document block, as the Messages API form of the conversation holds it. */
export type Media = { kind: 'image' | 'document'; mediaType: string; data?: string };

/**
 * The conversation's media: tool results' by call id, pasted ones by their prompt's text and that
 * text's rank among the prompts (0 for the first prompt with that text, 1 for the next).
 */
export type MediaMap = {
  results: Map<string, Media[]>;
  prompts: { text: string; rank: number; media: Media[] }[];
};

/** Saves one archived copy (`name` in the archive directory) and its INDEX.md line; returns the copy's path. */
export type MediaArchive = (name: string, data: string, line: string) => string;

const isMedia = (block: Record<string, unknown> | undefined): boolean =>
  block?.['type'] === 'image' || block?.['type'] === 'document';

function toMedia(block: Record<string, unknown>): Media {
  const source = (block['source'] ?? {}) as Record<string, unknown>;
  const kind = block['type'] === 'document' ? 'document' : 'image';
  const media: Media = { kind, mediaType: typeof source['media_type'] === 'string' ? source['media_type'] : kind };
  if (source['type'] === 'base64' && typeof source['data'] === 'string') media.data = source['data'];
  return media;
}

/** A prompt's text for matching the two forms: no `[Image…]` markers, no whitespace. */
const squash = (text: string) => text.replace(/\[Image[^\]]*\]/g, '').replace(/\s+/g, '');

/** Finds the images and documents in the API form (`$.session.messages({ as: 'api' })`). */
export function findMedia(api: readonly { role: string; content: readonly unknown[] }[]): MediaMap {
  const found: MediaMap = { results: new Map(), prompts: [] };
  const ranks = new Map<string, number>();
  for (const message of api) {
    if (message.role !== 'user') continue;
    const pasted: Media[] = [];
    const texts: string[] = [];
    let results = false;
    for (const raw of message.content) {
      const block = (raw ?? {}) as Record<string, unknown>;
      if (block['type'] === 'tool_result') {
        results = true;
        const content = Array.isArray(block['content']) ? (block['content'] as Record<string, unknown>[]) : [];
        const media = content.filter(isMedia).map(toMedia);
        if (media.length > 0 && typeof block['tool_use_id'] === 'string') found.results.set(block['tool_use_id'], media);
      } else if (isMedia(block)) pasted.push(toMedia(block));
      else if (block['type'] === 'text' && typeof block['text'] === 'string') texts.push(block['text']);
    }
    if (results) continue;
    const text = texts.join('\n');
    const rank = ranks.get(squash(text)) ?? 0;
    ranks.set(squash(text), rank + 1);
    if (pasted.length > 0) found.prompts.push({ text, rank, media: pasted });
  }
  return found;
}

/** The first sentence of the model's next reply after `index`, the description the image got then. */
function describe(messages: readonly Message[], index: number): string | undefined {
  for (const message of messages.slice(index + 1)) {
    if (message.role !== 'assistant' || !message.text.trim()) continue;
    const text = message.text.replace(/\s+/g, ' ').trim();
    const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
    return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
  }
  return undefined;
}

function placeholder(
  media: Media,
  from: 'tool result' | 'pasted',
  path: string | undefined,
  description: string | undefined,
  copy: string | undefined,
): string {
  const name = path ? path.slice(path.lastIndexOf('/') + 1) : from === 'pasted' ? `a pasted ${media.kind}` : `a tool result ${media.kind}`;
  const parts = [
    `[${media.kind} removed by compaction`,
    `${name} (${media.mediaType})`,
    description ? `described then as: "${description}"` : 'no description recorded',
  ];
  if (path) parts.push(`view again: Read ${path}`);
  if (copy) parts.push(`archived copy (base64): ${copy}`);
  if (!path && !copy) parts.push('no copy kept');
  return `${parts.join(' · ')}]`;
}

/**
 * Removes the images and documents the compacted history would carry, as Claude Code's own summary
 * does, and leaves a placeholder in each one's place: what it was, how the model described it then,
 * the file to Read it from again, and the archived copy. A tool result loses its media anyway once
 * its row goes back without its handle; a pasted image goes with its prompt's handle, except in the
 * current prompt, the newest user row without tool results, which stays as it is.
 */
export function placeMedia<M extends Message & { handle?: string }>(
  messages: readonly M[],
  found: MediaMap,
  archive?: MediaArchive,
): { messages: M[]; images: number; documents: number; kept: number } {
  const counts = { images: 0, documents: 0, kept: 0 };
  const paths = new Map<string, string>();
  for (const message of messages) {
    for (const tool of message.toolUses) {
      const path = tool.input?.['file_path'];
      if (typeof path === 'string') paths.set(tool.tool_use_id, path);
    }
  }
  let current = messages.length - 1;
  while (current >= 0 && (messages[current]!.role !== 'user' || (messages[current]!.toolResults?.length ?? 0) > 0)) current -= 1;
  const place = (media: Media, from: 'tool result' | 'pasted', path: string | undefined, index: number): string => {
    counts[media.kind === 'image' ? 'images' : 'documents'] += 1;
    const description = describe(messages, index);
    let copy: string | undefined;
    if (archive && media.data) {
      const ext = (media.mediaType.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
      const name = `${media.kind === 'image' ? 'img' : 'doc'}-${sha256Hex(media.data).slice(0, 12)}.${ext}.b64`;
      copy = archive(name, media.data, `${media.kind} ${path ?? 'pasted'} · ${description ? `"${description}"` : 'no description'}`);
    }
    return placeholder(media, from, path, description, copy);
  };
  const pasted = new Map(found.prompts.map((p) => [`${p.rank}\0${squash(p.text)}`, p]));
  const ranks = new Map<string, number>();
  const out = messages.map((message, index) => {
    if ((message.toolResults?.length ?? 0) > 0) {
      if (!message.toolResults!.some((result) => found.results.has(result.tool_use_id))) return message;
      const toolResults = message.toolResults!.map((result) => {
        const media = found.results.get(result.tool_use_id);
        if (!media) return result;
        const notes = media.map((m) => place(m, 'tool result', paths.get(result.tool_use_id), index));
        return { ...result, text: [result.text, ...notes].filter(Boolean).join('\n') };
      });
      const { handle: _handle, ...rest } = message;
      return { ...rest, toolResults } as M;
    }
    if (message.role !== 'user') return message;
    const text = squash(message.text);
    const rank = ranks.get(text) ?? 0;
    ranks.set(text, rank + 1);
    const prompt = pasted.get(`${rank}\0${text}`);
    if (!prompt) return message;
    if (index >= current) {
      counts.kept += prompt.media.length;
      return message;
    }
    const sources = [...message.text.matchAll(/\[Image: source: ([^\]]+)\]/g)].map((m) => m[1]!.trim());
    const notes = prompt.media.map((m, i) => place(m, 'pasted', sources[i], index));
    const { handle: _handle, ...rest } = message;
    return { ...rest, text: [message.text, ...notes].join('\n') } as M;
  });
  return { messages: out, ...counts };
}

const NOTE_LINE = /^\[(?:image|document) removed by compaction · .*\]$/;

/** Splits a result's text into its media placeholders and the rest, so a later cut of the rest keeps them whole. */
export function splitMediaNotes(text: string): { rest: string; notes: string[] } {
  const lines = text.split('\n');
  const notes = lines.filter((line) => NOTE_LINE.test(line));
  return notes.length === 0 ? { rest: text, notes } : { rest: lines.filter((line) => !NOTE_LINE.test(line)).join('\n'), notes };
}

/** The toast's note on removed media: `2 images and 1 document removed (paths kept)`, or ''. */
export function mediaNote(images: number, documents: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [images > 0 ? plural(images, 'image') : '', documents > 0 ? plural(documents, 'document') : ''].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' and ')} removed (paths kept)` : '';
}
