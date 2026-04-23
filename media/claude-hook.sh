#!/bin/bash
# Terminal Sessions — Claude Code hook forwarder
# Installed at: ~/.terminal-sessions/claude-hook.sh
# Appends one JSON line per Claude event to ~/.terminal-sessions/claude-events.log
# The extension watches that log and reacts (maps tmux↔session, notifies).

set -u
EVENT="${1:-unknown}"
LOG="$HOME/.terminal-sessions/claude-events.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

TMUX_SESSION=""
if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  TMUX_SESSION=$(tmux display -p '#{session_name}' 2>/dev/null || echo "")
fi

# Python-backed JSON escape; falls back to sed if python3 missing.
esc() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "${1:-}" | python3 -c 'import sys,json; sys.stdout.write(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null
  else
    printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g'
  fi
}

{
  printf '{"event":"%s","ts":%d,"sessionId":"%s","tmuxSession":"%s","cwd":"%s"}\n' \
    "$(esc "$EVENT")" \
    "$(date +%s)" \
    "$(esc "${CLAUDE_SESSION_ID:-}")" \
    "$(esc "$TMUX_SESSION")" \
    "$(esc "${PWD:-}")"
} >> "$LOG" 2>/dev/null

exit 0
