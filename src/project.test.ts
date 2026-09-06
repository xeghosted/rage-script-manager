// src/project.test.ts
// What New Project writes, and the URLs it fetches from. The failure worth
// catching is a project that looks fine and does not work: a .luarc.json
// pointing at a directory the project does not have, or a definitions URL that
// has drifted from where the plugin actually publishes them — both of which
// show up only as autocomplete being silently absent.
import { GAMES, DEFS_FILES, DEFS_REPO, defsUrl, projectFiles, validateProjectName } from './project';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

// --- names -----------------------------------------------------------------
check(validateProjectName('') !== undefined, 'refuses an empty project name');
check(validateProjectName('my-scripts') === undefined, 'accepts letters, digits and hyphens');
check(validateProjectName('gtav.scripts_1') === undefined, '  dots and underscores too');
check(validateProjectName('../escape') !== undefined, 'refuses a name that could climb out of the folder');
check(validateProjectName('..') !== undefined, '  including bare ..');
check(validateProjectName('with space') !== undefined, 'refuses a name with a space');

// --- the two games ---------------------------------------------------------
{
    const ids = GAMES.map((g) => g.id).sort();
    check(ids.join(',') === 'gta5,rdr2', 'offers exactly the two supported games');
    check(GAMES.find((g) => g.id === 'gta5')!.port === 9615, 'GTA V is port 9615');
    check(GAMES.find((g) => g.id === 'rdr2')!.port === 9616, 'RDR2 is port 9616');
    check(GAMES.every((g) => /^CUSA\d{5}$/.test(g.titleId)), 'every game carries a title id');
    check(GAMES.every((g) => g.dataRoot.startsWith('/data/')), '  and a console data root');
}

// --- the definitions URLs --------------------------------------------------
{
    check(DEFS_REPO.startsWith('https://'), 'definitions are fetched over https');
    for (const g of GAMES) {
        for (const f of DEFS_FILES) {
            const u = defsUrl(g.id, f);
            check(u === `${DEFS_REPO}/editor/lua-defs/${g.id}/${f}`,
                  `the ${g.id} URL for ${f} matches the plugin's layout`);
        }
    }
    check(DEFS_FILES.includes('natives.def.lua') && DEFS_FILES.includes('runtime.def.lua'),
          'fetches both the natives and the runtime definitions');
}

// --- the project itself ----------------------------------------------------
for (const g of GAMES) {
    const files = projectFiles(g, '10.0.0.5');
    const at = (p: string) => files.find((f) => f.path === p);

    check(at('.luarc.json') !== undefined, `${g.id}: writes a .luarc.json`);
    const luarc = JSON.parse(at('.luarc.json')!.body);

    // The one that matters: the library path has to name a directory the
    // download actually fills, or autocomplete is missing with nothing to see.
    check(luarc['workspace.library'].length === 1 && luarc['workspace.library'][0] === 'lua-defs',
          '  pointing at lua-defs/, which is where the definitions land');
    check(luarc['runtime.version'] === 'Lua 5.4', '  and pinning Lua 5.4');

    const settings = JSON.parse(at('.vscode/settings.json')!.body);
    check(settings['rageScriptManager.port'] === g.port,
          `  settings carry ${g.id}'s port, not the other game's`);
    check(settings['rageScriptManager.host'] === '10.0.0.5',
          '  and the host it was given');

    check(at('scripts/hello.lua') !== undefined, '  an example script under scripts/');
    const hello = at('scripts/hello.lua')!.body;
    check(hello.includes(g.id === 'gta5' ? 'GET_PLAYER_PED(-1)' : 'PLAYER_PED_ID()'),
          `  written against ${g.id}'s own native, not the other game's`);
    check(!hello.includes(g.id === 'gta5' ? 'PLAYER_PED_ID()' : 'GET_PLAYER_PED(-1)'),
          '  and not the other one anywhere in it');

    check(at('autostart.cfg') !== undefined, '  an autostart.cfg to fill in');
    check(at('README.md')!.body.includes(g.titleId), '  a README naming the build');
    check(at('.gitignore')!.body.includes('lua-defs/'),
          '  and a .gitignore keeping the downloaded definitions out of git');

    check(files.every((f) => !f.path.startsWith('/') && !f.path.includes('..')),
          '  every path stays inside the project');
}

// --- an unset host is written as unset, not as a placeholder ---------------
{
    const settings = JSON.parse(
        projectFiles(GAMES[0], '').find((f) => f.path === '.vscode/settings.json')!.body);
    check(settings['rageScriptManager.host'] === '',
          'an unconfigured host is written empty, not as a fake IP');
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
