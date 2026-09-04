import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TmuxSessionRow } from './types';

const execFileP = promisify(execFile);

export const CONF_PATH = path.join(os.homedir(), '.terminal-sessions', 'tmux.conf');

const CONF_VERSION = 'ts-tmux-conf-v17';

// Writer script the remote clipboard bridge pipes copies to (installed by
// clipboard-bridge.ts). tmux `copy-pipe` feeds it the selection on stdin; it writes
// ~/.terminal-sessions/clipboard.txt, which the extension mirrors to the LOCAL
// clipboard via vscode.env.clipboard. Only referenced by the remote bridge branch of
// clipboardConf(); local confs never mention it.
const CLIP_WRITER = path.join(os.homedir(), '.terminal-sessions', 'ts-clipboard-write.sh');

// Whether to bake CLAUDE_CODE_NO_FLICKER=1 into the generated conf. Default true
// (= historical behavior, no change for existing users). The extension sets this
// from terminalSessions.claudeNoFlicker before writing/regenerating the conf.
let noFlickerEnabled = true;
export function setNoFlicker(enabled: boolean): void { noFlickerEnabled = enabled; }

// Whether the extension host (and therefore the tmux server) runs on a remote
// machine — Remote-SSH / Remote-WSL / Dev Container / Codespaces. Set from
// !!vscode.env.remoteName. When remote, a local clipboard program (pbcopy/xclip)
// would write the REMOTE machine's clipboard (or fail outright on a headless box),
// which never reaches the user's local UI — so tmux copy must go over OSC 52, the
// only remote→local clipboard bridge. See clipboardConf().
let remoteHost = false;
export function setRemoteHost(enabled: boolean): void { remoteHost = enabled; }

/** True if a command is resolvable on PATH (login shell, for GUI-launched apps). */
function hasCmd(cmd: string): boolean {
  try {
    execFileSync('/bin/sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Pick a real clipboard program for this platform. Returns undefined when none
 *  is available (e.g. a headless Linux box) so we can fall back to OSC 52. */
function clipboardCopyCmd(): string | undefined {
  // macOS: pbcopy encodes its stdin per the locale (LANG/LC_CTYPE). When a
  // GUI-launched Cursor/VS Code (Dock/Finder) starts the tmux server it often
  // inherits NO locale, so pbcopy falls back to MacRoman and mangles UTF-8 on
  // paste (Romanian î → Ã®, ș → È™). Forcing LC_CTYPE=UTF-8 on the invocation
  // makes pbcopy treat its input as UTF-8 regardless of the server environment.
  if (process.platform === 'darwin') return 'LC_CTYPE=UTF-8 /usr/bin/pbcopy';
  if (hasCmd('wl-copy')) return 'wl-copy';
  if (hasCmd('xclip')) return 'xclip -selection clipboard -in';
  if (hasCmd('xsel')) return 'xsel --clipboard --input';
  return undefined;
}

/** Clipboard + mouse-drag copy bindings.
 *
 *  Cursor/VS Code mis-decode OSC 52 clipboard payloads as Latin-1, which mangles
 *  non-ASCII text (e.g. Romanian ș → È™, CJK, Cyrillic) when you paste into other
 *  apps — the terminal shows it correctly, but the clipboard bytes are corrupted.
 *  (Cursor forum + anthropics/claude-code#66098/#66269, microsoft/terminal#7819.)
 *
 *  Fix: pipe the selection to a real clipboard program (pbcopy / wl-copy / xclip),
 *  which writes correct UTF-8 straight to the system clipboard, bypassing the
 *  broken OSC 52 path. set-clipboard = external still lets apps INSIDE tmux use
 *  OSC 52 themselves; only tmux's own copy stops using it. Where no clipboard
 *  program exists, we keep the OSC 52 behaviour as a fallback. */
function clipboardConf(): string {
  const cmd = clipboardCopyCmd();
  // A local clipboard program (pbcopy/xclip/wl-copy/xsel) only writes the clipboard
  // of the machine it runs on. Over Remote-SSH/WSL/Container the tmux server runs on
  // the REMOTE, so piping a copy to xclip there either fails (headless box: "Can't
  // open display: (null)") or writes the remote machine's clipboard — never the
  // user's local UI clipboard. OSC 52 is the only remote→local bridge, so when the
  // host is remote we take the bridge branch below even if a clipboard tool happens
  // to be installed on the remote.
  if (remoteHost) {
    // Remote clipboard bridge. The only automatic tmux→local-clipboard channel over
    // SSH is OSC 52, which Cursor's xterm.js mangles (diacritics → mojibake); a remote
    // clipboard tool (xclip) writes the remote box, not your Mac. So every copy is piped
    // to ts-clipboard-write.sh, which writes the selection (correct UTF-8) to
    // ~/.terminal-sessions/clipboard.txt; the extension watches that file and mirrors it
    // to your LOCAL clipboard via vscode.env.clipboard (VS Code forwards a remote-host
    // clipboard write to the local UI, correct UTF-8). set-clipboard off so Claude's
    // inner OSC 52 isn't re-emitted mangled — copy Claude's text via Ctrl+A [ copy-mode.
    const w = CLIP_WRITER;
    return `# ── Clipboard: remote bridge → local clipboard (correct UTF-8, no OSC 52) ──
# tmux copy → ts-clipboard-write.sh → ~/.terminal-sessions/clipboard.txt → the
# extension mirrors it to your LOCAL clipboard via vscode.env.clipboard. This is the
# only remote→local path that keeps diacritics (OSC 52 is mangled by Cursor's xterm.js).
set -g set-clipboard off

# ── Selection: mirrors the local branch so Claude keeps click + drag + scroll ──
# In fullscreen Claude (mouse_any_flag=1) the drag is FORWARDED to Claude, exactly like
# the local branch — so a single click hits Claude's buttons and a trackpad tap (which
# registers as a micro-drag) is NOT swallowed by tmux copy-mode. Copy from Claude is via
# double-click (word) / triple-click (line) → the bridge (correct diacritics), or Ctrl+A [
# then drag for an arbitrary span. In a plain shell the drag lands in tmux copy-mode → bridge.
unbind -T copy-mode    MouseDragEnd1Pane
unbind -T copy-mode-vi MouseDragEnd1Pane
bind-key -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T root         MouseDown1Pane select-pane -t = \\; send-keys -M
bind-key -T root         MouseDrag1Pane if-shell -F "#{mouse_any_flag}" "send-keys -M" "copy-mode -M"
bind-key -T copy-mode    MouseDrag1Pane select-pane \\; send-keys -X begin-selection
bind-key -T copy-mode-vi MouseDrag1Pane select-pane \\; send-keys -X begin-selection

# ── Double-click word / triple-click line → bridge ───────────────────────
bind-key -T root DoubleClick1Pane select-pane -t = \\; copy-mode -H \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T root TripleClick1Pane select-pane -t = \\; copy-mode -H \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode    DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode-vi DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode    TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode-vi TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${w}"

# ── Keyboard copy (vi y, emacs M-w / C-w) → bridge ───────────────────────
bind-key -T copy-mode    M-w send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode    C-w send-keys -X copy-pipe-and-cancel "${w}"
bind-key -T copy-mode-vi y   send-keys -X copy-pipe-and-cancel "${w}"`;
  }
  if (cmd && !remoteHost) {
    // Strip any leading "VAR=val " env prefix (darwin uses LC_CTYPE=UTF-8) and a
    // path so the comment reads the real tool name.
    const tool = cmd.match(/(pbcopy|wl-copy|xclip|xsel)/)?.[1] ?? 'clipboard';
    const utf8Note = tool === 'pbcopy'
      ? '# LC_CTYPE=UTF-8 forces UTF-8 even when a Dock-launched Cursor starts the tmux\n'
        + '# server with no locale (else pbcopy uses MacRoman and mangles î→Ã®, ș→È™).\n'
      : '';
    return `# ── Clipboard: copy via ${tool} (correct UTF-8), not OSC 52 ──────────
# Cursor/VS Code mis-decode OSC 52 as Latin-1 and mangle non-ASCII on paste into
# other apps; piping to ${tool} writes correct UTF-8 straight to the clipboard.
# EVERY copy gesture (drag, double-click word, triple-click line, keyboard) is
# routed through ${tool}; otherwise those gestures fall back to the broken OSC 52
# path and corrupt accented text (e.g. Romanian închide → Ã®nchide).
# 'off' (not 'external'): tmux does NOT re-emit an inner app's (Claude's) OSC 52 to the
# outer terminal, which Cursor's xterm.js double-encodes (the diacritic mojibake). Local
# apps still copy via ${tool} directly. (Reliable correct-diacritics copy from Claude is
# still Cmd+C / Option+drag = Cursor's own copy.) CAVEAT: over SSH, OSC 52 is the only
# clipboard bridge, so a REMOTE session's copy won't reach the local clipboard with 'off'.
${utf8Note}set -g set-clipboard off

# ── Selection: Claude owns the mouse in fullscreen; tmux copy-mode in classic ──
# In fullscreen (NO_FLICKER, mouse_any_flag=1) the drag is FORWARDED to Claude so
# CLAUDE'S OWN selection works — drag-select + copy-on-release + click + native
# scroll, all handled by Claude with correct UTF-8. (This requires the conf to NOT
# set CLAUDE_CODE_DISABLE_MOUSE_CLICKS — that var makes Claude ignore clicks/drags
# and keep only scroll; see flickerConf.) In the classic renderer (mouse_any_flag=0)
# the drag falls back to tmux copy-mode, and on release the selection is piped to
# ${tool} (correct UTF-8) and copy-mode is cancelled so you're back to typing.
unbind -T copy-mode    MouseDragEnd1Pane
unbind -T copy-mode-vi MouseDragEnd1Pane
bind-key -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T root         MouseDown1Pane select-pane -t = \\; send-keys -M
bind-key -T root         MouseDrag1Pane if-shell -F "#{mouse_any_flag}" "send-keys -M" "copy-mode -M"
bind-key -T copy-mode    MouseDrag1Pane select-pane \\; send-keys -X begin-selection
bind-key -T copy-mode-vi MouseDrag1Pane select-pane \\; send-keys -X begin-selection

# ── Double-click word / triple-click line → ${tool} (discrete, tmux-owned) ─
# These two discrete gestures select a word/line and pipe it to ${tool} so it
# pastes clean. (Plain drag is handled by the root MouseDrag binding above.)
bind-key -T root DoubleClick1Pane select-pane -t = \\; copy-mode -H \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T root TripleClick1Pane select-pane -t = \\; copy-mode -H \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode    DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode-vi DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode    TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode-vi TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-pipe-and-cancel "${cmd}"

# ── Keyboard copy (vi y, emacs M-w / C-w) → ${tool} too ───────────────────
bind-key -T copy-mode    M-w send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode    C-w send-keys -X copy-pipe-and-cancel "${cmd}"
bind-key -T copy-mode-vi y   send-keys -X copy-pipe-and-cancel "${cmd}"`;
  }
  // OSC 52 branch — taken when the host is remote (Remote-SSH/WSL/Container) or when
  // no native clipboard tool exists on this machine. Every copy gesture is routed
  // into the tmux buffer with `set-clipboard on`, so tmux emits OSC 52 to the OUTER
  // terminal and the copy lands on the user's LOCAL clipboard — the only mechanism
  // that bridges a remote pane to the local machine. (Cursor's xterm.js may still
  // mangle diacritics on the OSC 52 path, but over SSH there is no alternative and a
  // working copy beats none; local sessions keep the correct-UTF-8 tool branch above.)
  const reason = remoteHost
    ? 'remote tmux server — a local clipboard tool would write the remote box, so\n#   OSC 52 is the only path to your LOCAL clipboard'
    : 'no native clipboard tool (pbcopy/xclip/wl-copy/xsel) found on this machine';
  return `# ── Clipboard: OSC 52 → local clipboard ───────────────────────────────────
# Reason: ${reason}.
set -g set-clipboard on

# ── Selection: Claude owns the mouse in fullscreen; tmux copy-mode in classic ──
# Same gesture set as the local tool branch, but the copy sink is the tmux buffer
# (→ OSC 52) instead of a local clipboard program.
unbind -T copy-mode    MouseDragEnd1Pane
unbind -T copy-mode-vi MouseDragEnd1Pane
bind-key -T copy-mode    MouseDragEnd1Pane send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel
bind-key -T root         MouseDown1Pane select-pane -t = \\; send-keys -M
bind-key -T root         MouseDrag1Pane if-shell -F "#{mouse_any_flag}" "send-keys -M" "copy-mode -M"
bind-key -T copy-mode    MouseDrag1Pane select-pane \\; send-keys -X begin-selection
bind-key -T copy-mode-vi MouseDrag1Pane select-pane \\; send-keys -X begin-selection

# ── Double-click word / triple-click line → OSC 52 (discrete, tmux-owned) ─
bind-key -T root DoubleClick1Pane select-pane -t = \\; copy-mode -H \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-selection-and-cancel
bind-key -T root TripleClick1Pane select-pane -t = \\; copy-mode -H \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-selection-and-cancel
bind-key -T copy-mode    DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi DoubleClick1Pane select-pane \\; send-keys -X select-word \\; run-shell -d 0.3 \\; send-keys -X copy-selection-and-cancel
bind-key -T copy-mode    TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi TripleClick1Pane select-pane \\; send-keys -X select-line \\; run-shell -d 0.3 \\; send-keys -X copy-selection-and-cancel

# ── Keyboard copy (vi y, emacs M-w / C-w) → OSC 52 too ───────────────────
bind-key -T copy-mode    M-w send-keys -X copy-selection-and-cancel
bind-key -T copy-mode    C-w send-keys -X copy-selection-and-cancel
bind-key -T copy-mode-vi y   send-keys -X copy-selection-and-cancel`;
}

/** Claude Code renderer env block. With NO_FLICKER=1, Claude renders in
 *  alt-screen fullscreen and owns the mouse: drag-select + copy-on-release + click
 *  + native wheel-scroll all work inside Claude (correct UTF-8). The drag is
 *  forwarded to Claude by the MouseDrag binding in clipboardConf. With it off
 *  (terminalSessions.claudeNoFlicker = false) Claude uses the classic renderer: the
 *  whole conversation lands in tmux scrollback (selectable), but the wheel drops
 *  into tmux copy-mode instead of scrolling Claude. When off we UNSET the var
 *  (set-environment -gu) so a reload clears it live too.
 *
 *  We deliberately do NOT set CLAUDE_CODE_DISABLE_MOUSE_CLICKS. Despite old advice
 *  that it "routes clicks to tmux while keeping scroll", in practice it makes Claude
 *  ignore ALL mouse clicks/drags (keeping only wheel scroll), which silently breaks
 *  Claude's own fullscreen drag-selection and button clicks. v0.11–v0.20.13 confs set
 *  it, so the block also UNSETS it (and the older DISABLE_MOUSE) on every load: a tmux
 *  server started under an old conf carries the var until restart otherwise. */
function flickerConf(): string {
  const flicker = noFlickerEnabled
    ? 'set-environment -g CLAUDE_CODE_NO_FLICKER 1'
    : '# CLAUDE_CODE_NO_FLICKER off via terminalSessions.claudeNoFlicker — classic\n'
      + '# renderer so the Claude conversation stays in scrollback and is copyable.\n'
      + '# -gu unsets it on the live server when this conf is reloaded.\n'
      + 'set-environment -gu CLAUDE_CODE_NO_FLICKER';
  return `# ── Claude Code rendering (fullscreen, Claude owns the mouse) ─────────────
# NO_FLICKER=1 puts Claude into alt-screen fullscreen mode so tmux scrollback stays
# clean (toggle via terminalSessions.claudeNoFlicker), and Claude handles its own
# mouse: drag-select, copy-on-release, click, and wheel-scroll. set-environment -g
# applies to every new window/pane in this tmux server; shells already running won't
# see the change until restart.
# NOTE: we intentionally do NOT export CLAUDE_CODE_DISABLE_MOUSE_CLICKS — it makes
# Claude ignore mouse clicks/drags (only scroll), which breaks drag-select + clicks.
# Terminal Sessions v0.11–v0.20.13 DID set it right here, and a tmux server started
# under that conf keeps it in its global environment until the server restarts, so
# every load/reload of this file unsets it (v17). Shell-rc exports are handled by the
# extension's startup check / "Fix Claude Code Mouse (drag-select)" command.
set-environment -gu CLAUDE_CODE_DISABLE_MOUSE_CLICKS
set-environment -gu CLAUDE_CODE_DISABLE_MOUSE
${flicker}`;
}

function buildConf(): string {
  return `# Terminal Sessions — tmux config (${CONF_VERSION})
# Location: ~/.terminal-sessions/tmux.conf  (safe to edit; never overwritten on update)
# Edit and run "Terminal Sessions: Reload tmux Config" to apply.
#
# ═══════════════════════════════════════════════════════════════════════════
#  MOUSE / COPY / SCROLL — how it works, and the #1 gotcha (read before editing)
# ═══════════════════════════════════════════════════════════════════════════
# !!  IF DRAG-SELECT OR BUTTON CLICKS STOP WORKING, CHECK THIS FIRST  !!
#   A shell export  CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1  (in ~/.zshrc / ~/.zprofile /
#   ~/.bashrc) makes Claude IGNORE every mouse click/drag and keep ONLY wheel scroll,
#   on EVERY new shell. Symptom: scroll works, but drag-select + button clicks do
#   nothing. It silently overrides this file (per-shell, read at Claude launch). Find:
#     grep -rn DISABLE_MOUSE_CLICKS ~/.zshrc ~/.zprofile ~/.bashrc ~/.profile
#     ps eww -p <claude-pid> | grep -o 'CLAUDE_CODE_DISABLE_MOUSE[^ ]*'
#   Remove the export, start a NEW session (env read at launch), done. (This one line
#   cost a multi-hour debugging marathon on 2026-06-27.)
#
# WHO OWNS THE MOUSE:
#   Fullscreen (NO_FLICKER on) -> CLAUDE owns it: drag-select, copy-on-release, click,
#     and smooth wheel-scroll all happen inside Claude, correct UTF-8 (pbcopy). This
#     file FORWARDS the drag to Claude. Auto-copy: Claude /config -> "Copy on select".
#     RECOMMENDED MODE.
#   Classic (NO_FLICKER off)   -> tmux owns it: conversation in tmux scrollback; drag =
#     tmux copy-mode selection -> pbcopy; wheel = tmux copy-mode scroll.
#   tmux mouse OFF             -> Cursor's own native (blue) selection, but NO wheel
#     scroll, and in fullscreen Claude still grabs the mouse so it will not show.
#
# HARD CONSTRAINT (do not chase the impossible):
#   Cursor's blue selection and wheel-scroll are MUTUALLY EXCLUSIVE in tmux. The thing
#   that gives drag-select + scroll + click together is CLAUDE'S OWN fullscreen selection.
#
# LOAD-BEARING (each re-breaks something if changed):
#   set -g mouse on ............ wheel reaches Claude (scroll)
#   NO_FLICKER on ............. fullscreen, Claude owns the mouse
#   NO DISABLE_MOUSE_CLICKS ... or it breaks select + click (see gotcha)
#   MouseDrag -> send -M when mouse_any_flag .. forwards the drag to Claude in fullscreen
#   set-clipboard external + pbcopy .. correct diacritics; NEVER OSC 52 / set-clipboard on
#     (Cursor mangles non-ASCII on paste).
#   Cursor settings.json: macOptionClickForcesSelection=true -> Option+drag = Cursor's own
#     selection on demand (mangles diacritics; use only on purpose).
#
# USE IT (fullscreen): wheel = scroll; drag = Claude selects + auto-copy on release (or
#   Ctrl+Shift+C); double-click = word, triple = line; clicks work; Ctrl+O then [ dumps
#   the conversation into native scrollback for search/select.
#
# IF IT BREAKS: (a) check the gotcha above; (b) Restart the session (env read at launch);
#   (c) Ctrl+A q -> Reload tmux Config; (d) backups: ~/.terminal-sessions/tmux.conf.bak.*
#
# Researched 2026-06-27 (4-agent web research + live diagnosis). Sources:
#   code.claude.com/docs/en/fullscreen + /env-vars ; xtermjs.org macOptionClickForcesSelection ;
#   github.com/anthropics/claude-code issues 70539 / 70672 ; forum.cursor.com OSC52 UTF-8 thread
# ═══════════════════════════════════════════════════════════════════════════

# ── Inherit user's personal tmux.conf FIRST ───────────────────────────────
# Sourced at the top so the Claude-Code-critical settings below (default-terminal,
# terminal-features, allow-passthrough, env vars) always win. Without this order,
# a personal ~/.tmux.conf with "set -g default-terminal screen-256color" would
# break Claude Code's alt-screen rendering and TUI sync.
if-shell '[ -f ~/.tmux.conf ]' 'source-file ~/.tmux.conf'

# ── Essentials ────────────────────────────────────────────────────────────
set -g mouse on
set -g history-limit 50000
set -sg escape-time 10
set -g focus-events on
set -g exit-empty off

# ── Colors + TUI rendering ────────────────────────────────────────────────
# tmux-256color is the project-recommended value for hosting TUIs (Claude Code,
# vim, lazygit, htop). RGB cap replaces the older Tc cap for truecolor.
set -g default-terminal "tmux-256color"
set -ag terminal-overrides ",xterm-256color:RGB"
# Pass synchronized-output (DECSET 2026) from TUIs through to the outer
# terminal — reduces flicker and scrollback pollution when apps like Claude
# Code emit rapid full-frame redraws. Requires tmux 3.4+.
set -as terminal-features ',xterm*:sync'
# OSC 8 hyperlinks: without this feature flag tmux STRIPS hyperlink escapes, so
# Claude Code's clickable links (FORCE_HYPERLINK=1) never reach Cursor's terminal.
# With it, links stay clickable even when the URL/path wraps across rows.
set -as terminal-features ',xterm*:hyperlinks'
# Let TUI apps (Claude Code, vim) send OSC/clipboard/kitty-graphics sequences
# through tmux without being stripped.
set -g allow-passthrough on
# Modern CSI-u extended-keys encoding (fixes Ctrl+Shift combos in Claude Code).
set -g extended-keys on
set -as terminal-features 'xterm*:extkeys'

${flickerConf()}

${clipboardConf()}

# ── Right-click: let Cursor show its context menu (no double-menu) ────────
unbind -T root MouseDown3Pane
unbind -T root M-MouseDown3Pane

# ── Prefix: Ctrl+A instead of Ctrl+B (screen-style, more ergonomic) ───────
unbind C-b
set -g prefix C-a
bind C-a send-prefix

# ── Tmux menu on prefix + q (Ctrl+A q) ────────────────────────────────────
unbind q
bind q display-menu \\
  -T "#[align=centre]#{pane_index} (#{pane_id})" \\
  -x P -y P \\
  "Copy Mode / Scroll"  c "copy-mode" \\
  "Paste"               p "paste-buffer" \\
  "" \\
  "Horizontal Split"    h "split-window -h" \\
  "Vertical Split"      v "split-window -v" \\
  "" \\
  "Zoom Pane"           z "resize-pane -Z" \\
  "Rename Window"       r "command-prompt -p 'window:' 'rename-window %%%'" \\
  "Kill Pane"           X "kill-pane" \\
  "Respawn Pane"        R "respawn-pane -k" \\
  "" \\
  "Reload tmux Config"  l "source-file ~/.terminal-sessions/tmux.conf"

# ── Wheel scroll: 1 line per tick (smooth on trackpad, OK on mouse) ───────
# WheelUp scrolls back through history. WheelDown scrolls forward AND auto-exits
# copy-mode the moment you reach the bottom — so a stray trackpad scroll-up never
# leaves you stuck in copy-mode: just scroll back down and you're typing again.
bind-key -T copy-mode    WheelUpPane   send-keys -X scroll-up
bind-key -T copy-mode-vi WheelUpPane   send-keys -X scroll-up
bind-key -T copy-mode    WheelDownPane send-keys -X scroll-down \\; if-shell -F "#{e|<=:#{scroll_position},0}" "send-keys -X cancel"
bind-key -T copy-mode-vi WheelDownPane send-keys -X scroll-down \\; if-shell -F "#{e|<=:#{scroll_position},0}" "send-keys -X cancel"

# Easy exits from copy-mode so you're never stuck unable to type:
#   • a single left click drops back to the live prompt (a drag still selects,
#     because that fires MouseDragEnd, not MouseUp)
#   • Enter / q / Esc as usual
bind-key -T copy-mode    MouseUp1Pane send-keys -X cancel
bind-key -T copy-mode-vi MouseUp1Pane send-keys -X cancel
bind-key -T copy-mode    Enter send-keys -X cancel
bind-key -T copy-mode-vi Enter send-keys -X cancel

# ── Appearance: hide tmux status bar (Cursor has its own UI) ──────────────
set -g status off
`;
}

export function ensureConf(): void {
  try {
    fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true });
    if (!fs.existsSync(CONF_PATH)) fs.writeFileSync(CONF_PATH, buildConf());
  } catch { /* best effort */ }
}

/** True if the user's tmux.conf was generated by a pre-v2 release and is
 *  missing the Claude-Code-friendly renderer settings. Returns false if
 *  the user has hand-modified the file beyond the marker. */
export function isConfOutOfDate(): boolean {
  try {
    if (!fs.existsSync(CONF_PATH)) return false;
    const content = fs.readFileSync(CONF_PATH, 'utf8');
    return !content.includes(CONF_VERSION);
  } catch { return false; }
}

/** Back up the current conf and replace it with the new default. Returns the
 *  path of the backup (empty string on failure). */
export function regenerateConf(): string {
  try {
    fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true });
    let backup = '';
    if (fs.existsSync(CONF_PATH)) {
      backup = `${CONF_PATH}.bak.${Date.now()}`;
      fs.copyFileSync(CONF_PATH, backup);
    }
    fs.writeFileSync(CONF_PATH, buildConf());
    return backup;
  } catch { return ''; }
}

export async function reloadConfig(tmuxPath: string): Promise<void> {
  await execFileP(tmuxPath, ['source-file', CONF_PATH]);
}

export async function createDetachedSession(
  tmuxPath: string,
  name: string,
  cwd: string,
): Promise<void> {
  ensureConf();
  await execFileP(tmuxPath, ['-f', CONF_PATH, 'new-session', '-d', '-s', name, '-c', cwd]);
}

/** tmux `-t` targets are PREFIX-matched: `-t ts-…-10` silently resolves to
 *  `ts-…-108` when -10 is gone but -108 is alive — has-session lies, attach
 *  lands in the wrong session, kill would murder a stranger. The `=` prefix
 *  forces an exact-name match (args go through execFile, so no shell ever
 *  sees the `=`). Every session-targeting `-t` below MUST go through this. */
function exact(name: string): string {
  return '=' + name;
}

/** Same, for commands whose `-t` is a target-PANE/WINDOW (display-message,
 *  capture-pane, send-keys). Those need the `sess:` form — a bare `=name` is
 *  silently empty on display-message and a hard "can't find pane" error on
 *  capture-pane (verified on tmux 3.6a). The trailing `:` means "that
 *  session's active window/pane", same as passing the bare name did. */
function exactPane(name: string): string {
  return '=' + name + ':';
}

/** Returns the original cwd the session was created in (tmux preserves this
 *  in #{session_path} for the lifetime of the server). Empty string if the
 *  session is gone. */
export async function getSessionPath(tmuxPath: string, sessionName: string): Promise<string> {
  try {
    const { stdout } = await execFileP(tmuxPath, [
      'display-message', '-p', '-t', exactPane(sessionName), '#{session_path}',
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Returns the current foreground command in the pane (e.g. "zsh", "bash", "node"). */
export async function getPaneCommand(tmuxPath: string, sessionName: string): Promise<string> {
  try {
    const { stdout } = await execFileP(tmuxPath, [
      'display-message', '-p', '-t', exactPane(sessionName), '#{pane_current_command}',
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}

export function isShellCommand(cmd: string): boolean {
  return /^(zsh|bash|sh|fish|nu|xonsh|tcsh|ksh|dash)$/i.test(cmd);
}

const COMMON_PATHS = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/bin/tmux',
];

let _cachedPath: string | undefined;
// When tmux is genuinely absent, remember the miss for a short while so a 5s
// status-bar poll (and the tracker poll) don't spawn a `which tmux` subprocess
// every tick forever on a tmux-less host. Reset by clearTmuxPathCache().
let _missUntil = 0;
const MISS_TTL_MS = 60_000;

export function clearTmuxPathCache(): void { _cachedPath = undefined; _missUntil = 0; }

export async function detectTmuxPath(configured: string): Promise<string | undefined> {
  if (_cachedPath) return _cachedPath;
  if (_missUntil && Date.now() < _missUntil) return undefined;
  if (configured && fs.existsSync(configured)) {
    _cachedPath = configured;
    return configured;
  }
  for (const p of COMMON_PATHS) {
    if (fs.existsSync(p)) { _cachedPath = p; return p; }
  }
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['tmux']);
    const p = stdout.trim();
    if (p && fs.existsSync(p)) { _cachedPath = p; return p; }
  } catch { /* not found */ }
  _missUntil = Date.now() + MISS_TTL_MS;
  return undefined;
}

export async function listSessions(tmux: string, prefix: string): Promise<TmuxSessionRow[]> {
  try {
    const fmt = '#{session_name}|#{session_created}|#{session_last_attached}|#{session_attached}';
    const { stdout } = await execFileP(tmux, ['list-sessions', '-F', fmt]);
    const rows: TmuxSessionRow[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, created, lastAttached, attached] = line.split('|');
      if (!name.startsWith(`${prefix}-`)) continue;
      rows.push({
        name,
        created: parseInt(created, 10) || 0,
        lastAttached: parseInt(lastAttached, 10) || 0,
        attached: (parseInt(attached, 10) || 0) > 0,
      });
    }
    return rows;
  } catch (e: unknown) {
    const err = e as { stderr?: string };
    // "no server running on <socket>" — server exited normally.
    // "error connecting to <socket> (No such file or directory | Connection refused)"
    // — socket file missing or stale. All mean the same thing: zero sessions.
    const stderr = err.stderr || '';
    if (stderr.includes('no server running') || stderr.includes('error connecting to')) return [];
    throw e;
  }
}

export async function hasSession(tmux: string, name: string): Promise<boolean> {
  try {
    await execFileP(tmux, ['has-session', '-t', exact(name)]);
    return true;
  } catch {
    return false;
  }
}

export async function killSession(tmux: string, name: string): Promise<void> {
  await execFileP(tmux, ['kill-session', '-t', exact(name)]).catch(() => { /* already gone */ });
}

export async function capturePane(tmux: string, name: string, lines = 100): Promise<string> {
  try {
    const { stdout } = await execFileP(tmux, ['capture-pane', '-p', '-S', `-${lines}`, '-t', exactPane(name)]);
    return stdout;
  } catch {
    return '(no content — session may have no panes)';
  }
}

export async function renameSession(tmux: string, oldName: string, newName: string): Promise<void> {
  await execFileP(tmux, ['rename-session', '-t', exact(oldName), newName]);
}

/**
 * Exit copy-mode for a session's active pane, if it's in one. When you scroll up
 * to read scrollback the pane enters copy-mode; switching to that terminal later
 * leaves it stuck there (keystrokes are copy-mode commands, not typed into the
 * shell) until you click. Calling this on attach/show makes the terminal ready
 * to type immediately. Best-effort and a no-op when not in a mode.
 */
export async function exitCopyMode(tmux: string, session: string): Promise<void> {
  try {
    // Two argv-safe calls instead of an `if-shell` whose command string re-parses
    // the session name: a name containing whitespace (custom sessionPrefix) would
    // otherwise resolve to the wrong target and inject stray keystrokes.
    const { stdout } = await execFileP(tmux, ['display-message', '-p', '-t', exactPane(session), '#{pane_in_mode}']);
    if (stdout.trim() === '1') {
      await execFileP(tmux, ['send-keys', '-t', exactPane(session), '-X', 'cancel']);
    }
  } catch { /* not in a mode, or no server */ }
}

/** Shell pids of every pane in a session (all windows). Roots for walking the
 *  process tree to find a live agent process and read its launch flags. */
export async function panePids(tmux: string, session: string): Promise<number[]> {
  try {
    const { stdout } = await execFileP(tmux, ['list-panes', '-t', exact(session), '-s', '-F', '#{pane_pid}']);
    return stdout
      .split('\n')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

export function buildAttachOrCreateArgs(name: string, cwd: string): string[] {
  ensureConf();
  return ['-f', CONF_PATH, 'new-session', '-A', '-s', name, '-c', cwd];
}

export function buildAttachArgs(name: string): string[] {
  ensureConf();
  // Exact-match target: without `=`, attaching to a session whose tmux died
  // (ts-…-10) would prefix-match into a LIVE sibling (ts-…-108) and drop the
  // user into the wrong session. Terminal-identity parsers strip the `=` when
  // reading these args back (see sessionNameForTerminal / terminal-tracker).
  return ['-f', CONF_PATH, 'attach-session', '-t', exact(name)];
}
