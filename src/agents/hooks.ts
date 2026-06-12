import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Generic install/uninstall for the Claude-Code-style `settings.json` hook
// schema, shared by the Claude and Antigravity (`agy`) providers (Antigravity
// adopted the same shape). Codex uses a different schema (hooks.json /
// config.toml) and implements its own install logic in the codex provider.
//
//   { "hooks": { "<Event>": [ { "hooks": [ { "type": "command",
//                                            "command": "\"<fwd>\" <agent> <Event>" } ] } ] } }

export interface JsonHookSpec {
  settingsPath: string;
  events: readonly string[];
  /** Full shell command to run for a given event. */
  command(event: string): string;
  /** Detect a prior entry of ours (so install replaces rather than duplicates,
   *  and uninstall removes). Matches on the entry's command string. */
  isOurs(command: string): boolean;
}

interface HookEntry { hooks?: Array<{ type?: string; command?: string }> }

function entryIsOurs(entry: unknown, isOurs: (c: string) => boolean): boolean {
  const e = entry as HookEntry;
  return !!e.hooks?.some(h => typeof h.command === 'string' && isOurs(h.command));
}

/** Install our forwarder hook for every event. Idempotent: existing entries of
 *  ours are replaced with fresh ones. Returns true on success. */
export async function installJsonSettingsHook(spec: JsonHookSpec): Promise<boolean> {
  try { fs.mkdirSync(path.dirname(spec.settingsPath), { recursive: true }); } catch { /* noop */ }

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(spec.settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(spec.settingsPath, 'utf8')); }
    catch {
      vscode.window.showErrorMessage(
        `Could not parse ${spec.settingsPath}. Fix it manually then try again.`,
      );
      return false;
    }
  }

  const hooks = (settings.hooks as Record<string, unknown> | undefined) || {};
  settings.hooks = hooks;

  for (const event of spec.events) {
    const existing = (hooks[event] as unknown[]) || [];
    const pruned = existing.filter(e => !entryIsOurs(e, spec.isOurs));
    pruned.push({ hooks: [{ type: 'command', command: spec.command(event) }] });
    hooks[event] = pruned;
  }

  try {
    fs.writeFileSync(spec.settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not write ${spec.settingsPath}: ${String(e).slice(0, 100)}`);
    return false;
  }
}

export async function uninstallJsonSettingsHook(
  settingsPath: string,
  isOurs: (command: string) => boolean,
): Promise<boolean> {
  if (!fs.existsSync(settingsPath)) return true;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return false; }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return true;

  for (const event of Object.keys(hooks)) {
    const arr = (hooks[event] as unknown[]).filter(e => !entryIsOurs(e, isOurs));
    if (arr.length === 0) delete hooks[event];
    else hooks[event] = arr;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function isJsonSettingsHookInstalled(
  settingsPath: string,
  marker: string,
): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    return fs.readFileSync(settingsPath, 'utf8').includes(marker);
  } catch { return false; }
}

/** True when a hook is installed (marker present) but at least one of the
 *  expected events is missing from the file. */
export function needsJsonSettingsHookUpgrade(
  settingsPath: string,
  marker: string,
  events: readonly string[],
): boolean {
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (!raw.includes(marker)) return false;
    for (const event of events) {
      if (!raw.includes(event)) return true;
    }
    return false;
  } catch { return false; }
}
