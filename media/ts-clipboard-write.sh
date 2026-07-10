#!/bin/sh
# Terminal Sessions — remote clipboard bridge writer.
#
# tmux `copy-pipe` feeds the current selection on stdin (correct UTF-8). We write it to
# ~/.terminal-sessions/clipboard.txt; the Terminal Sessions extension (running on this
# remote host) watches that file and mirrors it to the user's LOCAL clipboard via
# vscode.env.clipboard.writeText(), which VS Code/Cursor forwards to the local UI as
# correct UTF-8 — bypassing the OSC 52 path that Cursor mangles over SSH.
#
# Installed to ~/.terminal-sessions/ts-clipboard-write.sh by clipboard-bridge.ts, and
# only referenced by the remote branch of the generated tmux.conf. The extension's
# fs.watch is bound to clipboard.txt's inode, so we overwrite the file IN PLACE — never
# rename a temp over it, which would swap the inode and silence the watcher on Linux
# remotes. To avoid mirroring a half-written paste, we buffer stdin to a temp file first
# and fill clipboard.txt from it in one fast local copy: a slow Remote-SSH pipe streamed
# straight into the watched file could still be mid-write when fs.watch fires, but a
# local temp copy finishes well within the watcher's debounce. flock (when present)
# serializes concurrent copies so two rapid selections can't interleave.
dir="${HOME}/.terminal-sessions"
mkdir -p "$dir" 2>/dev/null
dst="$dir/clipboard.txt"
tmp="$dir/.clipboard.$$.tmp"
cat > "$tmp"
if command -v flock >/dev/null 2>&1; then
  { flock 9; cat "$tmp" > "$dst"; } 9>"$dir/.clipboard.lock"
else
  cat "$tmp" > "$dst"
fi
rm -f "$tmp"
