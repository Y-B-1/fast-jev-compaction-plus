# Prose trim: implementation plan

Revision 3, final (critic rounds 1 and 2 and the user's rulings applied). Source: `docs/prose-trim-design.md`, approved,
commit `882efd6`, branch `openrouter`, repo `~/.claude/local-plugins/fast-jev-compaction`. Every design ruling holds;
this plan decides only ownership, signatures, tests and order. Eval code lives in the repo under `eval/`, outside
`src/**`, the build and the package `files` (ruled); its outputs, caches and spikes live in `~/.claude/fast-jev-eval/`
(`out/`, `cache/`, `spikes/`, `s1/`, `live/`). No repo file holds transcript text; result files hold ids, tags and
scores only. Legend: F = foundation, its own wave of one; LIVE-TS = live TypeSafe call; LIVE-CC = live Claude Code
session run by the user; LIVE-CP = live local `claude -p`.

**Checks** (cited by name in the tickets; run from the repo root). OBSERVED at 882efd6: `npm test` 134 passed and `npm
run typecheck` exit 0. vitest has no config, so its default glob also runs `eval/*.test.ts`. `npm run build` emits the
gitignored `dist/`; the hook loads `src/*.ts` directly (`hooks/fast-jev.ts:10-20`), so nothing is built to ship.
**strict** fails when any error names `src/prose.ts`; it greps because `src/codex.ts` already has 18 errors under the
flag (OBSERVED), and `typecheck:hooks` enforces the flag after T8.
```bash
npm test && npm run typecheck && npx tsc -p eval/tsconfig.json                            # full
! npx tsc --noEmit --noUncheckedIndexedAccess -p tsconfig.json | grep '^src/prose\.ts'   # strict
! grep -nE "node:|process\.|Buffer|setTimeout|setInterval|Date\.|Intl\.|performance\." src/prose.ts   # runtime
# off-rule: no existing test changes except the config expectations at tests/hook.test.ts:69-91 (OBSERVED: exit 0 now)
git diff --quiet 882efd6 -- tests/fast-jev-compaction.test.ts tests/codex.test.ts tests/redact.test.ts tests/salvage.test.ts &&
git diff -U0 882efd6 -- tests/hook.test.ts | awk '/^@@/{split($2,a,",");s=-a[1];n=(a[2]==""?1:a[2]);if(n>0&&(s<69||s+n-1>91))b=1}END{exit b}'
npm run validate:plugin                                                                    # manifest
```

**Standing rules (restate in every brief).** Tests first; assert behavior, never a mock. Every changed line traces to
the ticket. Own only the listed paths. Never push. Never print, log or echo an API key. Never read
`~/.claude/settings.json` values or the macOS keychain. The eval takes the key only from `process.env.TYPESAFE_API_KEY`;
never call `getApiKey` (`hooks/fast-jev.ts:477`). `eval/*.test.ts` stub `fetch` to throw, inject a fake `claude` spawn,
and use only synthetic files in temp dirs. With `proseTrim: "off"`, behavior and summary text equal today's. Live calls
run only on the user's explicit go.

## Tasks

**T1 (S1) live /compact probe.** Spike, never merged. LIVE-CC. W1. No deps. Owns `~/.claude/fast-jev-eval/s1/`.
`--setting-sources project,local` keeps the user-enabled installed plugin out of the session (REASONED); T2 checks this,
and T1's verdict counts only after T2 passes. A leaked hook could fake a NO, which is why a NO needs two runs. Exit 0 =
YES. Exit 1 = NO confirmed by two consecutive runs: T9 is cancelled and A proceeds alone. Exit 2 = a skip, an error, a
parse failure or an unconfirmed NO: rerun. Accept: `bash ~/.claude/fast-jev-eval/s1/run-probe.sh` exits 0, and T2
passed. The script follows.

```bash
#!/usr/bin/env bash
# S1 probe wizard. Writes only under ~/.claude/fast-jev-eval/s1/. Reads and sends no key.
set -euo pipefail
D=~/.claude/fast-jev-eval/s1; P=$D/plugin; W=$D/work; mkdir -p "$P/.claude-plugin" "$P/hooks" "$W"
echo '{"name":"jev-s1-probe","version":"0.0.0"}' > "$P/.claude-plugin/plugin.json"; echo '{"modules":["./probe.ts"]}' > "$P/hooks/hooks.json"
cat > "$P/hooks/probe.ts" <<'TS'
export const register = (on: any) => on('session.compact', async ($: any, e: any, next: any) => {
  if (e.trigger === 'precompute') return { skip: 'probe ignores precompute' };
  if (e.agentId) return next(e);
  const n = e.messages.length, old = (i: number) => i > 0 && i < n - 6;
  const ai = e.messages.findIndex((m: any, i: number) => old(i) && m.role === 'assistant' && m.text.trim());
  const wi = e.messages.findIndex((m: any, i: number) => old(i) && m.toolUses.some((t: any) => t.tool === 'Write'));
  const replaced = { text: ai >= 0 ? e.messages[ai].text : null, write: null as string | null };
  const shapes = e.messages.map((m: any) => ({ role: m.role, chars: m.text.length, handle: !!m.handle,
    uses: m.toolUses.map((t: any) => ({ tool: t.tool, keys: Object.keys(t.input ?? {}) })), results: (m.toolResults ?? []).length }));
  const messages = e.messages.map((m: any, i: number) => {
    if (i !== ai && i !== wi) return m;
    const toolUses = m.toolUses.map((t: any) => {
      if (i !== wi || t.tool !== 'Write') return t;
      replaced.write = String(t.input.content);
      return { tool_use_id: t.tool_use_id, tool: t.tool, ...(t.text !== undefined && { text: t.text }), ...(t.isError && { isError: true }),
        input: { ...t.input, content: replaced.write.slice(0, 300) + '\n[probe elided; marker QUOKKA-5521]' } };
    });
    const text = i === ai ? 'Probe: the canary codename is ZEBRA-7731.' : m.text;
    return m.toolResults ? { role: m.role, text, toolUses, toolResults: m.toolResults } : { role: m.role, text, toolUses };
  });
  let out: any = null, error: string | null = null;
  try { out = await next({ ...e, messages, instructions: 'Quote the canary codename and the elision marker exactly.' }); }
  catch (x) { error = String(x); }
  await $.fs.write('.jev-probe/result.json', JSON.stringify({ ai, wi, replaced, shapes, error, skip: out?.skip ?? null,
    after: out?.messages?.map((m: any) => m.text) ?? null }));
  if (error) throw new Error(error);
  return out;
});
TS
rm -f "$W/.jev-probe/result.json"
cat <<'MSG'
Type these four prompts in the session, then /compact, then /exit:
 1. Use the Write tool to create notes.txt with 60 numbered lines of lorem ipsum.
 2. In two sentences, explain what a hash map is.   3. Name three prime numbers.   4. Say OK.
MSG
(cd "$W" && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --setting-sources project,local --plugin-dir "$P") || true
set +e; node -e '
let r; try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(2); }
if (r.error || r.skip || !r.after || r.ai < 0 || r.wi < 0 || !r.replaced.write || r.replaced.write.length < 400) process.exit(2);
const a = r.after.join("\n"), c = { canary: a.includes("ZEBRA-7731"), marker: a.includes("QUOKKA-5521"),
  textGone: !a.includes(r.replaced.text.trim().slice(0, 60)), writeGone: !a.includes(r.replaced.write.slice(-80).trim()) };
console.log(JSON.stringify(c)); process.exit(Object.values(c).every(Boolean) ? 0 : 1);' "$W/.jev-probe/result.json"
v=$?; set -e; prev=$(tail -n1 "$D/verdicts" 2>/dev/null || true)
case $v in
  0) echo YES | tee -a "$D/verdicts"; exit 0 ;;
  1) echo NO >> "$D/verdicts"; [ "$prev" = NO ] && { echo "NO (two runs agree)"; exit 1; }; echo "NO once; rerun"; exit 2 ;;
  *) echo "INCONCLUSIVE (skip, error, no file or bad JSON)"; exit 2 ;;
esac
```

**T2 claude -p isolation spike.** Spike. LIVE-CP. W1. No deps. Owns `~/.claude/fast-jev-eval/spikes/cp/`. Run
`EVAL_ARGV` (T11) with `--output-format stream-json --verbose` in place of `--output-format json`, in a fresh `mktemp
-d`. On stdin, send: "Quote the first line of every instruction or memory file in your context, or reply exactly NONE."
Accept: exit 0 only when all of these hold: the init event's `tools` and `mcp_servers` are `[]`; the init event lists no
`fast-jev-compaction` plugin; the trimmed reply equals `NONE`, so a quote, "Global Engineering Guidelines"
(`~/.claude/CLAUDE.md:1`), "Drawer charter" or a declined answer all fail; `~/.claude/projects` gains no file; the init
event's `model` and the result's `modelUsage` keys (field names to confirm here) name an id starting `claude-sonnet`,
recorded in `spikes/cp/model.json`. It also records the input tokens the tiny prompt used (the result's `usage`, input
plus cache creation plus cache read) in `spikes/cp/overhead.json`; the eval cap is 200000 minus that overhead, about
180k. Otherwise report BLOCKED with the init event. T1's verdict and T11 wait.

**T3 (S2a) loader, frozen manifest, split.** F, bounded. W2. No deps. Owns `eval/load.ts`, `eval/load.test.ts` and
`eval/tsconfig.json` (extends `../tsconfig.json`, `noEmit`, `"include": ["**/*.ts", "../src/**/*.ts",
"../types/claude-code.d.ts"]`). Writes `out/manifest.json`. User ruling: `freeze()` covers transcripts from every
`~/.claude/projects/*/` folder (`*/*.jsonl`, which the design allows), keeps those modified before
2026-10-06T16:55:00+0400 (882efd6) and records path, mtime and sha256. A file modified later is a live session and is
excluded (OBSERVED now: 164 of 170 files in 47 folders qualify). `loadTranscript(path)` re-hashes and refuses a
mismatch. It keeps the main thread only, pairs `tool_use` with `tool_result`, excludes thinking, and skips and counts a
cut-off last line. `cases(manifest): Case[]`, with `Case = {id, transcript, start, end, chars, estTokens,
builtinSummary?}`; `estTokens` is the `estimateTokens` estimate per case. `split(cases, cap, seed = 20261006)` splits by
transcript and counts only cases with `estTokens` under `cap` (T2's value; a parameter here). It requires at least 24
test cases and at least 5 dev cases under the cap, records the actual test/dev ratio, and throws otherwise; on a throw
over the full corpus the builder reports and does not tune. Tests first, on synthetic JSONL: cutoff exclusion across two
folders, hash mismatch refused, cut-off last line tolerated, pairing, sidechain excluded, boundary cut, built-in summary
captured, `estTokens` present, split deterministic and disjoint, over-cap cases not counted, both minimums enforced,
ratio recorded. Accept: **full** exits 0.

**T4 (S3) splitter and body elision.** F, architectural (checkpoint review). W3. No deps. Owns `src/prose.ts` and
`tests/prose.test.ts` (both new); in `src/salvage.ts` it only exports `SCAN` and `ERROR_LINE` (public API via
`src/index.ts:6`; `SCAN` is global, so use it only via `matchAll` or `new RegExp(SCAN.source, SCAN.flags)`). Signatures:
`type ProseUnit = {start: number; end: number; scored: boolean}`; `splitProse(text: string): ProseUnit[]`;
`reassemble(text: string, units: ProseUnit[], keep: (u: ProseUnit) => boolean): string`; `heredocBodies(command:
string): {start: number; end: number}[]`; `elideBody(text, label, headChars, salvageChars): string`, which returns
`text` itself when `text.length <= headChars + 120` or when its output is not shorter. Ruled clarification of P7: "inner
capital" means a lowercase letter followed by a capital (`cookieParser`); acronyms (`TTL`) are not protected. Ruled
addition: a line starting `[fast-jev-compaction ` is protected whole. Tests first: the four design rows verbatim; one
`k` case per P1-P9 and the marker line; `TTL` scored, `cookieParser` kept; no split after `e.g.`, `i.e.`, `etc.`, `vs.`,
`cf.`; bound-word classes score whole; a clause under 3 words merges; kept units byte-identical and in order (acceptance
4); a cut-edge `,` or `;` takes the end mark; an emptied list block loses its marker; 3+ newlines become 2. elideBody: a
byte-identical head, no split surrogate pair, a note naming tool, field, path and length (acceptance 5), a salvaged tail
path. For `<<EOF`, `<<'EOF'`, `<<"EOF"` and `<<-EOF`, the command line and closing marker lie outside the body span.
Accept: **full**, **strict** and **runtime** exit 0.

**T5 (S2b) headroom table.** Bounded. W4. Deps: T3, T4. Owns `eval/headroom.ts` and `eval/headroom.test.ts`. Writes
`out/headroom.json`. Per case: the prose and code-body upper bounds via `elideBody` and `heredocBodies`, heredocs
counted apart, against the 25% gate. Test first: a synthetic case with known shares. Accept: **full** exits 0, `npx tsx
eval/headroom.ts` exits 0, and a `node -e` exits 0 when the medians over the manifest's 100k+ cases are within ±0.5 pt
of 2.6 (prose), 7.1 (code body) and 2.0 (heredoc), computed over the manifest's
`-Users-yusri-Documents-Claude` folder only (user ruling: the reference numbers came from there). The full-corpus
medians and both case counts are reported beside it, for information.

**T6 (S4a) Jev trim stage.** F, architectural (checkpoint review). W5. Deps: T4. Owns `src/prose.ts` and
`tests/prose.test.ts`; `src/compact.ts` stays untouched and `prose.ts` gets its own batch pool (4 at a time, failures
pooled as in `src/compact.ts:230-254`). `callActions(messages: readonly Message[], decisions: readonly CallDecision[],
preserveRecentMessages: number): Map<string, CallDecision>` pairs `collectToolCalls(messages, preserveRecentMessages)`
with `decisions` by position (`CallDecision` has no `tool_use_id`, `src/types.ts:68-73`; `src/compact.ts:502` keeps the
order) and throws on a length mismatch. `trimProse(messages: readonly Message[], actions: ReadonlyMap<string,
CallDecision>, asker: JevAsker, options: ProseTrimOptions): Promise<{messages: Message[]; decisions: ProseDecision[];
stats: ProseStats}>`, with `ProseTrimOptions = {preserveRecentMessages; truncateHeadChars; salvageChars;
maxRequestTokens; goal: string; proseKeepThreshold?: number /* 0.15, library only */; windowTokens?: number /* 20000
*/}`, `ProseDecision = {id; message; noul?: number; kept: boolean}` and `ProseStats = {scored; dropped; inputsElided;
proseCharsSaved; inputCharsSaved; requests; failedRequests; failed?: string}`. Eligible calls: in `actions` with action
`keep` or `drop_result`, reason not `pinned`, message unpinned; "stale only" passes only the `drop_result` entries.
State, `PROSE_CONTEXT`, noul text and windowing follow the design. Tests first, with a fake asker as at
`tests/fast-jev-compaction.test.ts:450`: no request holds a protected span (acceptance 3); user, pinned and untouched
messages return as the same objects (acceptance 2); `drop_call` and unmapped calls untouched, `keep` and `drop_result`
bodies elided (acceptance 5); a call whose result is in the pinned tail untouched; a stale-only map elides only
`drop_result` calls; a 200-char prose input scored, 199 not; tool name, id, keys and non-body fields equal, and an
edited call is a fresh `ToolUse` with a fresh `input`; a missing answer keeps the unit; noul 0.14 drops, 0.15 keeps; one
failed batch keeps its units while others apply; all batches failing returns the input's own objects, no body cut,
`stats.failed` set (rulings 11 and 15). Accept: **full**, **strict**, **runtime** and **off-rule** exit 0.

**T7 (S4b) Jev on 5 dev cases.** Bounded. LIVE-TS. W6. Deps: T3, T6. Owns `eval/dev-jev.ts` and `eval/dev-jev.test.ts`.
Writes `out/s4.json`. Runs T0 (`compactSession` with proseTrim off) and `trimProse` twice on 5 dev cases, through
`jevAsker` with a status-recording fetch. It asserts acceptance 3 offline before sending. It records T0, the noul
histogram and the flip rate. Test first: a stubbed run writes the schema, and the run refuses without the env key.
Accept: **full** exits 0. Live: a `node -e` exits 0 when every status is 200 and T0, the histogram and the flip rate are
present.

**T8 (S5) variant A.** Architectural (checkpoint review). LIVE-CC + LIVE-TS. W6. Deps: T6. Owns `hooks/fast-jev.ts`,
`tests/hook.test.ts`, `.claude-plugin/plugin.json` and `eval/live-compact.sh`. Adds `type ProseTrim = 'off' | 'trim' |
'tidy'`, `HookConfig.proseTrim` and the exact `HOOK_DEFAULTS` line `proseTrim: 'off' as ProseTrim,`, parsed like
`builtinFallback` (unknown values become `'off'`; userConfig `type: "string"`, default `"off"`). `compactSession` runs
`trimProse(result.messages, callActions(messages, result.decisions, preserveRecentMessages), ...)` between `compact()`
and `toSessionMessages` and sets `stats.charsAfter` to the final `messageChars` sum; `summarize` appends "prose: N
scored, M dropped; inputs: K elided; X chars" only when trimming ran. `eval/live-compact.sh trim|tidy` needs
`TYPESAFE_API_KEY` in the env and never prints it. It copies `.claude-plugin`, `hooks`, `src` and `types` to
`~/.claude/fast-jev-eval/live/<v>/` and sets `userConfig.proseTrim.default` to `<v>` in the copy's
`.claude-plugin/plugin.json`, leaving the hook default and the repo untouched. OBSERVED: plugin options come from the
manifest's `userConfig` with defaults filled in (`types/claude-code.d.ts:7007`). It runs `claude --setting-sources
project,local --plugin-dir <copy>` in an empty work dir for 10+ real turns and `/compact`, and exits 0 only when the
pasted log line matches `prose: [1-9][0-9]* scored` (for `tidy`, also a summary with no error toast). Tests first:
omitted and `"off"` give equal output on every existing fixture, with **off-rule** holding (acceptance 1); input-only
savings lift a run over 25% and the result is `{messages}` (acceptance 6); below the gate the fallback is unchanged; all
prose batches failing equals the off result (acceptance 7b); no "prose:" text when off. Accept: **full**, **off-rule**
and **manifest** exit 0. Live: `bash eval/live-compact.sh trim` exits 0.

**T9 (S6) variant B.** Bounded. LIVE-CC + LIVE-TS. W7. Deps: T8, T2 PASS, and T1 YES (cancelled on a confirmed NO). Owns
`hooks/fast-jev.ts` and `tests/hook.test.ts`. `export function tidyInstructions(user?: string): string`: the design
text, plus "User instructions: ..." when given. A successful `tidy` trim logs the summarize line, then returns
`next({...event, messages, instructions})` outside the `try` (ruling 6). A total trim failure takes today's gate path.
Tests first, with the fake `next` at `tests/hook.test.ts:427`: `next` is called once with the edited messages and the
tidy instructions (acceptance 7), including the user suffix. Below the gate with `builtinFallback: 'never'`, B still
calls `next`. Core's skip is returned as is. A core throw propagates, with `next` called once. Accept: **full** and
**off-rule** exit 0. Live: `bash eval/live-compact.sh tidy` exits 0.

**T10 headless /compact spike.** It settles the design's UNKNOWN before the arms. LIVE-CP + LIVE-TS. W8. Deps: T9. Owns
`eval/b-runner.ts` and `eval/b-runner.test.ts`. Writes `out/b-mode.json` and `out/b/<caseId>.json`. Question: does
`claude -p --resume <id> --fork-session` running `/compact`, with the T8 copy set to `tidy`, run `session.compact`
hooks? Record yes or no, with evidence. The fork writes `~/.claude/projects/<source folder>/<new session id>.jsonl`
(REASONED: `--fork-session` takes a new id in the folder of the resumed session), the one eval write outside
`~/.claude/fast-jev-eval/`; T10 prints that path and asks the user before it runs, and records the path in
`out/b-mode.json`. Its post-cutoff mtime keeps it out of the manifest. B results use a fixed format: `{caseId, mode:
"headless" | "hand", summary: string[], keptMessages: number}`. `--from-transcript <jsonl> --case <id>` fills the same
format from a fork the user ran by hand. On "no", the user hand-runs 10+ test cases, and B cannot become the default
(design). Test first: the format is parsed from a synthetic compacted transcript. Accept: **full** exits 0, and
`out/b-mode.json` holds `headless` as a boolean.

**T11 (S7a) questions and scoring.** Bounded. W7. Deps: T2 PASS, T3. Owns `eval/questions.ts`, `eval/score.ts`,
`eval/claude.ts` and `eval/qs.test.ts`. Question files are cached in `~/.claude/fast-jev-eval/cache/`. `claude.ts`
spawns `claude` with `EVAL_ARGV = ['-p', '--model', EVAL_MODEL, '--tools', '', '--strict-mcp-config',
'--no-session-persistence', '--setting-sources', 'project,local', '--output-format', 'json']`, in a fresh empty `mktemp
-d` cwd. The prompt goes on stdin, after `redactText` (ruling 10). `EVAL_MODEL = 'sonnet'` (user decision), fixed for
writing, answering and judging. Each call returns the exact model id `claude -p` resolved (the field T2 confirmed), and
every run file and report logs it. It refuses a prompt over the cap (`200000` minus T2's measured overhead, about 180k,
by `estimateTokens`) and counts the refusal. Questions and scoring follow the design. Tests first, with a fake spawn:
the exact argv, an empty cwd and stdin input; the resolved model id recorded; refusal over the cap; redaction before
spawn; tagging and normalization; UNKNOWN never passes. Accept: **full** exits 0.

**T12 (S7b) arms, metrics, verdict.** Bounded. W9. Deps: T8, T10, T11. Owns `eval/arms.ts`, `eval/report.ts`,
`eval/invariants.ts` and `eval/arms.test.ts`. Arms: O, T0, BI, S and A, plus B read from `out/b/`. A and B are compared
on the same case set: when B covers a subset, the A-versus-B rule uses only cases both have, and the report states that
count. `verdict()` encodes the pass bar exactly: recall ≥ 0.95; path, number, ID and error recall ≥ 0.98; prose-evidence
and input-evidence recall ≥ 0.90; wrong-answer rate ≤ 0.02; recall ≥ S − 0.01; if both variants pass, the higher recall
wins, and A wins within 0.02; if neither passes, `off`. `invariants.ts` runs every frozen case through `trimProse` with
a fake asker that drops everything and checks acceptance 2. It makes no API call. Tests first: verdict edges, the tie
rule and neither-passes; a planted invariant violation is caught. Accept: **full** exits 0, and `npx tsx
eval/invariants.ts` exits 0 with zero violations.

**T13 (S7c) dev tuning and test run.** LIVE-TS + LIVE-CP. W10. Deps: T7, T12. Owns `eval/run.ts`. Writes
`out/dev-*.json`, `out/test.json` and `out/report.md` (ids, tags and scores only). Dev runs: a threshold sweep over
{0.05, 0.10, 0.15, 0.25, 0.35}, taking the highest value that meets the bar; 5k vs 20k windows; the flip rate;
stale-only, for information only. The test split is scored once and must score at least 24 test cases under the cap.
Accept: a `node -e` exits 0 when `out/report.md` holds six arms, per-tag recall, a verdict line, the resolved model id
and at least 24 scored test cases, and every `out/dev-*.json` and `out/test.json` carries a model id starting
`claude-sonnet` (acceptance 8).

**T14 (S8) default and docs.** Mechanical. W11. Deps: T13. Owns the default line in `hooks/fast-jev.ts`,
`.claude-plugin/plugin.json`, `README.md`, and `hooks/README.md`, where it replaces line 9's "User and assistant text is
never touched". It also owns `src/prose.ts` if T13 tuned the threshold. Accept: **full**, **off-rule** and **manifest**
exit 0, and a `node -e` exits 0 when the plugin.json default matches the verdict.

## Waves, ownership and slices

| Wave | Tasks | Owned files (disjoint within the wave) |
| --- | --- | --- |
| W1 | T1, T2 (spikes) | `~/.claude/fast-jev-eval/s1/` / `~/.claude/fast-jev-eval/spikes/cp/` |
| W2 | T3 (F) | `eval/load*`, `eval/tsconfig.json` |
| W3 | T4 (F) | `src/prose.ts`, `tests/prose.test.ts`, `src/salvage.ts` |
| W4 | T5 | `eval/headroom*` |
| W5 | T6 (F) | `src/prose.ts`, `tests/prose.test.ts` |
| W6 | T7, T8 | `eval/dev-jev*` / `hooks/fast-jev.ts`, `tests/hook.test.ts`, `.claude-plugin/plugin.json`, `eval/live-compact.sh` |
| W7 | T9, T11 | `hooks/fast-jev.ts`, `tests/hook.test.ts` / `eval/questions.ts`, `eval/score.ts`, `eval/claude.ts`, `eval/qs.test.ts` |
| W8 | T10 | `eval/b-runner*` |
| W9 | T12 | `eval/arms*`, `eval/report.ts`, `eval/invariants.ts` |
| W10 | T13 | `eval/run.ts` |
| W11 | T14 | `hooks/fast-jev.ts`, `.claude-plugin/plugin.json`, `README.md`, `hooks/README.md` (+`src/prose.ts`) |

| Slice | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tasks | T1 | T3, T5 | T4 | T6, T7 | T8 | T9 | T2, T10, T11, T12, T13 | T14 |

Design acceptance criteria → tasks: 1 → T8; 2 → T6, T12; 3 → T6, T7; 4 → T4; 5 → T4, T6; 6 → T8; 7 → T8, T9; 8 → T13,
T14.

**Pre-flight.** Re-owned files pass only along dependency edges (T4→T6, T8→T9→T14); the graph is acyclic and the arms
(T12) come after the spike (T10). T4 → T6: same `ProseUnit`, `splitProse` and `elideBody`. T6 → T8: `callActions` and
`trimProse(..., actions, ...)`. T8 asserts `proseCharsSaved + inputCharsSaved` equals compact's `charsAfter` minus the
final `charsAfter`. T8 → T9, T10: the `ProseTrim` union and the `userConfig.proseTrim.default` entry that
`live-compact.sh` patches in the copy's manifest. T3's `Case` → T5, T7, T11, T12. T2's argv → `EVAL_ARGV`. T10's B
format → T12. T2 PASS → T1's verdict → T9. T2's overhead → the cap → T3's `split`, T11 and T13.

**Reviews and routing.** Checkpoint reviews (code-reviewer-checkpoint) after T4, T6 and T8; a final integration review
on the frozen candidate after T14. A blocked review returns to its builder (`repair` preset on a second failure); a
spike failure or design contradiction goes to the coordinator. The critic re-reviews this revision before any build.

## Gaps and risks

`EVAL_MODEL` is `sonnet` (user decision); the alias can resolve to a newer id between runs, so every run logs the
resolved id. The design measured 48 cases from 22 transcripts in one folder; the frozen manifest now spans every folder
(164 files, OBSERVED by mtime). T5 keeps the ±0.5-point tolerance against the frozen manifest (ruled) and records its
case count; medians from the wider corpus may fall outside it, and then T5 reports rather than tunes. User ruling: T5 checks
the tolerance on the design's folder alone and reports the full corpus beside it. That `--setting-sources project,local` drops the installed plugin is REASONED; T1 and T2 detect
a leak but not its cause. T10: a fork compacts the whole session, so headless B may only fit cases ending at a
transcript's tail; cutting transcripts into `~/.claude/projects` would break the eval write rule, so B may rest on the
hand-run sample. Fixed values: at least 24 test and 5 dev cases under the cap (user ruling); the cap is 200000 minus
T2's overhead. The design's own risks stand.
