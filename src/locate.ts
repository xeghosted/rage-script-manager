// editor/src/locate.ts
// The two directions of one mapping: local file -> console path (for pushing),
// and console chunk name -> console path (for diagnostics). They live together
// because they have to agree on the shape of a console path — a push that
// writes resources/hello/client.lua and a diagnostic that resolves
// hello/client.lua must name the same file, or the squiggle lands on the wrong
// one (or, worse, on a file that only looks similar).
//
// vscode-free on purpose, like paths.ts and reslist.ts: run-tests.js is a plain
// Node runner and cannot load a module that imports 'vscode'.

export interface PushTarget {
    /** Console-relative, always forward slashes: what PUT writes. */
    remote: string;
    /** Set only for a file inside a resource: what RESTART names. */
    resource?: string;
}

function segments(fileName: string): string[] {
    return fileName.split(/[\\/]+/).filter(Boolean);
}

export function pushTargetFor(fileName: string): PushTarget {
    const parts = segments(fileName);
    // The LAST "resources" wins: a workspace can sit under a path that happens
    // to contain the word, and the innermost one is the resource root.
    for (let i = parts.length - 1; i >= 0; i--) {
        // i + 2 < length, so there is a <name> AND at least one path element
        // after it. A file sitting directly in resources/ belongs to no
        // resource and falls through to the scripts/ rule below.
        if (parts[i] === 'resources' && i + 2 < parts.length) {
            const rest = parts.slice(i + 1);
            return { remote: `resources/${rest.join('/')}`, resource: rest[0] };
        }
    }
    return { remote: `scripts/${parts[parts.length - 1] ?? ''}` };
}

export interface ChunkRef {
    /** Console-relative, the same shape pushTargetFor returns. */
    remote: string;
    line: number;
    message: string;
}

// A resource chunk is loaded as "@<resource>/<rel>" (src/script/lua/resource.lua),
// and the '@' tells Lua it is a file, so it reports "hello/client.lua:12: msg".
// A scripts/ file is loaded with a BARE chunk name (src/script/loader.cpp
// passes the filename to runtime_load_buffer with no '@'), which Lua wraps as
// [string "demo.lua"]:3: msg. Those are the only two shapes that name a file
// on this console.
//
// An EXEC buffer produces [string "<the source itself>"], which names nothing —
// and that is why the scripts/ pattern insists the quoted text look like a
// filename. `local f = native(0x1000)` does not, so it matches nothing and no
// diagnostic is invented for a file that merely shares a prefix.
//
// Run Current File is the third producer, and it chooses its own name: the
// file's workspace-relative path, which for resources/ and scripts/ files is
// the console path as well. That is why the quoted half may contain slashes.
//
// A resource name may itself contain a space (R.list splits a listing on the
// LAST space precisely for that reason), so a space has to be legal INSIDE the
// path — but never at the front of it. Without that first-character guard, the
// separator matches the ':' in "client.lua: hello/client.lua:12:" and the path
// captured is " hello/client.lua", which resolves to nothing.
const SCRIPT_ERROR = /\[string "([A-Za-z0-9_.\- /]+\.lua)"\]:(\d+): (.*)/;
const RESOURCE_ERROR = /(?:^|[\s:])([A-Za-z0-9_.\-][A-Za-z0-9_.\- ]*(?:\/[A-Za-z0-9_.\- ]+)+\.lua):(\d+): (.*)/;

// A chunk name reaches us as text over a socket, and the caller joins it onto
// a workspace folder. ".." in it would resolve outside that folder -- the same
// class of hole net::path_guard exists to close on the plugin side. Refused
// rather than normalised, for the same reason: there is no rule to get subtly
// wrong if the value never gets through. No real chunk name contains one; a
// resource name is validated before it can become a directory.
function hasNoDotSegments(p: string): boolean {
    return p.split('/').every((seg) => seg !== '.' && seg !== '..');
}

export function parseChunkError(text: string): ChunkRef | null {
    if (!text) { return null; }
    // Only the first line carries the position the error was RAISED at; the
    // rest is a traceback, whose positions are the frames it passed through.
    const first = text.split('\n', 1)[0];

    const s = SCRIPT_ERROR.exec(first);
    if (s && hasNoDotSegments(s[1])) {
        // Two things produce this shape and they name files differently.
        // loader.cpp loads /data/<plugin>/scripts/*.lua under a BARE filename, so
        // a name with no slash is relative to scripts/. Run Current File names
        // the file relative to the workspace, so a name WITH a slash is already
        // a path -- and prefixing it would point the diagnostic at
        // scripts/<basename>, a different file that may well exist.
        const remote = s[1].includes('/') ? s[1] : `scripts/${s[1]}`;
        return { remote, line: Number(s[2]), message: s[3] };
    }
    const r = RESOURCE_ERROR.exec(first);
    if (r && hasNoDotSegments(r[1])) {
        return { remote: `resources/${r[1]}`, line: Number(r[2]), message: r[3] };
    }
    return null;
}
