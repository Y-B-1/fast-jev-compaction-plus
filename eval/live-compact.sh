#!/usr/bin/env bash
# Live check of the prose-trim stage in a real Claude Code session.
#   TYPESAFE_API_KEY=... bash eval/live-compact.sh trim|tidy
# Copies the plugin to ~/.claude/fast-jev-eval/live/<v>/ with userConfig.proseTrim.default set
# to <v> (the repo and the hook default stay untouched), then starts claude with only that copy
# in an empty work directory. You run 10+ real turns and /compact, then paste the log line.
# Exits 0 only when the pasted line matches "prose: N scored" with N >= 1 (tidy: also a summary
# and no error toast). The key is read from the environment and never printed.
set -euo pipefail

variant="${1:-}"
case "$variant" in
  trim | tidy) ;;
  *) echo "usage: TYPESAFE_API_KEY=... bash eval/live-compact.sh trim|tidy" >&2; exit 2 ;;
esac
if [ -z "${TYPESAFE_API_KEY:-}" ]; then
  echo "TYPESAFE_API_KEY is not set in the environment" >&2
  exit 2
fi
command -v claude >/dev/null 2>&1 || { echo "claude is not on PATH" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is not on PATH" >&2; exit 2; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$HOME/.claude/fast-jev-eval/live"
copy="$root/$variant"
work="$root/work-$variant"

rm -rf "${copy:?}" "${work:?}"
mkdir -p "$copy" "$work"
for dir in .claude-plugin hooks src types; do
  cp -R "$repo/$dir" "$copy/$dir"
done
VARIANT="$variant" MANIFEST="$copy/.claude-plugin/plugin.json" node -e '
  const fs = require("fs");
  const path = process.env.MANIFEST;
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.userConfig.proseTrim.default = process.env.VARIANT;
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
'

cat <<MSG
Plugin copy: $copy (proseTrim default: $variant)
Work dir:    $work

Claude starts next, with only that plugin. Hold a conversation of 10+ real turns that
reads files and runs commands, then type /compact. Copy the "prose: ..." line from the
compaction toast or log, exit claude, and paste the line when asked.
MSG
read -r -p "Press Enter to start claude. " _

(cd "$work" && claude --setting-sources project,local --plugin-dir "$copy") || true

read -r -p "Paste the log line: " line
if ! printf '%s\n' "$line" | grep -Eq 'prose: [1-9][0-9]* scored'; then
  echo "FAIL: the line has no 'prose: N scored' with N >= 1" >&2
  exit 1
fi
if [ "$variant" = "tidy" ]; then
  read -r -p "Did /compact produce a summary with no error toast? [y/N] " ok
  case "$ok" in
    y | Y) ;;
    *) echo "FAIL: tidy needs a summary and no error toast" >&2; exit 1 ;;
  esac
fi
echo "PASS: $variant"
