import * as vscode from 'vscode';
import { SessionIndex, enrichSessions, groupByWorkspace } from '../session-manager';
import * as tmux from '../tmux';
import { getConfig, VIEW_ID } from '../config';
import { WorkspaceTreeItem, SessionTreeItem } from './items';

class SessionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  constructor(private index: SessionIndex) {}

  refresh(): void { this._onDidChange.fire(undefined); }

  getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

  async getChildren(el?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const cfg = getConfig();
    const tmuxPath = await tmux.detectTmuxPath(cfg.tmuxPath);
    if (!tmuxPath) {
      const item = new vscode.TreeItem('tmux not installed — run: brew install tmux',
        vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('alert');
      return [item];
    }
    const sessions = await enrichSessions(tmuxPath, cfg.sessionPrefix, this.index);
    if (!el) {
      if (sessions.length === 0) {
        const item = new vscode.TreeItem('No persistent sessions yet.',
          vscode.TreeItemCollapsibleState.None);
        item.description = 'Click + to create one';
        return [item];
      }
      const grouped = groupByWorkspace(sessions);
      const out: vscode.TreeItem[] = [];
      for (const [hash, group] of grouped) {
        const wsPath = group[0].workspacePath;
        out.push(new WorkspaceTreeItem(group[0].workspaceLabel, hash, group, wsPath));
      }
      return out;
    }
    if (el instanceof WorkspaceTreeItem) {
      return el.sessions.map(s => new SessionTreeItem(s));
    }
    return [];
  }
}

let provider: SessionsTreeProvider | undefined;

export function registerSidebar(
  ctx: vscode.ExtensionContext,
  index: SessionIndex,
): void {
  provider = new SessionsTreeProvider(index);
  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  ctx.subscriptions.push(treeView);
  const interval = setInterval(() => provider?.refresh(), 10_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export function refreshSidebar(): void { provider?.refresh(); }
