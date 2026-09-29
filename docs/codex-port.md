# Codex port completion contract

The user requests the same GitHub plugin to run in Claude Code and Codex, with
the local Codex compactor running and its lifecycle hooks enabled.

Claude's function-hook integration stays intact. Codex 0.159 lacks a public
history-replacement hook, so the Codex installation uses a pinned runtime patch.
The patch calls a local adapter during native compaction and installs indexed
tool-output edits through Codex's own history replacement method. It preserves
all calls, prose, structured image output, metadata, and six recent items.

Completion needs:

- Passing plugin tests, build, and both runtime type checks.
- A passing native compaction integration test on the exact runtime patch.
- A published GitHub commit with the Claude plugin, Codex plugin, patch, and installer.
- Installed local runtime and adapter; authenticated Jev pruning on synthetic history.
- Native live-session compaction proof and enabled, trusted lifecycle hooks.
- Honest distinction between current app process and configured next launch.

Build cap: use GitHub Actions for Rust builds because the local host has no Rust
toolchain and only about 8 GiB free. Preserve the installed signed application
and all unrelated active sessions. Do not edit stored rollout files.
