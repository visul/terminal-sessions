import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

export function hashPath(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 8);
}

export interface CurrentWorkspace {
  path: string;
  hash: string;
  label: string;
}

export function currentWorkspace(): CurrentWorkspace | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const first = folders[0];
  const p = first.uri.fsPath;
  return {
    path: p,
    hash: hashPath(p),
    label: first.name || path.basename(p),
  };
}

export function sessionName(prefix: string, hash: string, tabId: number): string {
  return `${prefix}-${hash}-${tabId}`;
}

export function parseSessionName(name: string, prefix: string): { hash: string; tabId: number } | undefined {
  const re = new RegExp(`^${prefix}-([0-9a-f]{6,16})-(\\d+)$`);
  const m = name.match(re);
  if (!m) return undefined;
  return { hash: m[1], tabId: parseInt(m[2], 10) };
}
