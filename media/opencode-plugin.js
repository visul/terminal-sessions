// terminal-sessions opencode hook
// @terminal-sessions-hook-version 2
// Managed by the Terminal Sessions VS Code extension. Regenerated on hook
// install/upgrade — edits here are overwritten. Uninstall via the extension's
// "Uninstall AI Agent Hooks" command, or delete this file.
//
// What it does: OpenCode has no shell-command hooks, only plugins. This plugin
// runs inside the `opencode` process (the server is a worker thread of the TUI,
// so it inherits the pane's $TMUX_PANE) and does two things:
//   1. forwards lifecycle events to ~/.terminal-sessions/agent-hook.sh in the
//      Claude-Code hook vocabulary (SessionStart, UserPromptSubmit, PreToolUse,
//      PostToolUse, Notification, Stop, SessionEnd) so the extension's tracker
//      sees OpenCode exactly like every other agent;
//   2. appends a per-conversation JSONL transcript under
//      ~/.terminal-sessions/opencode/<session-id>.jsonl (OpenCode keeps its own
//      history in one shared SQLite database, so there is no file to tail).
//
// Design notes (from the plugin ecosystem, see the extension's docs):
//   • `event` is fire-and-forget: handlers race, so file writes go through a
//     per-file queue and the state below is updated synchronously.
//   • Turn end = `session.status` idle AFTER a busy/retry latch for that session;
//     `session.error` suppresses the following idle. `retry` counts as busy.
//   • Only the v1 names reach the plugin bus (`permission.asked`,
//     `question.asked`); `*.asked` keys on `id`, `*.replied` on `requestID`.
//   • `dispose` does not run on TUI quit (the worker is hard-terminated), so
//     SessionEnd is best-effort; the extension checks the pid it gets here.
//   • Child sessions (subagents, `parentID` set) are forwarded with `agent_id`
//     so the extension drops them from pane state, like Claude teammates.

import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOME = os.homedir()
const ROOT = path.join(HOME, ".terminal-sessions")
const FORWARDER = path.join(ROOT, "agent-hook.sh")
const TRANSCRIPT_DIR = path.join(ROOT, "opencode")
const PID = process.pid
const PREVIEW_MAX = 400
const TEXT_MAX = 2000
const OUTPUT_MAX = 4000
const MAX_TRACKED = 500

function clip(value, max) {
  try {
    const text = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value)
    if (!text) return ""
    return text.length > max ? text.slice(0, max) + "…" : text
  } catch {
    return ""
  }
}

/** Short label for a tool's input: the command/path/query inside it. */
function toolInputPreview(args) {
  if (!args || typeof args !== "object") return clip(args, PREVIEW_MAX)
  for (const k of ["command", "filePath", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const v = args[k]
    if (typeof v === "string" && v) return clip(v, PREVIEW_MAX)
  }
  return clip(args, PREVIEW_MAX)
}

function partsText(parts) {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
}

// ───────────── per-file append queue (keeps line order under racing handlers) ─────────────
const pendingLines = new Map()   // file → string[]
const flushing = new Set()
let dirReady = false

function ensureDir() {
  if (dirReady) return
  try { fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true, mode: 0o700 }) } catch {}
  dirReady = true
}

function flush(file) {
  if (flushing.has(file)) return
  const lines = pendingLines.get(file)
  if (!lines || lines.length === 0) return
  pendingLines.set(file, [])
  flushing.add(file)
  ensureDir()
  fs.appendFile(file, lines.join(""), { mode: 0o600 }, () => {
    flushing.delete(file)
    flush(file)
  })
}

function appendLine(file, obj) {
  try {
    const line = JSON.stringify(obj) + "\n"
    const q = pendingLines.get(file)
    if (q) q.push(line)
    else pendingLines.set(file, [line])
    flush(file)
  } catch {}
}

// ───────────── forwarder (JSON on stdin, detached, never awaited) ─────────────
let forwarderOk = null
function forwarderAvailable() {
  if (forwarderOk === null) {
    try { fs.accessSync(FORWARDER, fs.constants.X_OK); forwarderOk = true }
    catch { forwarderOk = false }
  }
  return forwarderOk
}

function emit(event, data) {
  if (!forwarderAvailable()) return
  try {
    const child = spawn("/bin/sh", [FORWARDER, "opencode", event], {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    })
    child.on("error", () => {})
    child.unref()
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: event, pid: PID, ...data }))
  } catch {}
}

export const TerminalSessions = async ({ directory, client }) => {
  // Nothing to attribute outside tmux: the extension only tracks tmux panes.
  if (!process.env.TMUX) return {}

  // ── per-session bookkeeping (bounded) ──
  const parentOf = new Map()      // sessionID → parentID | null
  const dirOf = new Map()         // sessionID → directory
  const titleOf = new Map()       // sessionID → last title written
  const busy = new Set()          // sessions latched busy/retry
  const errored = new Set()       // sessions whose next idle is an error, not a done
  const waiting = new Map()       // request id → sessionID (pending permission/question)
  const roleOf = new Map()        // messageID → role
  const toolStatus = new Map()    // callID → last status written
  const completed = new Set()     // assistant messageIDs already written

  function remember(map, key, value) {
    if (map.size >= MAX_TRACKED) {
      const first = map.keys().next().value
      if (first !== undefined) map.delete(first)
    }
    map.set(key, value)
  }

  function rootOf(id) {
    let cur = id
    for (let i = 0; i < 16; i++) {
      const parent = parentOf.get(cur)
      if (!parent) return cur
      cur = parent
    }
    return cur
  }

  const isChild = (id) => !!parentOf.get(id)
  const transcriptOf = (id) => path.join(TRANSCRIPT_DIR, rootOf(id) + ".jsonl")

  function base(id) {
    const b = {
      session_id: rootOf(id),
      cwd: dirOf.get(rootOf(id)) || directory,
      transcript_path: transcriptOf(id),
    }
    if (isChild(id)) {
      // Tagging with agent_id makes the extension drop the event from pane
      // state (same mechanism as Claude teammates/subagents).
      b.agent_id = id
      b.agent_type = "subagent"
      b.session_id = id
    }
    return b
  }

  function noteSession(info) {
    if (!info || typeof info.id !== "string") return false
    const known = parentOf.has(info.id)
    remember(parentOf, info.id, info.parentID || null)
    if (typeof info.directory === "string") remember(dirOf, info.id, info.directory)
    const title = typeof info.title === "string" ? info.title : ""
    if (!known || titleOf.get(info.id) !== title) {
      remember(titleOf, info.id, title)
      appendLine(transcriptOf(info.id), {
        ts: Date.now(),
        type: "session",
        id: info.id,
        parentID: info.parentID || null,
        directory: info.directory || directory,
        title,
        agent: info.agent || null,
        version: info.version || null,
      })
    }
    return known
  }

  // A session we have never seen (resumed before we loaded, or created while a
  // previous plugin instance ran): ask the server once, fail open as a root.
  const lookups = new Set()
  function ensureKnown(id) {
    if (typeof id !== "string" || parentOf.has(id) || lookups.has(id)) return
    lookups.add(id)
    remember(parentOf, id, null)
    try {
      Promise.resolve(client.session.get({ path: { id } }))
        .then((res) => {
          const info = res && (res.data || res)
          if (info && typeof info === "object" && info.id === id) {
            noteSession(info)
            emit("SessionStart", { ...base(id), title: info.title || null, resumed: true })
          }
        })
        .catch(() => {})
    } catch {}
  }

  emit("SessionStart", { session_id: "", cwd: directory, reason: "plugin_loaded" })

  return {
    dispose: async () => {
      // Best-effort: OpenCode usually terminates the worker before this runs.
      for (const id of parentOf.keys()) {
        if (!isChild(id)) emit("SessionEnd", { ...base(id), reason: "shutdown" })
      }
    },

    event: async ({ event }) => {
      try {
        const p = (event && event.properties) || {}
        switch (event && event.type) {
          case "session.created":
          case "session.updated": {
            const info = p.info
            if (!info) break
            const known = noteSession(info)
            if (!known) emit("SessionStart", { ...base(info.id), title: info.title || null })
            break
          }

          case "session.deleted": {
            const id = p.sessionID || (p.info && p.info.id)
            if (typeof id !== "string") break
            busy.delete(id); errored.delete(id)
            parentOf.delete(id); dirOf.delete(id); titleOf.delete(id)
            break
          }

          case "session.status": {
            const id = p.sessionID
            if (typeof id !== "string") break
            ensureKnown(id)
            const type = p.status && p.status.type
            if (type === "busy" || type === "retry") {   // retry = still working
              busy.add(id)
              break
            }
            if (type !== "idle") break
            if (!busy.delete(id)) break               // idle without a busy first: not a turn end
            const wasError = errored.delete(id)
            appendLine(transcriptOf(id), { ts: Date.now(), type: "turn_end", sessionID: id, error: wasError })
            emit("Stop", { ...base(id), error: wasError })
            break
          }

          case "session.error": {
            const id = p.sessionID
            const err = p.error || {}
            if (typeof id === "string") {
              errored.add(id)
              appendLine(transcriptOf(id), {
                ts: Date.now(), type: "error", sessionID: id,
                name: err.name || null, message: clip(err.data && err.data.message, PREVIEW_MAX) || null,
              })
            }
            break
          }

          case "permission.asked":
          case "question.asked": {
            const id = p.sessionID
            if (typeof id !== "string" || typeof p.id !== "string") break
            if (waiting.has(p.id)) break                  // repeats happen; notify once
            remember(waiting, p.id, id)
            const isQuestion = event.type === "question.asked"
            const q = isQuestion && Array.isArray(p.questions) ? p.questions[0] : null
            const message = isQuestion
              ? "OpenCode asks: " + (clip((q && (q.question || q.header)) || "", PREVIEW_MAX) || "question needs your answer")
              : "OpenCode needs your permission to use " + (p.permission || "a tool")
                + (Array.isArray(p.patterns) && p.patterns.length ? " (" + clip(p.patterns.join(", "), PREVIEW_MAX) + ")" : "")
            emit("Notification", { ...base(id), message, kind: isQuestion ? "question" : "permission" })
            break
          }

          case "permission.replied":
          case "question.replied":
          case "question.rejected": {
            if (typeof p.requestID === "string") waiting.delete(p.requestID)
            break
          }

          case "message.updated": {
            const info = p.info
            if (!info || typeof info.sessionID !== "string") break
            remember(roleOf, info.id, info.role)
            if (info.role !== "assistant") break
            if (!info.time || !info.time.completed || completed.has(info.id)) break
            completed.add(info.id)
            if (completed.size > MAX_TRACKED) completed.delete(completed.values().next().value)
            const t = info.tokens || {}
            const cache = t.cache || {}
            appendLine(transcriptOf(info.sessionID), {
              ts: Date.now(),
              type: "assistant",
              sessionID: info.sessionID,
              messageID: info.id,
              providerID: info.providerID || null,
              modelID: info.modelID || null,
              agent: info.agent || null,
              cost: typeof info.cost === "number" ? info.cost : 0,
              tokens: {
                input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0,
                cacheRead: cache.read || 0, cacheWrite: cache.write || 0, total: t.total || 0,
              },
              finish: info.finish || null,
              error: info.error ? (info.error.name || "error") : null,
              created: info.time.created || null,
              completed: info.time.completed,
            })
            break
          }

          case "message.part.updated": {
            const part = p.part
            if (!part || typeof part.sessionID !== "string") break
            const file = transcriptOf(part.sessionID)
            if (part.type === "tool") {
              const st = part.state || {}
              const key = part.callID || part.id
              if (toolStatus.get(key) === st.status) break
              remember(toolStatus, key, st.status)
              appendLine(file, {
                ts: Date.now(),
                type: "tool",
                sessionID: part.sessionID,
                messageID: part.messageID,
                callID: part.callID || null,
                tool: part.tool || null,
                status: st.status || null,
                input: toolInputPreview(st.input),
                title: clip(st.title, PREVIEW_MAX) || null,
                output: st.status === "completed" ? clip(st.output, OUTPUT_MAX) : undefined,
                error: st.status === "error" ? clip(st.error, PREVIEW_MAX) : undefined,
                start: st.time && st.time.start || null,
                end: st.time && st.time.end || null,
              })
            } else if (part.type === "text" && part.time && part.time.end) {
              // Assistant prose; user text arrives through chat.message below.
              if (roleOf.get(part.messageID) !== "assistant") break
              appendLine(file, {
                ts: Date.now(),
                type: "text",
                sessionID: part.sessionID,
                messageID: part.messageID,
                role: "assistant",
                text: clip(part.text, TEXT_MAX),
              })
            }
            break
          }
        }
      } catch {}
    },

    "chat.message": async (input, output) => {
      try {
        const id = input && input.sessionID
        if (typeof id !== "string") return
        ensureKnown(id)
        const text = clip(partsText(output && output.parts), TEXT_MAX)
        appendLine(transcriptOf(id), {
          ts: Date.now(),
          type: "user",
          sessionID: id,
          messageID: input.messageID || (output && output.message && output.message.id) || null,
          agent: input.agent || null,
          text,
        })
        emit("UserPromptSubmit", { ...base(id), message: clip(text, PREVIEW_MAX) })
      } catch {}
    },

    "tool.execute.before": async (input, output) => {
      try {
        const id = input && input.sessionID
        if (typeof id !== "string") return
        ensureKnown(id)
        // `question.asked` arrives BEFORE this hook for the question tool, and a
        // PreToolUse after a Notification would flip the pane from "waiting on
        // you" back to "running a tool". The question IS the wait; PostToolUse
        // (after the answer) still moves the pane back to working.
        if (input.tool === "question") return
        emit("PreToolUse", {
          ...base(id),
          tool_name: input.tool,
          tool_input: toolInputPreview(output && output.args),
        })
      } catch {}
    },

    "tool.execute.after": async (input, output) => {
      try {
        const id = input && input.sessionID
        if (typeof id !== "string") return
        emit("PostToolUse", {
          ...base(id),
          tool_name: input.tool,
          tool_input: clip(output && output.title, PREVIEW_MAX),
        })
      } catch {}
    },
  }
}

export default TerminalSessions
