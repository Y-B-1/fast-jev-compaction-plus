#!/bin/sh
set -eu
launcher="$HOME/.codex/bin/codex-jev"
test -x "$launcher" || { echo 'Install the Jev runtime before launching Codex.' >&2; exit 1; }
exec /usr/bin/open --env "CODEX_CLI_PATH=$launcher" "${FAST_JEV_DESKTOP_APP:-/Applications/ChatGPT.app}"
