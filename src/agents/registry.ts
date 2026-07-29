import * as vscode from 'vscode';
import { AgentId, AgentProvider, YoloSpec } from './types';
import { isYolo, matchedYoloFlags } from './launch-flags';
import { claudeProvider } from './claude';
import { codexProvider } from './codex/provider';
import { agyProvider } from './agy/provider';
import { grokProvider } from './grok/provider';

// Every provider the extension knows about. Claude is provider #1; Codex,
// Antigravity and Grok follow. Order is the default display order in pickers.
const ALL: AgentProvider[] = [claudeProvider, codexProvider, agyProvider, grokProvider];

const FORKABLE_AGENTS: ReadonlySet<AgentId> = new Set(
  ALL.filter(p => p.supportsFork).map(p => p.id),
);

/** Whether an agent can fork a conversation into a new id (drives the Fork
 *  command's `forkable` contextValue gate). Decoupled from any registry
 *  instance so enrichment can call it without a live registry. */
export function isForkableAgent(id: AgentId | undefined): boolean {
  return !!id && FORKABLE_AGENTS.has(id);
}

const YOLO_SPECS: ReadonlyMap<AgentId, YoloSpec> = new Map(
  ALL.filter(p => p.yolo).map(p => [p.id, p.yolo as YoloSpec]),
);

/** The agent's YOLO definition, or undefined when it has no auto-approve mode
 *  we know how to drive. Decoupled from any registry instance so enrichment can
 *  call it without one (mirrors `isForkableAgent`). */
export function yoloSpecFor(id: AgentId | undefined): YoloSpec | undefined {
  return id ? YOLO_SPECS.get(id) : undefined;
}

/** Whether a session's captured launch flags put it in YOLO mode. Drives the
 *  🚨 chip and the `yolo` contextValue token. */
export function isYoloSession(id: AgentId | undefined, flags: readonly string[]): boolean {
  return isYolo(flags, yoloSpecFor(id));
}

/** The captured flags responsible for a session's YOLO state, for the tooltip. */
export function yoloFlagsFor(id: AgentId | undefined, flags: readonly string[]): string[] {
  return matchedYoloFlags(flags, yoloSpecFor(id));
}

export class AgentRegistry {
  private byId = new Map<AgentId, AgentProvider>();

  constructor() {
    for (const p of ALL) this.byId.set(p.id, p);
  }

  getProvider(id: AgentId | string | undefined): AgentProvider | undefined {
    if (!id) return undefined;
    return this.byId.get(id as AgentId);
  }

  /** Provider for an event's agent, defaulting to Claude for legacy log lines
   *  that predate the `agent` field. */
  providerForAgent(agent: string | undefined): AgentProvider {
    return this.byId.get((agent as AgentId) || 'claude') || claudeProvider;
  }

  all(): AgentProvider[] {
    return [...this.byId.values()];
  }

  /** Providers the user has enabled. Explicit `terminalSessions.enabledAgents`
   *  wins; otherwise Claude is always on and the others turn on when their CLI
   *  is detected on PATH. */
  enabled(): AgentProvider[] {
    const cfg = vscode.workspace.getConfiguration('terminalSessions');
    const raw = cfg.get<string[]>('enabledAgents', []);
    if (raw && raw.length > 0) {
      return this.all().filter(p => raw.includes(p.id));
    }
    return this.all().filter(p => p.id === 'claude' || p.isInstalled());
  }
}
