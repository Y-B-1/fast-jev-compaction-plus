# Codex installation

Codex requires the patched **0.159.0** runtime included in the GitHub release.
Stock Codex hooks cannot replace model-visible history. The native bridge uses
Codex's history installation methods rather than editing saved transcripts.
Claude Code keeps its existing plugin and hook configuration.

## Install on macOS ARM64

1. Download the plugin and `codex-0.159.0-jev-macos-arm64` runtime from the same
   GitHub release. Extract both archives.
2. Build the adapter in the plugin checkout with Node 22 or newer:
   `npm ci --ignore-scripts && npm run build`.
3. Run `python3 scripts/install-codex.py --runtime-dir /absolute/path/to/runtime`.
   The installer checks the runtime checksum, installs the native plugin,
   enables its three reviewed hooks, and creates `~/.codex/bin/codex-jev`.

The installer reuses an existing OpenRouter credential from Jevgrep without
printing it. Otherwise configure `OPENROUTER_API_KEY` or create
`~/.codex/fast-jev-compaction/credentials.json` with provider `openrouter` and
an `apiKey` value. Keep that file private with mode `0600`.

Use `~/.codex/bin/codex-jev` for CLI sessions. For the desktop app, launch the
app with `CODEX_CLI_PATH` set to that launcher. The existing desktop process
needs a normal exit and relaunch before it can use a different runtime.
The signed application bundle stays unchanged.

## Behavior and checks

`SessionStart`, `PreCompact`, and `PostCompact` are native Codex hooks.
They record events in `~/.codex/fast-jev-compaction/hooks.jsonl`. Actual selective
compaction runs inside the patched runtime after trusted `PreCompact` hooks.
Automatic and manual compaction use the same adapter.

The adapter proposes shorter strings for old completed tool outputs only.
Codex checks every edit before installing the history. Calls, ordinary
messages, images, result metadata, the first item, and the newest six items
stay unchanged. Archived output text remains available in the private data
folder; credential-like text is redacted before archiving or sending to Jev.

The adapter applies edits only when they save at least 25% of serialized
history by default. Missing credentials, provider failures, malformed output,
or insufficient savings use built-in compaction. Cancellation stops the turn
without starting built-in compaction. `last-attempt.json` records proposed
edits; a native compaction event and persisted history prove installation.

`~/.codex/fast-jev-compaction/config.json` accepts the library options plus
`minReductionRatio`. The Codex adapter always preserves calls and at least
six recent items, regardless of library options.

## Runtime maintenance

The patch is `runtime/codex-0.159.0.patch`, based on upstream commit
`687a119f0fcaace47e1f1abcc77cec6c813fd6da`. GitHub Actions checks plugin tests,
formats the native patch, runs focused native compaction tests, and builds
the ARM64 runtime. Updating Codex needs a new checked patch and runtime;
the custom launcher does not silently switch to a stock binary.

To remove the custom runtime, exit the desktop app, remove its custom launch
setting, and launch the signed app normally. Existing sessions remain readable
by stock Codex because the bridge stores native response items.
