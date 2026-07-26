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
  # Pin the lookup to OUR pane ($TMUX_PANE, inherited from the agent process).
  # Without -t, tmux resolves the "current" session — which, while this pane is
  # dying (tmux server shutdown, session kill), is some OTHER still-alive
  # session. That misattributed SessionEnd events shift-by-one across tabs and
  # poisoned per-session resume history. With -t, a dead pane makes tmux error
  # out and we report NO tmux session instead of a wrong one (the tracker
  # drops tmux-less events).
  if [ -n "${TMUX_PANE:-}" ]; then
    TMUX_SESSION=$(tmux display -t "$TMUX_PANE" -p '#{session_name}' 2>/dev/null || echo "")
  else
    TMUX_SESSION=$(tmux display -p '#{session_name}' 2>/dev/null || echo "")
  fi
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

# Agent-team teammates and Task-tool subagents carry agent_id / agent_type on
# their hook payloads; the main (lead) session never does. Forwarding agent_id
# lets the tracker drop teammate/subagent events so they do not fire "done"
# notifications or hijack the tracked state of the lead session. (No apostrophes
# in this block — the whole program is inside a single-quoted python3 -c string.)
agent_id = pick(data, "agent_id", "agentId")
agent_type = pick(data, "agent_type", "agentType")

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

# Only present for teammates/subagents — keep lead-session lines unchanged.
if agent_id:
    out["agentId"] = str(agent_id)
if agent_type:
    out["agentType"] = str(agent_type)

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
  # Escape each interpolated value for a JSON string context (backslash FIRST, then
  # double quote) so a cwd or tmux session name containing " or \ still emits valid
  # JSON — otherwise the tracker silently drops the event on such hosts.
  esc_agent=${AGENT//\\/\\\\}; esc_agent=${esc_agent//\"/\\\"}
  esc_event=${EVENT//\\/\\\\}; esc_event=${esc_event//\"/\\\"}
  esc_tmux=${TMUX_SESSION//\\/\\\\}; esc_tmux=${esc_tmux//\"/\\\"}
  esc_cwd=${PWD:-}; esc_cwd=${esc_cwd//\\/\\\\}; esc_cwd=${esc_cwd//\"/\\\"}
  {
    printf '{"agent":"%s","event":"%s","ts":%d,"sessionId":"","tmuxSession":"%s","cwd":"%s","transcriptPath":"","toolName":"","toolInput":"","message":""}\n' \
      "$esc_agent" "$esc_event" "$(date +%s)" "$esc_tmux" "$esc_cwd"
  } >> "$LOG" 2>/dev/null
fi

exit 0
