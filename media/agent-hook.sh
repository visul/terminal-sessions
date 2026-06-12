#!/bin/bash
# Terminal Sessions — unified AI-agent hook forwarder.
# Installed at: ~/.terminal-sessions/agent-hook.sh
# Usage: agent-hook.sh <agent> <event>
#
# Reads the agent's hook JSON payload from stdin, merges tmux context, and
# appends one normalized JSON line to ~/.terminal-sessions/agent-events.log.
# Serves every hook-based agent (claude, codex, agy) — the <agent> arg
# self-identifies the source, and the python normalizer maps each agent's
# field names onto a common shape.

set -u

AGENT="${1:-unknown}"
EVENT="${2:-unknown}"
LOG="$HOME/.terminal-sessions/agent-events.log"
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
  AGENT="$AGENT" EVENT="$EVENT" TMUX_SESSION="$TMUX_SESSION" CWD_FALLBACK="${PWD:-}" \
    python3 -c '
import sys, json, time, os
raw = sys.stdin.read()
try:
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}

def pick(d, *keys):
    for k in keys:
        v = d.get(k)
        if v:
            return v
    return ""

# Per-agent field normalization. Claude & Codex use Claude-Code-style keys;
# Antigravity (agy) uses conversation_id / agent_state / context_window.
session_id = pick(data, "session_id", "sessionId", "conversation_id", "conversationId")
transcript_path = pick(data, "transcript_path", "transcriptPath")
cwd = pick(data, "cwd", "current_dir") or os.environ.get("CWD_FALLBACK", "")
tool_name = pick(data, "tool_name", "toolName")
message = pick(data, "message")

ti = data.get("tool_input")
if ti is None:
    ti = data.get("toolInput") or {}
tool_input_preview = ""
if isinstance(ti, dict):
    for k in ("command", "file_path", "pattern", "description", "query", "url"):
        if k in ti and ti[k]:
            tool_input_preview = str(ti[k])[:200]
            break
elif isinstance(ti, str):
    tool_input_preview = ti[:200]

out = {
    "agent": os.environ.get("AGENT", "unknown"),
    "event": os.environ.get("EVENT", "unknown"),
    "ts": int(time.time()),
    "sessionId": session_id,
    "tmuxSession": os.environ.get("TMUX_SESSION", ""),
    "cwd": cwd,
    "transcriptPath": transcript_path,
    "toolName": tool_name,
    "toolInput": tool_input_preview,
    "message": str(message)[:300],
}

# Antigravity statusLine payload carries live state + context usage; forward the
# extra fields so the tracker can map agent_state and context %.
st = pick(data, "agent_state", "agentState")
if st:
    out["agentState"] = str(st)
cw = data.get("context_window") or data.get("contextWindow")
if isinstance(cw, dict):
    out["contextWindow"] = cw
mdl = data.get("model")
if isinstance(mdl, dict):
    out["model"] = mdl.get("id") or mdl.get("display_name") or ""
elif isinstance(mdl, str) and mdl:
    out["model"] = mdl

sys.stdout.write(json.dumps(out) + "\n")
' <<<"$STDIN_JSON" >> "$LOG" 2>/dev/null
else
  # Fallback when python3 is missing — minimal payload, no tool/message info.
  {
    printf '{"agent":"%s","event":"%s","ts":%d,"sessionId":"","tmuxSession":"%s","cwd":"%s","transcriptPath":"","toolName":"","toolInput":"","message":""}\n' \
      "$AGENT" "$EVENT" "$(date +%s)" "$TMUX_SESSION" "${PWD:-}"
  } >> "$LOG" 2>/dev/null
fi

exit 0
