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
PANE_TTY=""
if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
  # Pin the lookup to OUR pane ($TMUX_PANE, inherited from the agent process).
  # Without -t, tmux resolves the "current" session — which, while this pane is
  # dying (tmux server shutdown, session kill), is some OTHER still-alive
  # session. That misattributed SessionEnd events shift-by-one across tabs and
  # poisoned per-session resume history. With -t, a dead pane makes tmux error
  # out and we report NO tmux session instead of a wrong one (the tracker
  # drops tmux-less events).
  if [ -n "${TMUX_PANE:-}" ]; then
    PANE_INFO=$(tmux display -t "$TMUX_PANE" -p '#{pane_pid} #{pane_tty} #{session_name}' 2>/dev/null || echo "")
    PANE_PID=${PANE_INFO%% *}
    PANE_INFO=${PANE_INFO#* }
    PANE_TTY=${PANE_INFO%% *}
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
    PANE_TTY="$PANE_TTY" HOOK_PID="$$" CWD_FALLBACK="${PWD:-}" \
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
# So walk up from this hook to the pane shell, the pane process included. The
# first agent CLI on the way is the one that fired the hook. Any agent above
# it means delegation, the same CLI too (claude -p run from a Claude shell),
# except a direct parent of the same name, which is its launcher (an npm shim
# starting the native binary). Not reaching the pane means the agent runs
# outside it. Either way the event keeps no tmux session; the tracker drops it.
AGENT_PROCS = {"claude": "claude", "codex": "codex", "agy": "agy", "grok": "grok",
               "opencode": "opencode", "opencode.exe": "opencode"}
INTERPRETERS = ("node", "bun", "deno", "python", "python3")
AGENT_PACKAGES = {"@anthropic-ai/claude-code": "claude", "@openai/codex": "codex"}

def run_ps(*args):
    # -ww: never cut a line to the terminal width a narrow pane passes down.
    return subprocess.run(["ps", "-ww"] + list(args),
                          capture_output=True, text=True, timeout=2).stdout.strip()

# This runs on every tool call, and a full process table (ps -A) costs ~250ms.
# One ps of the pane terminal covers the pane side of the walk; the few levels
# off it (the hook itself, an agent shell tool that dropped the terminal) cost
# one small ps each.
PANE_PROCS = {}
def load_pane_procs(tty):
    if not tty:
        return
    try:
        for line in run_ps("-t", tty.replace("/dev/", "", 1), "-o", "pid=,ppid=,comm=").splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3:
                PANE_PROCS[int(parts[0])] = (int(parts[1]), parts[2].strip())
    except Exception:
        PANE_PROCS.clear()

def proc_info(pid):
    if pid in PANE_PROCS:
        return PANE_PROCS[pid]
    ppid, comm = run_ps("-o", "ppid=,comm=", "-p", str(pid)).split(None, 1)
    return int(ppid), comm.strip()

def agent_of(pid, comm):
    # macOS prints "(claude)" when it cannot read the arguments of a process.
    if comm.startswith("(") and comm.endswith(")"):
        comm = comm[1:-1]
    name = os.path.basename(comm)
    if name in AGENT_PROCS:
        return AGENT_PROCS[name]
    if not name.startswith(INTERPRETERS):
        return ""
    # An agent installed through npm runs as node: its name is in the script.
    try:
        args = run_ps("-o", "command=", "-p", str(pid)).split()[1:4]
    except Exception:
        return ""
    for arg in args:
        if arg.startswith("-"):
            continue
        base = os.path.basename(arg)
        if base in AGENT_PROCS:
            return AGENT_PROCS[base]
        for pkg, agent in AGENT_PACKAGES.items():
            if pkg in arg:
                return agent
        break
    return ""

def pane_attribution(pane_pid, start_pid, me):
    pid, owner, prev = start_pid, "", ""
    for _ in range(64):
        try:
            ppid, comm = proc_info(pid)
        except Exception:
            return ""  # ps failed or raced an exit: attribute as before
        agent = agent_of(pid, comm)
        if agent:
            if not owner:
                if agent != me:
                    return "delegated:" + agent
                owner = agent
            elif agent != prev:
                return "delegated:" + agent
        prev = agent
        if pid == pane_pid:
            return ""
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
    load_pane_procs(os.environ.get("PANE_TTY", ""))
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

# A name given with Rename... waits in pending-titles/<sessionId> for the
# running Claude: hand it over as sessionTitle on the next prompt (that renames
# the live session, prompt box label included), then drop the file. The only
# output this hook ever prints, and only when such a file exists.
PENDING="$HOME/.terminal-sessions/pending-titles"
if [ "$AGENT" = "claude" ] && [ "$EVENT" = "UserPromptSubmit" ] && [ -d "$PENDING" ] \
  && [ -n "$(ls -A "$PENDING" 2>/dev/null)" ] && command -v python3 >/dev/null 2>&1; then
  PENDING="$PENDING" python3 -c '
import sys, json, os, re
try:
    sid = json.loads(sys.stdin.read() or "{}").get("session_id") or ""
except Exception:
    sid = ""
if isinstance(sid, str) and re.fullmatch(r"[A-Za-z0-9-]+", sid):
    p = os.path.join(os.environ["PENDING"], sid)
    try:
        with open(p, encoding="utf-8") as f:
            title = f.read().strip()
        os.remove(p)
    except OSError:
        title = ""
    if title:
        sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "sessionTitle": title}}))
' <<<"$STDIN_JSON" 2>/dev/null
fi

exit 0
