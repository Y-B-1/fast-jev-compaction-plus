# Codex compaction port research

Checked 2026-09-30 against Codex **0.159.0**, upstream commit
`687a119f0fcaace47e1f1abcc77cec6c813fd6da`. Refresh this research before changing
the pinned runtime or after a desktop update changes runtime compatibility.

## Native boundary

The remote V2 compactor sends `/responses` a `compaction_trigger` item and
expects a single encrypted compaction response. Its local history replacement
retains user/developer context rather than an arbitrary adapter history.
A proxy that returns selected original history cannot satisfy that contract.

`PreCompact` and `PostCompact` run around native compaction. Stock hooks do
not expose an API that replaces model-visible history. The port adds a narrow
bridge after trusted pre-compaction hooks and before built-in compaction.
It installs checked edits through `Session::replace_compacted_history`, keeping
native history checkpoints and persistent rollout records consistent.

Primary source files at the pinned tag:

- [`core/src/compact_remote_v2.rs`](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/compact_remote_v2.rs)
- [`core/src/session/mod.rs`](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/core/src/session/mod.rs)
- [`hooks/src/engine/discovery.rs`](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/hooks/src/engine/discovery.rs)
- [`app-server-protocol/schema/typescript/v2`](https://github.com/openai/codex/tree/rust-v0.159.0/codex-rs/app-server-protocol/schema/typescript/v2)

## Plugin and activation boundary

[OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins)
provides the native `.codex-plugin/plugin.json` and marketplace formats. An
explicit `hooks` path prevents Claude's hook module from loading as Codex JSON.
Native plugin hook commands receive `PLUGIN_ROOT`. Hook trust uses each
catalog entry's exact key and current hash; the native config writer supports
quoted dotted key paths. Enable `features.hooks` and `features.plugins` before
discovery, because a disabled feature suppresses plugin hook catalog entries.

The installed desktop application's CLI resolver accepts `CODEX_CLI_PATH`.
The current Electron process keeps its environment, so a new value needs a
normal app restart. The app's single-instance lock prevents a second launch
from changing the running process's environment. The port preserves the
signed app and selects a separate runtime for future launches.

## Checked contracts

The adapter emits indexed string edits, never replacement messages or calls.
The runtime rejects edits to prose, structured output, orphan results, recent
items, oversized strings, or results from unfinished custom calls. It checks
all edits before applying any. Provider failure uses built-in compaction;
turn cancellation returns `TurnAborted` and prevents paid fallback.

The installer reuses private OpenRouter credentials, checks the binary SHA256
and exact package version/architecture, uses native plugin/config APIs, and
trusts only the three reviewed lifecycle hooks. Its runtime links to the
signed desktop's helper resources without changing the signed bundle.

## Local build boundary

The release tag declares workspace version `0.159.0`, but its Cargo lockfile
records 158 workspace packages as `0.0.0`. The patch normalizes only those
internal version entries. Third-party versions, sources, and checksums stay
unchanged. The locked ARM64 dependency fetch and Bazel lock metadata check
then pass locally; the Bazel lockfile needs no change.

All final builds and checks run locally. The GitHub Actions workflow was
removed at the user's request. Native config APIs accept a 150,000-token
automatic compaction limit while preserving the selected model. The installer
retains any existing stricter limit.
