# Fork Cluster Grouping — Design

**Goal:** Make forked sessions visibly grouped in the sidebar under a collapsible
"fork cluster" header, and make the fork name proposal carry the origin's name so
the relationship is obvious.

**Status:** Approved. Implementing.

## Problem

After forking, a user cannot tell which sessions belong together. The only signal
today is the per-row `⑂` chip color (subtle) plus a chip-only tooltip. The fork's
proposed name (`fork 2`) shares no text with the origin, so they read as unrelated.

## Solution

### 1. Naming
Default fork name proposal becomes `{baseLabel} · fork N` (editable in the input
box). `baseLabel` is derived from the **branch set's origin**, not the immediate
source label, so forking a fork yields `X · fork 3`, never `X · fork 2 · fork 3`.

### 2. Fork inherits the origin's group
At fork time the new session inherits `src.groupId`. Without this, forking a
grouped origin leaves the fork at root and the cluster can never form. With it,
all members of a set always share a container so the cluster is reliable.

### 3. Collapsible fork cluster (virtual container)
A `BranchClusterItem` — computed at render time from `branchSetId`, NOT a persisted
group — collapses ≥2 same-set members into one node:

```
▾ ⑂(repo-forked, colored)  __DPF_Extension_intern · 2 forks
     ✓ __DPF_Extension_intern      idle 1m
     ● __DPF_Extension_intern · fork 2   1m
```

- Icon: `repo-forked` codicon, tinted with the set's `branchColorN` — distinct
  from folder groups (`folder`) and masters (`layers`).
- Header label = `baseLabel`; description = `N forks`.
- Default expanded; VS Code persists user collapse by the stable id `clu:hash:setId`.
- Members inside a cluster drop their redundant `⑂` chip; lone/filtered members
  outside a cluster keep it.
- A set with <2 members present in a container renders as plain rows (no cluster).

### 4. Plumbing (mirrors groups)
- `getParent`: clustered session → cluster; cluster → its group or workspace.
- `noteExpanded` + `collapsedClusterIds`: track collapse for the focus-highlight.
- `isSessionVisible`: a session in a collapsed cluster is not visible.
- `lastClusterItems` cache so `treeView.reveal()` gets the exact instance.

## Limits (v1, conscious)
- Cluster is not drag-reorderable (auto-managed). Dragging a member out visually
  removes it from the cluster (still linked; rejoins on next refresh when back in
  the same container).
- Stopped members render inside the cluster with their grey look (strictly more
  informative than before, when stopped forks showed no ⑂ indicator at all). Under
  a running/stopped filter, filtered-out members drop from the count, so a set with
  only one member visible renders as a plain row instead of a one-item cluster.
- No context menu on the cluster header yet (future: "Unlink all").

## Files
- `src/types.ts` — `BranchSet.baseLabel?`, `SessionInfo.branchBaseLabel?`
- `src/session-manager.ts` — `createBranchSet(hash, name, baseLabel?)`; enrich `branchBaseLabel`
- `src/commands.ts` — naming default + fork inherits `groupId`
- `src/sidebar/items.ts` — `BranchClusterItem`; `SessionTreeItem` `inCluster` param
- `src/sidebar/tree-provider.ts` — `foldRows`/`buildCluster`, integrate in root+group;
  `getParent`, `noteExpanded`, `isSessionVisible`, caches
