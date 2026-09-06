// editor/src/scaffold.ts
// What "New Resource" writes. vscode-free so the content is testable; the
// command in extension.ts does the asking, the collision check and the writing.
//
// The scaffold is deliberately a WORKING resource rather than an empty shell:
// it starts, it prints, and it answers a command, so the first push proves the
// whole loop end to end. Every directive it emits is one src/script/lua/
// manifest.lua actually accepts -- a scaffold that starts with a warning
// teaches the wrong thing on day one.

/**
 * The reason a name is unacceptable, or undefined when it is fine.
 * Shaped for vscode.InputBoxOptions.validateInput, which reads a string as the
 * error message and undefined as "accepted".
 */
export function validateResourceName(name: string): string | undefined {
    if (!name) { return 'a resource needs a name'; }
    // The wire caps a resource name at net::RESOURCE_NAME_MAX = 127 BYTES --
    // measured on the console, where 127 loaded and 128 came back as "resource
    // name too long". Checking here turns a round trip into an inline message.
    if (Buffer.byteLength(name, 'utf8') > 127) { return 'at most 127 bytes'; }
    // The name becomes a directory under /data/<plugin>/resources, so anything
    // that could climb out of it is refused here rather than by path_guard
    // three layers later, where the message would say nothing useful.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        return 'letters, digits, underscore and hyphen only';
    }
    return undefined;
}

/**
 * The directives an fxmanifest may use, exactly as src/script/lua/manifest.lua
 * accepts them.
 *
 * They are not Lua globals -- the plugin evaluates a manifest in a sandbox
 * where each one is a function on the environment -- so without this the
 * language server flags every line of a manifest it just scaffolded, which
 * reads as the scaffold being wrong.
 *
 * Listed in the generated .luarc.json rather than shipped as a `---@meta`
 * definitions file on purpose: a meta file defines globals across the whole
 * workspace, and `name` or `version` undefined inside an ordinary script is a
 * real mistake worth keeping.
 */
export const MANIFEST_DIRECTIVES = [
    'author', 'client_script', 'client_scripts', 'dependencies', 'dependency',
    'description', 'fx_version', 'game', 'games', 'name', 'script', 'scripts',
    'server_script', 'server_scripts', 'shared_script', 'shared_scripts', 'version',
];

export interface ScaffoldFile {
    /** Workspace-relative, forward slashes, in creation order. */
    path: string;
    body: string;
}

/**
 * The `game` directive for a manifest, from the control-channel port.
 *
 * Both plugins parse `game` and then ignore it, so nothing breaks if this is
 * wrong -- which is exactly why it would stay wrong. A scaffold that writes
 * `game 'gta5'` into a Red Dead resource is a small lie that the reader has no
 * reason to doubt, so derive it instead of hardcoding one game.
 */
export function gameForPort(port: number): string {
    return port === 9616 ? 'rdr3' : 'gta5';
}

export function scaffoldFiles(name: string, game: string = 'gta5'): ScaffoldFile[] {
    const dir = `resources/${name}`;
    return [
        {
            path: `${dir}/fxmanifest.lua`,
            body: [
                "fx_version 'cerulean'",
                `game '${game}'`,
                '',
                `name '${name}'`,
                "description ''",
                "version '0.1.0'",
                '',
                "client_script 'client.lua'",
                '',
            ].join('\n'),
        },
        {
            path: `${dir}/client.lua`,
            body: [
                `-- ${name}: runs on the game thread, one tick per frame.`,
                '',
                'CreateThread(function()',
                '    while true do',
                '        -- Wait yields to the scheduler. A loop without one never',
                '        -- gives the frame back and the runaway budget kills it.',
                '        Wait(1000)',
                '    end',
                'end)',
                '',
                "AddEventHandler('onResourceStart', function(resource)",
                '    if resource == GetCurrentResourceName() then',
                `        print('${name} started')`,
                '    end',
                'end)',
                '',
                `RegisterCommand('${name}', function()`,
                '    local ped = GET_PLAYER_PED(-1)',
                '    local c = GET_ENTITY_COORDS(ped, true)',
                `    print(string.format('${name}: %.1f, %.1f, %.1f', c[1], c[2], c[3]))`,
                'end)',
                '',
            ].join('\n'),
        },
        {
            path: `${dir}/.luarc.json`,
            // Relative to the resource directory, which sits two levels under
            // the workspace root. Without it the native completions do not
            // reach a freshly made resource, and it reads as autocomplete
            // being broken rather than as a missing config.
            //
            // The GAME is part of the path. It did not used to be, and when the
            // plugin split its definitions per game that path stopped existing,
            // so every scaffolded resource pointed at nothing -- silently, which
            // is the only way a missing definitions path ever fails. Naming the
            // game also stops an RDR2 resource being checked against Grand
            // Theft Auto's natives. The second entry covers a workspace made by
            // New Project, which keeps its definitions in lua-defs/ at the root.
            body: JSON.stringify({
                '$schema': 'https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json',
                'runtime.version': 'Lua 5.4',
                'workspace.library': [`../../editor/lua-defs/${game}`, '../../lua-defs'],
                'diagnostics.globals': MANIFEST_DIRECTIVES,
                'workspace.checkThirdParty': false,
            }, null, 2) + '\n',
        },
    ];
}
