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
# only referenced by the remote branch of the generated tmux.conf. In-place truncate +
# write keeps the file's inode stable so the extension's fs.watch survives each copy.
dir="${HOME}/.terminal-sessions"
mkdir -p "$dir" 2>/dev/null
cat > "$dir/clipboard.txt"
