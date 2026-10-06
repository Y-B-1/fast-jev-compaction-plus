# Prose trim: design

Status: approved design (revision 3: scope widened to old tool-call inputs; all questions ruled). Branch `openrouter`, base `b9936ec`;
every file:line below was opened at that commit. Labels: OBSERVED (read or run here), REASONED, UNKNOWN.

## Goal and non-goals

Goal: besides old tool results, also shrink old assistant prose and old tool-call inputs. Jev scores clauses of
unprotected prose keep/drop and code removes the dropped clauses; every kept clause stays word for word. Code bodies in
old tool inputs are cut by a fixed rule, without Jev. Two output variants ship behind one option; a fact-recall eval
over the user's real transcripts picks the default. Why now (brief's evidence): today's run often frees only 7-16%,
under the 25% `minReductionRatio`, so the hook hands the session to the built-in summary (`hooks/fast-jev.ts:553-565`).

Non-goals: word-level scoring; changing tool-result scoring or the `call_`/`result_` nouls (`src/compact.ts:104-201`)
beyond integration; rewriting or reordering kept text; Codex (`src/codex*.ts`, `docs/codex-*`); release or push.

Do-not-touch (must behave exactly as today when `proseTrim` is `off`): tool-result decisions and thresholds
(`src/compact.ts:19-39`); `droppedCallNote` (`src/compact.ts:291-302`); `INPUT_CHARS`, which caps inputs only inside
Jev's state (`src/state.ts:15`); the subagent pass-through (`hooks/fast-jev.ts:531`); `toSessionMessages` handle
preservation (`hooks/fast-jev.ts:311-338`); redaction in `jevAsker` (`hooks/fast-jev.ts:262-263`); archive writing.

Glossary: **prose** = assistant `text` plus prose inputs. **Prose input** = `Agent`/`Task.prompt` or
`SendMessage.message` of 200+ chars. **Code body** = `Write.content`, `Edit`/`MultiEdit` `old_string`/`new_string`,
`NotebookEdit.new_source`, `Workflow.script`, a Bash heredoc body (ruling 13). **Eligible** = in an unpinned message and, for
inputs, in a call that survived `compact()`. **Protected span** = never cut, never scored. **Unit** = a clause, or a
whole sentence with no safe split. **Trim** = A, **tidy** = B. Avoided: "compress", "summarize" (for A), "pruner".

## Settled decisions

Verbatim from the brief, not reopened:

1. Scoring unit: clauses, with whole sentences as fallback when a sentence has no safe split. No word-level scoring.
2. Never cut or rewrite: the user's messages (user-role text), the most recent turns (reuse preserveRecentMessages,
   default 6, and message 0), code blocks (fenced and inline backticks), file paths, commands, numbers/versions,
   IDs/SHAs/URLs, error text. Protected spans are never sent to Jev for scoring. Tool-call inputs are not in the user's
   protected list, but this design does NOT trim them (keep scope to message prose).
3. Validation: a fact-recall eval built from the user's real transcripts (~/.claude/projects/*/*.jsonl, 22 in the main
   project dir). Extract facts/decisions/paths/open tasks from the original; a compacted version must still answer them.
   Ship a variant as default only above a pass bar you propose. At runtime, keep the existing fallback to built-in when
   a check fails.
4. Build both variants A and B behind one option; the eval decides the default.

User rulings of 2026-10-06 (these supersede the last sentence of decision 2):

5. **Scope:** prose plus tool-call inputs (25% of chars). Inputs are not protected as a whole; paths, commands,
   numbers, IDs, error text and code identifiers inside them stay protected, as everywhere else.
6. **B vs. the gate:** on success B always calls `next` with trimmed messages, ignoring the 25% gate and
   `builtinFallback`; the error path is unchanged.
7. **Pass bar** as proposed in the eval section.
8. **Option:** `proseTrim: "off" | "trim" | "tidy"` in `userConfig`, default `"off"` until the eval decides.
9. **Cut-edge mark:** a kept unit left ending in `,` or `;` by a dropped next clause takes the sentence's end mark.
10. **Eval model:** Claude via local `claude -p` (one fixed model), after `redactText`.
11. **Total trim-stage failure** degrades to today's tool-only result. 12. **Host-injected user-role text** stays
    protected.

User rulings on the revision-2 questions (relayed by the coordinator):

13. **Heredocs:** cut like code bodies. The command line stays protected.
14. **Which calls:** every unpinned call that decideCall kept. The dev split still compares this with the "stale only"
    option, for information only.
15. **Total Jev failure:** discard the whole new stage, including the rule-based body cuts, and return today's
    tool-only result.
16. **Input-evidence recall bar:** ≥0.90. The 0.98 bucket covers paths, numbers, IDs and errors wherever they appear.

## Measured headroom (read this first)

OBSERVED (local script over the 22 main-project transcripts, main thread, thinking excluded, nothing sent). Character
shares: tool results 53.0%, tool-call inputs 25.1%, user-role text 16.1% (about 95% host-injected), assistant prose
5.8% (12% of it fenced or inline code).

Tool-input characters by tool and field. "% of inputs" counts JSON-encoded field values (3,078,297 chars). "≈% of all"
is that share × 25.1%. "Unpinned" means outside message 0 and the last 6 messages of the compaction window. No
`MultiEdit` or `NotebookEdit` calls occur in these transcripts.

| Tool.field | % of inputs | ≈% of all | Unpinned | Treatment |
| --- | ---: | ---: | ---: | --- |
| `Bash.command` | 54.0 | 13.6 | 95.8% | command protected; heredoc body (45.2% of it) is a code body (ruling 13) |
| `Write.content` | 21.6 | 5.4 | 91.6% | code body |
| `Workflow.script` | 10.2 | 2.6 | 84.3%* | code body |
| `Edit.old_string`/`new_string` | 4.1 | 1.0 | 98.6% | code body |
| `Agent`/`Task.prompt` | 3.0 | 0.8 | 99.3% | prose input |
| `SendMessage.message` | 1.2 | 0.3 | 84.3%* | prose input |
| `file_path`/`path` (all tools) | 1.0 | 0.3 | 94.8% | protected |
| kept: `Bash.description` 2.8 (95.7% unpinned), `AskUserQuestion` 0.7, other 1.4 | 4.9 | 1.2 | | kept |

\* Measured for the "other" group as a whole. Over all inputs, 93.6% of chars are unpinned per window (99.5% per transcript).

Upper bound per compaction window, OBSERVED, 48 cases (windows ending at a boundary, 100k+ chars), % of all chars:
- Prose (all unpinned assistant prose outside code): median 2.6%, p10 0.8%, p90 9.3%.
- Code bodies (unpinned bodies cut to a 300-char head, a 150-char note and 300 chars of salvage): median 7.1%, p10
  0.0%, p90 15.4%, max 21.0%.
- Heredoc bodies: median 2.0%, p90 8.6%. Prose plus inputs: median 11.5% (p90 19.0%); with heredocs 14.1% (20.5%).
- Added to today's T0: at T0 = 7%, 5 of 48 cases clear 25% (11 with heredocs); at T0 = 16%, 31 of 48 (40).

REASONED revised range for A. Calls Jev already drops shrink to a 160-char note (`src/compact.ts:291-302`), so part of
the input bound overlaps T0, and clause trim removes only part of the eligible prose. Estimate: A ≈ T0 + 1-3 (prose) +
4-12 (code bodies, after overlap) + 0-6 (heredocs, ruling 13), about **12-30% per case, centred near 20-25%**. A now
clears the gate in a real share of cases, but not most; S2 and S4 measure it per case.

## Clause splitter and protected-span rules

The same steps apply to assistant text and prose inputs, exported as pure `splitProse(text)` for table tests.

1. **Eligibility.** Not pinned by `isPinned` (`src/state.ts:100-105`) computed on `compact()`'s output. REASONED safe:
   `compact()` only removes already-empty messages (`src/compact.ts:347`), so output-index pinning pins a superset of
   the original pinned messages. User-role messages are never eligible (rulings 5 and 12).
2. **Mask protected spans** in this order; each span is opaque to later steps.
   - P1 fenced code (```` ``` ```` or `~~~` to the closing fence; unclosed runs to the end); P2 lines indented 4+
     spaces or a tab (over-protecting is safe); P3 inline `` `...` ``; P4 table rows (`|` first) and headings (`#`).
   - P5 URLs, Windows and POSIX paths, SHAs, `NAME=value`: the `SCAN` regex (`src/salvage.ts:23`), reused as is.
   - P6 numbers, versions, dates, IDs: any token containing a digit (`v0.6.1`, `42%`, `2026-10-06`, `t12`, `#88`).
   - P7 code identifiers: a token with an inner `.`, `_`, `::`, `/` or capital (`req.session`, `cookieParser`).
   - P8 commands: a line starting `$ ` or `% `, and any token starting `-` plus a letter (`--force`, `-rf`).
   - P9 error text: a whole line matching `ERROR_LINE` (`src/salvage.ts:30`), and any quoted string over 3 chars.
3. **Units.** Each line is a block (a list item is its own block); blank lines separate paragraphs. Sentences end at
   `.`, `!` or `?` plus whitespace, except after `e.g.`, `i.e.`, `etc.`, `vs.`, `cf.`.
4. **Opener split.** A sentence-initial opener ending in a comma or semicolon within the first 4 words (`Okay,`
   `Great question;` `Sure,` `Perfect,`) is always its own unit.
5. **Bound sentences score whole.** A sentence has no safe split, and is one unit, when its rest holds a negation (not,
   n't, no, never, none, nothing, neither, nor, without, cannot), a condition or limit (if, unless, only, except, until,
   before, after, when, otherwise, instead), a contrast or cause (but, however, although, though, yet, because, since,
   so that) or an obligation (must, need, required, always, avoid). This keeps "X, but not on prod" from losing its "but
   not". Dropping a whole bound sentence can lose a fact (the eval measures it) but never flips its meaning.
6. **Clause split** (unbound sentences only): at `;`, at a spaced dash, and at `, ` before and, so, then, also, plus,
   which. A clause under 3 words (openers aside) merges into its neighbour.
7. **Protection wins.** A unit containing any protected span is kept whole and never becomes a question.

Examples (c = scored, k = kept unscored):

| Input | Units |
| --- | --- |
| `Okay, let me take a look at this, and see what I can figure out.` | c `Okay,` c `let me take a look at this,` c `and see what I can figure out.` |
| `Don't run the migration on prod, it drops the users table.` | c (whole: negation) |
| ``Run the build, but only after `npm ci` finishes.`` | k (inline code) |
| `Great question; the cache is stale because the TTL never resets.` | c `Great question;` c `the cache is stale because the TTL never resets.` (bound remainder) |

**Reassembly.** Kept units keep their original bytes and leading separator. A dropped unit goes with its trailing
separator, and a dangling cut-edge `,` or `;` takes the sentence's end mark (ruling 9). A block with no kept unit goes
with its list marker. Runs of 3+ newlines collapse to 2. A message left with empty text and no tool uses is removed
(`src/compact.ts:347`).

## Tool-input reduction

What exists, and is not duplicated: `call_<id>` nouls (`src/compact.ts:104-125`) and `decideCall` (`:165-201`) decide
whether a call survives at all. A dropped call becomes a 160-char note (`droppedCallNote`, `:291-302`). A surviving
call keeps its input verbatim (`applyDecisions`, `:368-373`). `INPUT_CHARS` (`src/state.ts:15`) only shortens what Jev
reads, never the output. This stage acts only on calls `decideCall` kept (`keep` or `drop_result`, ruling 14) and adds no
per-call question.

- **I1 Code bodies: rule-based, no Jev question.** A body over `truncateHeadChars + 120` (default 300,
  `src/compact.ts:36`) in an eligible call becomes: its first 300 chars (surrogate-safe, `splitsSurrogatePair`,
  `:258`); a note such as `[fast-jev-compaction elided 12,034 chars of Write.content for src/app.ts; Read the file if
  needed]`; and `salvageBlock(tail, salvageChars)` (`src/salvage.ts:97`) for paths, identifiers and error lines in the
  cut tail. Rule-based: the `call_` noul already judged the input, and code cannot be clause-split. Head plus salvage,
  not keep or a bare stub: it is the shape shipped for results (`truncatedResultText`, `:264-288`) and shows what kind
  of change was made; a code tail is mostly closing syntax.
- **I2 Protected fields, never changed:** the tool name and `tool_use_id`, every input key, every non-body field
  (`file_path`, `path`, `pattern`, `url`, `description`, ...), and the Bash command line. For a heredoc (ruling 13), only the
  lines between `<<MARK` and `MARK` count as the body.
- **I3 Prose inputs** go through `splitProse` and the same Jev questions as assistant text.
- **Output.** An edited call is a fresh `ToolUse` with a fresh `input` object in a new message, so `toSessionMessages`
  emits it handle-less via `toolUseSummary` (`hooks/fast-jev.ts:286-296`, `:329`), as truncated results are today.

## Jev question design

State per window (REASONED from the probe shape and the docs' backticked-path pattern):
```
{ context: PROSE_CONTEXT, goal, window: { m41: { role: "user", text }, m42: { role: "assistant",
  tools: "Read src/app.ts | Agent", c1: "...", k2: "...", a1: { tool: "Agent", c3: "...", k4: "..." } }, ... } }
```

- `PROSE_CONTEXT`: "A coding assistant conversation is being compacted. `window` is a stretch of it, oldest first.
  Assistant text and long tool-call prompts are split into numbered parts: `c` parts may be deleted, `k` parts always
  stay. Each question asks whether one `c` part must stay. A deleted part is gone for good; everything else stays word
  for word."
- `goal`: `goalFromMessages` (`src/state.ts:311`) plus `/compact` instructions (`hooks/fast-jev.ts:537-540`). `tools`:
  tool names with inputs cut to 60 chars (the shortest `INPUT_CHARS` cap). Prose inputs are `a<n>` objects. User and
  pinned messages are `{role, text}`, context only. `jevAsker` redacts all part text.
- One noul per scored unit, id `c<n>` (unique across the request):

- instructions: "Part `window.m42.c3` must stay: deleting it would lose information that the work in `goal` still needs
  and that no other part of `window` states"
- criteria.true: "It states something specific a later reader needs: a finding, a decision or its reason, a result, a
  change made, a failure, a limit or condition on an action, a step still to do, or an answer to the user"
- criteria.false: "It adds nothing of its own: an acknowledgement, greeting or praise; narration of what the assistant is
  about to do or just did that the tool calls already record; a repeat of another part; hedging, apology or politeness;
  an offer of more help"

**Windowing.** Eligible messages plus the user messages between them, up to 20,000 estimated tokens (`estimateTokens`,
`src/state.ts:59`), split at message (else paragraph) boundaries. Batches fit `maxRequestTokens` (60k) and the 32k
state-plus-question cap (`src/compact.ts:50`), 4 at a time. Cost (brief): about $0.03-0.04 per 150k-token session.

**Threshold.** A unit is kept when its noul is at or above `proseKeepThreshold`, default 0.15: as with `keepThreshold`
(`src/compact.ts:29`), 0.5 means unsure, and deletion is the irreversible side. A missing answer means keep. Probe
(synthetic): fluff 0.02-0.04, content 0.73-0.95. Tuning: sweep {0.05, 0.10, 0.15, 0.25, 0.35} on dev and take the
highest value that meets the pass bar.

## Integration points

- **New module `src/prose.ts`.** Pure `splitProse(text)` and `elideBody(text, label, headChars, salvageChars)`, plus
  `trimProse(messages, decisions, asker, options)` returning `{ messages, decisions, stats }`. The seam matches
  `compact()`'s: an injected `JevAsker`, faked in tests as `tests/fast-jev-compaction.test.ts:450` and
  `tests/hook.test.ts:148` do. Failure pooling follows `askBatches` (`src/compact.ts:230-254`). Untouched messages and
  tool uses come back as the same objects, so their handles survive (`hooks/fast-jev.ts:322-337`).
- **`compactSession`** (`hooks/fast-jev.ts:385-399`). When `proseTrim !== 'off'`, run `trimProse` after `compact()`
  (`:393`) and before `toSessionMessages` (`:398`). It takes `result.messages` (`src/compact.ts:514`) and
  `result.decisions` (to know the surviving calls), with the same `jevAsker` (`:245-284`).
- **Option.** `proseTrim` is parsed like `builtinFallback` (`hooks/fast-jev.ts:86-91`) in `resolveHookConfig`
  (`:107-148`), defaulted in `HOOK_DEFAULTS` (`:37-46`), typed in `HookConfig` (`:66`), and declared in
  `.claude-plugin/plugin.json` `userConfig` (`:6`).
- **Variant A (`trim`).** No new branch. The gate (`hooks/fast-jev.ts:553`) uses the combined ratio, and the success
  branch returns `{ messages }` (`:571`).
- **Variant B (`tidy`).** On success, return `next({ ...event, messages, instructions: tidyInstructions(...) })` in
  place of the gate branch (`:553-571`, ruling 6), outside the `try` so a throw never reaches a second `next` (`:585`);
  allowed by `types/claude-code.d.ts:9943`, `:9950-9951`; core returns a summary plus kept messages (`:9885-9893`). `tidyInstructions`: "The older messages were already trimmed by deleting filler and eliding
  old file contents; every remaining word is original. Condense them without losing any fact, decision or its reason,
  file path, command, number or version, identifier, error message, user instruction or constraint, or open task. Copy
  code, paths, commands and error text exactly. Add nothing that is not in the messages." It is followed by "User
  instructions: ..." when `event.instructions` is set.
- **Logging.** `summarize` (`hooks/fast-jev.ts:405`) gains "prose: N scored, M dropped; inputs: K elided; X chars".
  Later docs (not owned here): `hooks/README.md` says "User and assistant text is never touched".

## Reduction accounting and the 25% gate

- `charsBefore` stays the original total (`src/compact.ts:468`); `messageChars` (`:426`) already counts
  `JSON.stringify(tool.input)`, so input savings need no new counting. `charsAfter` = `messageChars` over the final
  messages. **Combined ratio** = (charsBefore − final charsAfter) / charsBefore (`reductionRatio`, `:439-442`), covering
  tool, prose and input savings; `trimProse` stats split prose from input chars for the log and the eval.
- **A:** the gate (`hooks/fast-jev.ts:553`) compares the combined ratio with `minReductionRatio` (0.25, `:39`).
  **B:** the gate is not consulted on success (ruling 6).

## Failure and fallback behavior

| Event | Behavior |
| --- | --- |
| One prose batch fails after the asker's retry | Its units are kept; other batches apply (`src/compact.ts:230-254` contract) |
| Every prose batch fails, or the splitter or `elideBody` throws | Trim stage returns its input unchanged (inputs included) and logs why; the run continues as today's tool-only compaction (rulings 11 and 15; the rule-based body cuts are discarded too) |
| Tool stage throws, or abort in either stage | Unchanged catch path (`hooks/fast-jev.ts:572-586`) or `interrupted()` veto (`:551`); trim never runs after a throw |
| A below the gate | Unchanged: built-in fallback or skip per `mayUseBuiltin` (`hooks/fast-jev.ts:553-565`, `:100-104`) |
| B: core returns a skip or throws | Returned or propagated as core's own result; no second `next` |

## Fact-recall eval

- **Cases.** A dev-only script (not in `dist`) writing only to `~/.claude/fast-jev-eval/`. Each transcript loads into `Message[]`, main thread only, tool_use paired with tool_result. A case is the
  history between two consecutive compaction boundaries, or a whole transcript with no boundary if over 50k tokens.
  There are 48 cases of 100k+ chars (OBSERVED above). Split by transcript, fixed seed: one third dev, two thirds test
  (scored once).
- **Questions.** Claude writes 15-25 per case from the ORIGINAL, each with a gold answer, an evidence quote and a
  category: decision and reason; path or command; number, version or ID; error and cause; open task; user instruction
  or constraint. Only facts first stated before the pinned tail count. Each question carries an **evidence tag**:
  assistant prose, tool result, user text, prose input, or code body. The input tags apply only when the sole evidence
  sits in an unpinned tool input, outside protected fields. Any question the original fails is dropped and counted.
- **Scoring.** An answerer sees only the arm's output and answers or says UNKNOWN. Path, number, ID and error
  questions pass on the normalized gold token; the rest go to a judge seeing only gold and answer. Metrics: recall; **prose-evidence recall**; **input-evidence recall**
  (prose-input and code-body tags, also per field); wrong-answer rate; chars saved, split into prose and input; for A,
  the share of cases that clear 25%.
- **Arms.** O original; T0 tool-only; BI recorded built-in summary; S as shipped (T0 if ≥ 25%, else BI); A; B. Dev
  only: real-prose score histogram, flip rate over 2 runs, 5k vs 20k windows.
- **Pass bar (rulings 7 and 16).** On the test split a variant may become the default only if: recall ≥ 0.95; recall
  ≥ 0.98 on path, number, ID and error questions wherever they appear, tool inputs included (a path named only in a
  `Write.content` body counts); prose-evidence recall ≥ 0.90; input-evidence recall ≥ 0.90; wrong-answer rate ≤ 2%;
  recall no more than 1 point below S. If both variants pass, the higher recall wins, and within 2 points A wins. If
  neither passes, the default stays `off`. Dev also runs the "stale only" elision (`drop_result` calls only) beside
  ruling 14's rule, for information only.
- **Secrets.** TypeSafe gets only what production sends, via `jevAsker` redaction (`src/redact.ts:53-80`); Claude gets
  text only via local `claude -p` after `redactText` (ruling 10). Result files hold ids, tags and scores, never text.
- **Running B offline.** UNKNOWN whether a headless forked session with `/compact` runs `session.compact` hooks; S7
  settles it. If not, B gets a hand-run sample of 10+ test cases and cannot become the default before a full run.

## Thin-slice order (each step yes/no)

1. **S1 live probe.** A probe-only hook in a throwaway session sets one old assistant text, handle-less, to "Probe:
   the canary codename is ZEBRA-7731.", elides one old `Write.content`, and calls `next` with "Quote the canary
   codename exactly." Yes when the summary has `ZEBRA-7731`, none of the replaced text, and core accepts the edited
   input. Also dump message shapes locally. If no, B is dropped and A proceeds alone.
2. **S2 headroom (no API).** Loader plus per-case upper bound (prose + code bodies, heredocs apart) against the 25%
   gate. Yes when the per-case table reproduces "Measured headroom".
3. **S3 splitter and `elideBody`** as table tests. Yes when `npx vitest run` exits 0 and protected fields compare equal.
4. **S4 Jev on 5 dev cases.** Yes when every request returns 200 and T0, the histogram and the flip rate are recorded.
5. **S5 variant A** behind `"trim"`. Yes when the suite exits 0 (baseline 134 tests) and the `off` output is unchanged.
6. **S6 variant B** behind `"tidy"`. Yes when a fake-`next` test passes and one live `/compact` completes.
7. **S7 eval**, dev tuning, then one test run. Yes when the arms table, per-tag recall and verdict exist.
8. **S8 default and docs.** Yes when the default matches the verdict and README and `hooks/README.md` say so.

## Acceptance criteria

1. With `proseTrim: "off"`, `compactSession` output equals today's for every existing test; the suite exits 0.
2. Nothing protected changes: user-role text, pinned messages, protected spans, tool names and ids, input keys, and
   non-body input fields (test over all eval cases).
3. No Jev question contains a protected span (offline assertion).
4. Every kept unit appears byte-identical and in order in the trimmed text (test).
5. Only bodies over `truncateHeadChars + 120` in eligible calls are elided. Each keeps a byte-identical head and a note
   naming the tool, field, path and original length. Calls dropped by `decideCall` are untouched by this stage (test).
6. A's gate uses the combined ratio (test: input-only savings can lift a run over 25%).
7. B calls `next` once with the edited messages and tidy instructions (fake `next`); total trim-stage failure leaves
   today's tool-only result (failing fake asker).
8. The eval report lists all six arms, prose- and input-evidence recall, and the verdict; the shipped default matches.

## Risks

Risks: an elided `Edit.old_string` is not on disk any more; B's output is a model summary; the trim stage adds about
1-3 s of Jev latency; one model family writes, answers and judges the eval; redaction is best-effort.

No open questions remain: the revision-2 questions are settled as rulings 13-16.
