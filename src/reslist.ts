// editor/src/reslist.ts
// Parses a RESLIST payload. Split out of resources.ts (which imports
// 'vscode' for the TreeItem/TreeDataProvider layer, so it cannot be loaded
// by a plain Node test) so this decision logic can be unit tested without a
// VS Code host — see extension.test.ts's header comment for why anything
// importing 'vscode' fails under the plain-Node test runner, and ./replies /
// ./paths for the same split applied to extension.ts's own helpers.

export interface ResourceEntry { name: string; state: string; }

export interface ParsedResourceList {
    entries: ResourceEntry[];
    // True when the console's RESOURCE_LIST_TRUNC_MARK line was present in
    // the payload (src/script/resource.h: "-- truncated: listing
    // incomplete --"), meaning resource_list_pack's reply buffer could not
    // hold every resource. `entries` is then a genuine PREFIX of the real
    // list, never an arbitrary subset — but a caller must say so rather than
    // silently presenting it as the whole list.
    truncated: boolean;
}

/**
 * Parse a RESLIST payload: one "name state" per line, splitting each on the
 * LAST space so a resource name may itself contain spaces. A line beginning
 * with "--" is never parsed as an entry — it is the truncation marker
 * (verbatim: "-- truncated: listing incomplete --") appended by
 * resource_list_pack when the listing had to stop early. Treating it as an
 * ordinary line would parse it as a resource literally named
 * "-- truncated: listing incomplete" in state "--": an invented resource
 * displayed exactly where the caller needs a warning that entries are
 * missing.
 */
export function parseResourceList(payload: string): ParsedResourceList {
    const entries: ResourceEntry[] = [];
    let truncated = false;
    for (const line of payload.split('\n')) {
        const t = line.trim();
        if (!t) { continue; }
        if (t.startsWith('--')) { truncated = true; continue; }
        const sp = t.lastIndexOf(' ');
        if (sp <= 0) { continue; }
        entries.push({ name: t.slice(0, sp), state: t.slice(sp + 1) });
    }
    return { entries, truncated };
}
