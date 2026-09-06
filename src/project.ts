// src/project.ts
// What "New Project" writes: a workspace that is ready to push on the first
// try. vscode-free so the content is testable; the command in extension.ts does
// the asking, the downloading and the writing.
//
// The one thing this cannot generate is the native definitions. They are
// ~700 KB per game, they belong to the plugin project, and without them
// autocomplete is silently absent — which reads as the extension being broken
// rather than as a missing file. So the command fetches them from the plugin's
// public repository at creation time and drops them in lua-defs/, and
// .luarc.json points there. A project made this way needs no checkout of the
// plugin and no further setup.

export interface GameInfo {
    id: 'gta5' | 'rdr2';
    label: string;
    titleId: string;
    port: number;
    /** The console directory this game's plugin instance owns. */
    dataRoot: string;
}

export const GAMES: GameInfo[] = [
    { id: 'gta5', label: 'Grand Theft Auto V', titleId: 'CUSA00411', port: 9615, dataRoot: '/data/gtalua' },
    { id: 'rdr2', label: 'Red Dead Redemption 2', titleId: 'CUSA03041', port: 9616, dataRoot: '/data/rdr2lua' },
];

/** Where the plugin project publishes the definitions this project needs. */
export const DEFS_REPO = 'https://raw.githubusercontent.com/xeghosted/luma/master';

export function defsUrl(game: string, file: string): string {
    return `${DEFS_REPO}/editor/lua-defs/${game}/${file}`;
}

/** The two files fetched into lua-defs/, in the order they are worth having. */
export const DEFS_FILES = ['runtime.def.lua', 'natives.def.lua'];

export function validateProjectName(name: string): string | undefined {
    if (!name) { return 'a project needs a name'; }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        return 'letters, digits, underscore, hyphen and dot only';
    }
    if (name === '.' || name === '..') { return 'not a usable directory name'; }
    return undefined;
}

export interface ProjectFile {
    /** Project-relative, forward slashes, in creation order. */
    path: string;
    body: string;
}

/**
 * The project, minus the downloaded definitions.
 *
 * `host` may be empty: an empty host setting is what the extension already
 * treats as "not configured yet", and writing a placeholder IP would be worse —
 * it fails as a connection timeout rather than as something obviously unset.
 */
export function projectFiles(game: GameInfo, host: string): ProjectFile[] {
    const j = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
    return [
        {
            path: '.luarc.json',
            // lua-defs/ sits beside this file, so one level, and this project is
            // its own workspace root — which is where LuaLS reads .luarc.json
            // from, and the only place it reads it from.
            body: j({
                '$schema': 'https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json',
                'runtime.version': 'Lua 5.4',
                'workspace.library': ['lua-defs'],
                'workspace.checkThirdParty': false,
            }),
        },
        {
            path: '.vscode/settings.json',
            body: j({
                'rageScriptManager.host': host,
                'rageScriptManager.port': game.port,
            }),
        },
        {
            path: 'scripts/hello.lua',
            body: [
                `-- ${game.label} (${game.titleId}) -- runs at boot, and on every reload.`,
                '--',
                '-- Push it with Ctrl+Alt+R: it lands in ' + game.dataRoot + '/scripts/',
                '-- and the script directory reloads without restarting the game.',
                '',
                'local frames = 0',
                '',
                'on_tick(function()',
                '    frames = frames + 1',
                '    if frames < 1800 then return end   -- about a minute at 30 fps',
                '    frames = 0',
                '',
                game.id === 'gta5'
                    ? '    local ped = GET_PLAYER_PED(-1)'
                    : '    local ped = PLAYER_PED_ID()',
                game.id === 'gta5'
                    ? '    local c   = GET_ENTITY_COORDS(ped, true)   -- Vector3 -> {x, y, z}'
                    : '    local c   = GET_ENTITY_COORDS(ped, 1, 0)   -- Vector3 -> {x, y, z}',
                '    log(string.format("hello: %.1f, %.1f, %.1f", c[1], c[2], c[3]))',
                'end)',
                '',
                '-- log() and print() go to the log and out to the editor. notify() does',
                '-- that AND puts a line on the console screen -- use it sparingly, the',
                '-- notification queue drains slower than a timer can fill it.',
                'notify("hello.lua loaded")',
                '',
            ].join('\n'),
        },
        {
            path: 'autostart.cfg',
            body: [
                '# Resources to start at boot, one name per line. Anything not listed',
                '# sits there until you start it -- from the menu, the Resources view,',
                '# or another resource.',
                '',
            ].join('\n'),
        },
        {
            path: 'README.md',
            body: [
                `# ${game.label} scripts`,
                '',
                `Lua for ${game.label} (\`${game.titleId}\`) on PS4, through the`,
                '[Luma](https://github.com/xeghosted/luma) plugin and the',
                '[RAGE Script Manager](https://marketplace.visualstudio.com/items?itemName=DominikHeise.rage-script-manager)',
                'extension.',
                '',
                '## Getting started',
                '',
                '1. Deploy Luma to the console and start the game — see the',
                '   [install guide](https://xeghosted.github.io/luma/install.html).',
                `2. Set \`rageScriptManager.host\` in \`.vscode/settings.json\` to your console's IP.`,
                `   The port is already \`${game.port}\`, which is this game's.`,
                '3. Click the **RAGE** item in the status bar and pick **Connect**.',
                '4. Open `scripts/hello.lua` and press `Ctrl+Alt+R`.',
                '',
                '## Layout',
                '',
                '```',
                'scripts/*.lua        pushed to ' + game.dataRoot + '/scripts/, reloaded together',
                'resources/<name>/    a resource, started and stopped on its own',
                'autostart.cfg        which resources start at boot',
                'lua-defs/            native definitions, for autocomplete only',
                '```',
                '',
                '`lua-defs/` is downloaded from the plugin project and is not something',
                'you edit. Do not push it to the console: a type stub in `scripts/` would',
                'be run on every boot from then on.',
                '',
                '## Writing scripts',
                '',
                'See the [scripting guide](https://xeghosted.github.io/luma/scripting.html).',
                '',
            ].join('\n'),
        },
        {
            path: '.gitignore',
            // The definitions are large, generated, and belong to the plugin
            // project; a copy committed here is a copy that goes stale against
            // the build actually on the console.
            body: ['lua-defs/', ''].join('\n'),
        },
    ];
}
