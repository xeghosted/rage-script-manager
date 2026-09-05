// editor/src/scaffold.test.ts
// Covers what "New Resource" writes. scaffold.ts imports no 'vscode' so this
// plain-Node runner can load it; extension.ts does the asking and the writing.
import { scaffoldFiles, gameForPort, validateResourceName } from './scaffold';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(64)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

function testValidation(): void {
    // net::RESOURCE_NAME_MAX is 127 and the console proved the boundary
    // exactly (docs/post-m2a-verification-session.md): 127 loads, 128 is
    // refused by the wire. Refusing here saves a round trip and says why.
    check(validateResourceName('') !== undefined, 'an empty name is refused');
    check(validateResourceName('a'.repeat(128)) !== undefined, 'a 128-byte name is refused');
    check(validateResourceName('a'.repeat(127)) === undefined, 'a 127-byte name is accepted');
    check(validateResourceName('has space') !== undefined, 'a name with a space is refused');
    check(validateResourceName('../escape') !== undefined, 'a name with a path separator is refused');
    check(validateResourceName('.') !== undefined, 'a bare dot is refused');
    check(validateResourceName('my_resource-2') === undefined, 'letters, digits, _ and - are accepted');

    // The cap is on BYTES, not characters: the wire counts bytes, and a name
    // of 127 multi-byte characters is far over it.
    check(validateResourceName('ä'.repeat(64)) !== undefined, 'the length cap counts bytes, not characters');
}

function testFiles(): void {
    const files = scaffoldFiles('demo');
    check(files.length === 3, 'three files are scaffolded');
    check(files[0].path === 'resources/demo/fxmanifest.lua', 'the manifest comes first');
    check(files[1].path === 'resources/demo/client.lua', 'then the client script');
    check(files[2].path === 'resources/demo/.luarc.json', 'then the LuaLS config');

    check(files[0].body.includes("client_script 'client.lua'"), 'the manifest names the client script');
    check(files[0].body.includes("name 'demo'"), 'and carries the resource name');
    // Every directive it emits must be one src/script/lua/manifest.lua accepts,
    // or the resource starts with a warning on its very first run.
    for (const directive of ['fx_version', 'game', 'name', 'description', 'version', 'client_script']) {
        check(files[0].body.includes(directive), `  ${directive} is a directive the parser knows`);
    }
    check(!files[0].body.includes('server_script'), 'and no server_script, which this console warns about');

    check(files[1].body.includes('CreateThread'), 'the client script shows the scheduler API');
    check(files[1].body.includes("RegisterCommand('demo'"), 'and registers a command named after the resource');

    const luarc = JSON.parse(files[2].body);
    check(luarc['workspace.library'][0] === '../../editor/lua-defs',
        'the config points at the native definitions, two levels up');
    check(luarc['runtime.version'] === 'Lua 5.4', 'and names the runtime the console runs');
}

// The `game` directive both plugins parse and then ignore. Because they ignore
// it, a wrong value never surfaces at runtime -- so it is worth pinning here,
// where a mistake is visible.
function testGameDirective(): void {
    check(gameForPort(9615) === 'gta5', "port 9615 scaffolds a GTA V manifest");
    check(gameForPort(9616) === 'rdr3', "port 9616 scaffolds a Red Dead manifest");
    check(gameForPort(1234) === 'gta5', "an unknown port falls back to GTA V rather than inventing a game");

    const rdr = scaffoldFiles('demo', gameForPort(9616));
    check(rdr[0].body.includes("game 'rdr3'"), "  and the directive reaches the manifest");
    const gta = scaffoldFiles('demo');
    check(gta[0].body.includes("game 'gta5'"), "  with GTA V still the default when no game is passed");
}


testValidation();
testFiles();
testGameDirective();
