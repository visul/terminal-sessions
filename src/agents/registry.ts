import * as vscode from 'vscode';
import { AgentId, AgentProvider } from './types';
import { claudeProvider } from './claude';
import { codexProvider } from './codex/provider';
import { agyProvider } from './agy/provider';
import { grokProvider } from './grok/provider';

// Every provider the extension knows about. Claude is provider #1; Codex,
// Antigravity and Grok follow. Order is the default display order in pickers.
const ALL: AgentProvider[] = [claudeProvider, codexProvider, agyProvider, grokProvider];

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
