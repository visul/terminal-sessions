#!/bin/bash
# Terminal Sessions — Claude Code hook forwarder (v3)
# Installed at: ~/.terminal-sessions/claude-hook.sh
# Reads the Claude Code hook JSON payload from stdin (session_id,
# transcript_path, tool_name, tool_input, message, cwd), merges it with tmux
# context, and appends one JSON line to ~/.terminal-sessions/claude-events.log.
#
# v3 adds `message` capture so the extension can distinguish a "permission
# needed" Notification (urgent, blocks Claude) from a "waiting for your input"
# idle nudge (Claude Code fires this ~60s after each Stop while sitting at the
# prompt — not urgent, must not flip the sidebar to ⚠ waiting).

set -u

EVENT="${1:-unknown}"
LOG="$HOME/.terminal-sessions/claude-events.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

TMUX_SESSION=""
if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  TMUX_SESSION=$(tmux display -p '#{session_name}' 2>/dev/null || echo "")
fi

STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON=$(cat)
fi

if command -v python3 >/dev/null 2>&1; then
  EVENT="$EVENT" TMUX_SESSION="$TMUX_SESSION" CWD_FALLBACK="${PWD:-}" \
    python3 -c '
import sys, json, time, os
raw = sys.stdin.read()
try:
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}
ti = data.get("tool_input") or {}
tool_input_preview = ""
if isinstance(ti, dict):
    for k in ("command", "file_path", "pattern", "description", "query", "url"):
        if k in ti and ti[k]:
            tool_input_preview = str(ti[k])[:200]
            break
out = {
    "event": os.environ.get("EVENT", "unknown"),
    "ts": int(time.time()),
    "sessionId": data.get("session_id", ""),
    "tmuxSession": os.environ.get("TMUX_SESSION", ""),
    "cwd": data.get("cwd", "") or os.environ.get("CWD_FALLBACK", ""),
    "transcriptPath": data.get("transcript_path", ""),
    "toolName": data.get("tool_name", ""),
    "toolInput": tool_input_preview,
    "message": str(data.get("message", ""))[:300],
}
sys.stdout.write(json.dumps(out) + "\n")
' <<<"$STDIN_JSON" >> "$LOG" 2>/dev/null
else
  # Fallback when python3 is missing — minimal payload, no tool/message info.
  {
    printf '{"event":"%s","ts":%d,"sessionId":"","tmuxSession":"%s","cwd":"%s","transcriptPath":"","toolName":"","toolInput":"","message":""}\n' \
      "$EVENT" "$(date +%s)" "$TMUX_SESSION" "${PWD:-}"
  } >> "$LOG" 2>/dev/null
fi

exit 0
