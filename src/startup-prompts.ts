// One queue for the prompts the extension may show at startup (install hooks,
// update tmux.conf, make `+` persistent, …). They used to fire on fixed timers,
// 4s / 6s / 8s / 12s after activation, so a slow answer to one had the next land
// on top of it, and two shared a slot. Here each waits for the previous to be
// answered, and none runs before the restore offer, which is time-sensitive
// and goes first on its own.

import * as vscode from 'vscode';

type Prompt = () => Promise<void>;

let chain: Promise<void> = Promise.resolve();
let release: () => void = () => undefined;
const gate = new Promise<void>(r => { release = r; });
let disposed = false;
let registered = false;

/** Queue a prompt. It runs after the ones queued before it, after
 *  `openPromptQueue()`, and not at all once the extension is disposed. A
 *  prompt that finds nothing to ask just returns, so gating stays inside each
 *  prompt. */
export function queuePrompt(ctx: vscode.ExtensionContext, prompt: Prompt): void {
  if (!registered) {
    registered = true;
    ctx.subscriptions.push({ dispose: () => { disposed = true; } });
  }
  chain = chain
    .then(() => gate)
    .then(() => (disposed ? undefined : prompt()))
    .catch(e => console.error('[terminal-sessions] startup prompt failed:', e));
}

/** Let the queued prompts start: called once the restore pipeline is done. */
export function openPromptQueue(): void {
  release();
}
