// editor/src/resources.ts
// The resource tree. Kept out of extension.ts so the tree's own logic —
// turning parsed RESLIST entries into VS Code TreeItems — stays readable.
// The parsing itself lives in ./reslist, which stays vscode-free so it can
// be unit tested; see that file's header comment for why.
import * as vscode from 'vscode';
import { ResourceEntry } from './reslist';

// Distinct from any real resource state (see src/script/lua/resource.lua:
// "stopped" | "started" | "error" | "missing") so the view/item/context
// "when" clauses in package.json can exclude it with `viewItem !=
// rageScriptManagerTruncated` — the truncation notice is not a resource and must never
// offer Start/Stop/Restart.
export const TRUNCATED_CONTEXT = 'rageScriptManagerTruncated';

export class ResourceItem extends vscode.TreeItem {
    constructor(public readonly entry: ResourceEntry, info?: string) {
        super(entry.name, vscode.TreeItemCollapsibleState.None);
        this.description = info ? `${entry.state} — ${info}` : entry.state;
        this.contextValue = entry.state;
        this.iconPath = new vscode.ThemeIcon(
            entry.state === 'started' ? 'play-circle'
            : entry.state === 'error' ? 'error'
            : 'circle-outline');
    }
}

// Rendered as its own item — visibly a warning, never mistaken for a
// resource — whenever RESLIST reports the listing was truncated. Carries no
// `entry`, which is why lifecycle() in extension.ts narrows with `instanceof
// ResourceItem` before reading one rather than trusting the item it was
// handed to have it. It used to read `item?.entry.name`, which threw a
// TypeError on this class and surfaced to the user through activate()'s
// `wrap` as a bogus "disconnected" message; the `when` clauses in
// package.json were the only thing keeping one from ever arriving.
export class TruncationItem extends vscode.TreeItem {
    constructor() {
        super('Listing incomplete — not all resources are shown', vscode.TreeItemCollapsibleState.None);
        this.contextValue = TRUNCATED_CONTEXT;
        this.tooltip = 'The console could not fit every resource into its reply. Refresh after freeing '
            + 'resources, or check the console output directly for the full list.';
        this.iconPath = new vscode.ThemeIcon('warning');
    }
}

export type ResourceNode = ResourceItem | TruncationItem;

export class ResourceTreeProvider implements vscode.TreeDataProvider<ResourceNode> {
    private emitter = new vscode.EventEmitter<ResourceNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private entries: ResourceEntry[] = [];
    private truncated = false;

    setEntries(entries: ResourceEntry[], truncated = false): void {
        this.entries = entries;
        this.truncated = truncated;
        this.emitter.fire(undefined);
    }

    clear(): void { this.setEntries([], false); }

    getTreeItem(item: ResourceNode): vscode.TreeItem { return item; }

    getChildren(): ResourceNode[] {
        const items: ResourceNode[] = this.entries.map((e) => new ResourceItem(e));
        if (this.truncated) { items.push(new TruncationItem()); }
        return items;
    }
}
