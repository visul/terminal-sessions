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
PANE_PID=""
if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  # Pin the lookup to OUR pane ($TMUX_PANE, inherited from the agent process).
  # Without -t, tmux resolves the "current" session — which, while this pane is
  # dying (tmux server shutdown, session kill), is some OTHER still-alive
  # session. That misattributed SessionEnd events shift-by-one across tabs and
  # poisoned per-session resume history. With -t, a dead pane makes tmux error
  # out and we report NO tmux session instead of a wrong one (the tracker
  # drops tmux-less events).
  if [ -n "${TMUX_PANE:-}" ]; then
    PANE_INFO=$(tmux display -t "$TMUX_PANE" -p '#{pane_pid} #{session_name}' 2>/dev/null || echo "")
    PANE_PID=${PANE_INFO%% *}
    TMUX_SESSION=${PANE_INFO#* }
    case "$PANE_PID" in ''|*[!0-9]*) PANE_PID=""; TMUX_SESSION="" ;; esac
  else
    TMUX_SESSION=$(tmux display -p '#{session_name}' 2>/dev/null || echo "")
  fi
fi

STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON=$(cat)
fi

if command -v python3 >/dev/null 2>&1; then
  AGENT="$AGENT" EVENT="$EVENT" TMUX_SESSION="$TMUX_SESSION" PANE_PID="$PANE_PID" \
    HOOK_PID="$$" CWD_FALLBACK="${PWD:-}" \
    python3 -c '
import sys, json, time, os, subprocess
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
# Why a Notification fired, when the hook itself knows. Our OpenCode plugin
# tags every one (permission / question); Claude and agy send none, and the
# tracker falls back to reading the message text for those.
kind = pick(data, "kind")

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

# TMUX_PANE only says which pane the process tree was STARTED from, not that
# this agent is the one working in it. Two cases inherit it wrongly:
#   - an agent another agent delegated to (Claude running codex, agy or grok
#     for a review): its session became the resume head of the pane, so
#     Start reopened a two-message review instead of the conversation.
#   - a detached daemon (the Codex plugin app-server broker) started once from
#     some pane and then serving every session: each later delegation landed
#     on that one pane, whichever session asked for it.
# So walk up from this hook to the pane shell. Not reached means the agent runs
# outside the pane; another agent CLI on the way means it was delegated to.
# Either way the event keeps no tmux session, and the tracker drops it.
AGENT_PROCS = {"claude": "claude", "codex": "codex", "agy": "agy", "grok": "grok",
               "opencode": "opencode", "opencode.exe": "opencode"}

def proc_info(pid):
    # One small ps per level: a full process table (ps -A) costs ~250ms, and
    # this runs on every tool call.
    try:
        line = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=2).stdout.strip()
        ppid, comm = line.split(None, 1)
        return int(ppid), os.path.basename(comm.strip())
    except Exception:
        return None

def pane_attribution(pane_pid, start_pid, me):
    pid = start_pid
    for _ in range(64):
        if pid == pane_pid:
            return ""
        info = proc_info(pid)
        if info is None:
            return ""  # ps failed or raced an exit: attribute as before
        ppid, comm = info
        other = AGENT_PROCS.get(comm)
        if other and other != me:
            return "delegated:" + other
        if ppid <= 1:
            break
        pid = ppid
    return "outside-pane"

try:
    pane_pid = int(os.environ.get("PANE_PID") or 0)
    hook_pid = int(os.environ.get("HOOK_PID") or 0)
except ValueError:
    pane_pid = hook_pid = 0
if out["tmuxSession"] and pane_pid > 1 and hook_pid > 1:
    detached = pane_attribution(pane_pid, hook_pid, out["agent"])
    if detached:
        out["tmuxSession"] = ""
        out["detached"] = detached

# Only present when the hook states it — absent lines keep the old shape.
if kind:
    out["kind"] = str(kind)[:32]

# Only present for teammates/subagents — keep lead-session lines unchanged.
if agent_id:
    out["agentId"] = str(agent_id)
if agent_type:
    out["agentType"] = str(agent_type)

# OpenCode (plugin) reports its own pid so the tracker can notice a TUI that
# quit without a SessionEnd (its plugin worker is killed before dispose runs).
pid = data.get("pid")
if isinstance(pid, int) and pid > 0:
    out["pid"] = pid

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
