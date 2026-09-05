// editor/src/paths.ts
// Pure classification for the extension: which values are safe to act on.
// Split out of extension.ts
// (which imports 'vscode', so it cannot be loaded by a plain Node test) so
// this decision logic can be unit tested without a VS Code host.

// editor/lua-defs/*.lua (natives.def.lua, rageScriptManager.def.lua) are LuaLS type
// definitions for editor IntelliSense only - a ~29,000-line, 6,487-function
// stub file. consolePathFor() in extension.ts maps any open document to
// scripts/<basename> with no regard for where it actually lives, so without
// this guard, pushing while one of these is the active editor would write it
// into /data/<plugin>/scripts/, where the plugin loader globs *.lua and would
// try to run it on every single boot from then on. They must never reach the
// console at all - not written into scripts/, and not run as a one-off
// either - so both pushReload and runFile check this before doing anything.
//
// Takes a plain filename rather than a vscode.TextDocument so this stays
// vscode-free: only doc.fileName is ever needed, and the string is all a
// host-side test can supply.
export function isEditorDefinitionFile(fileName: string): boolean {
    const segments = fileName.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
    for (let i = 0; i + 1 < segments.length; i++) {
        if (segments[i] === 'editor' && segments[i + 1] === 'lua-defs') {
            return true;
        }
    }
    return false;
}

// The console address, checked before it is interpolated into a shell command.
//
// rageScriptManager.host is a SETTING, and a setting can come from .vscode/settings.json
// inside whatever folder happens to be open -- so on someone else's
// repository it is attacker-controlled text. Deploy Plugin builds a command
// line from it and sends it to a terminal, which would run whatever a
// semicolon introduced. Everything the real value can be (an IPv4 address, or
// a hostname) is spelled out here, and anything else is refused rather than
// escaped: there is no shell-quoting to get subtly wrong if the value never
// reaches the shell.
export function isSafeConsoleHost(host: string): boolean {
    if (!host || host.length > 255) { return false; }
    // Dotted-quad, or a hostname of letters, digits, hyphens and dots. No
    // spaces, quotes, semicolons, backticks, $ or newlines -- none of which a
    // console address ever needs.
    // (?![\s\S]) rather than $: in JavaScript, $ without the m flag still
    // matches BEFORE a trailing newline, so /^[a-z]+$/ accepts a host ending in
    // one. That is exactly the character this function exists to keep out of a
    // command line.
    return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(?![\s\S])/.test(host);
}
