import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceIndex, WorkspaceEntry, SessionInfo, SessionLabel } from './types';
import * as tmux from './tmux';
import { parseSessionName } from './workspace-id';

export class SessionIndex {
  private indexPath: string;
  private data: WorkspaceIndex;

  constructor() {
    const dir = path.join(os.homedir(), '.terminal-sessions');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    this.indexPath = path.join(dir, 'index.json');
    this.data = this.load();
  }

  private load(): WorkspaceIndex {
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) return parsed;
    } catch { /* fall through */ }
    return { version: 1, workspaces: {} };
  }

  private save(): void {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('[terminal-sessions] failed to save index:', e);
    }
  }

  recordWorkspace(hash: string, wsPath: string, label: string): void {
    const existing = this.data.workspaces[hash];
    this.data.workspaces[hash] = {
      path: wsPath,
      label,
      lastSeen: new Date().toISOString(),
      sessions: existing?.sessions || {},
    };
    this.save();
  }

  recordSession(hash: string, sessionName: string, label?: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    const existing = ws.sessions[sessionName];
    ws.sessions[sessionName] = {
      ...(existing || {}),
      label: label ?? existing?.label,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    this.save();
  }

  setSessionLabel(hash: string, sessionName: string, label: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    ws.sessions[sessionName].label = label;
    this.save();
  }

  setSessionIcon(hash: string, sessionName: string, icon: string | undefined): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (icon) ws.sessions[sessionName].icon = icon;
    else delete ws.sessions[sessionName].icon;
    this.save();
  }

  setSessionColor(hash: string, sessionName: string, color: string | undefined): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (color) ws.sessions[sessionName].color = color;
    else delete ws.sessions[sessionName].color;
    this.save();
  }

  setSessionLastActive(hash: string, sessionName: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    ws.sessions[sessionName].lastActiveAt = new Date().toISOString();
    this.save();
  }

  setSessionMuted(hash: string, sessionName: string, muted: boolean): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (muted) ws.sessions[sessionName].muted = true;
    else delete ws.sessions[sessionName].muted;
    this.save();
  }

  isSessionMuted(hash: string, sessionName: string): boolean {
    return this.data.workspaces[hash]?.sessions[sessionName]?.muted === true;
  }

  setSessionSortOrder(hash: string, sessionName: string, order: number | undefined): void {
    const ws = this.data.workspaces[hash];
    if (!ws?.sessions[sessionName]) return;
    if (order === undefined) delete ws.sessions[sessionName].sortOrder;
    else ws.sessions[sessionName].sortOrder = order;
    this.save();
  }

  clearWorkspaceSortOrder(hash: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    for (const name of Object.keys(ws.sessions)) {
      delete ws.sessions[name].sortOrder;
    }
    this.save();
  }

  removeSession(hash: string, sessionName: string): void {
    const ws = this.data.workspaces[hash];
    if (!ws) return;
    delete ws.sessions[sessionName];
    this.save();
  }

  getWorkspace(hash: string): WorkspaceEntry | undefined {
    return this.data.workspaces[hash];
  }

  getAllWorkspaces(): Record<string, WorkspaceEntry> {
    return this.data.workspaces;
  }

  getSessionLabel(hash: string, sessionName: string): string | undefined {
    return this.data.workspaces[hash]?.sessions[sessionName]?.label;
  }

  getSessionMeta(hash: string, sessionName: string): SessionLabel | undefined {
    return this.data.workspaces[hash]?.sessions[sessionName];
  }

  getNextTabId(hash: string, prefix: string): number {
    const ws = this.data.workspaces[hash];
    if (!ws) return 1;
    let max = 0;
    for (const name of Object.keys(ws.sessions)) {
      const parsed = parseSessionName(name, prefix);
      if (parsed && parsed.tabId > max) max = parsed.tabId;
    }
    return max + 1;
  }
}

export async function enrichSessions(
  tmuxPath: string,
  prefix: string,
  index: SessionIndex,
): Promise<SessionInfo[]> {
  const rows = await tmux.listSessions(tmuxPath, prefix);
  const out: SessionInfo[] = [];
  for (const row of rows) {
    const parsed = parseSessionName(row.name, prefix);
    if (!parsed) continue;
    const ws = index.getWorkspace(parsed.hash);
    const meta = index.getSessionMeta(parsed.hash, row.name);
    out.push({
      name: row.name,
      workspaceHash: parsed.hash,
      workspacePath: ws?.path || '',
      workspaceLabel: ws?.label || `(${parsed.hash})`,
      tabId: parsed.tabId,
      label: meta?.label,
      icon: meta?.icon,
      color: meta?.color,
      createdAt: new Date(row.created * 1000),
      lastAttached: new Date((row.lastAttached || row.created) * 1000),
      lastActiveAt: meta?.lastActiveAt ? new Date(meta.lastActiveAt) : undefined,
      sortOrder: meta?.sortOrder,
      attached: row.attached,
      muted: meta?.muted,
    });
  }
  out.sort((a, b) => {
    if (a.workspaceLabel !== b.workspaceLabel) return a.workspaceLabel.localeCompare(b.workspaceLabel);
    return a.tabId - b.tabId;
  });
  return out;
}

export function groupByWorkspace(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const map = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const arr = map.get(s.workspaceHash) || [];
    arr.push(s);
    map.set(s.workspaceHash, arr);
  }
  return map;
}
