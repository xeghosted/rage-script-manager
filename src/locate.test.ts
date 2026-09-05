// editor/src/locate.test.ts
// Covers locate.ts in isolation — it imports no 'vscode', so this plain-Node
// runner can load it. See locate.ts's header for why both directions of the
// mapping live in one module.
import { pushTargetFor, parseChunkError } from './locate';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(64)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

function testPushTarget(): void {
    const t = pushTargetFor('E:\\Projects\\PS4\\MyGame\\resources\\hello\\client.lua');
    check(t.remote === 'resources/hello/client.lua', 'a file under resources/<name>/ targets that resource');
    check(t.resource === 'hello', '  and names the resource to restart');

    const nested = pushTargetFor('/home/x/mygame/resources/hello/lib/util.lua');
    check(nested.remote === 'resources/hello/lib/util.lua', 'a nested resource file keeps its subdirectory');
    check(nested.resource === 'hello', '  and still names the resource');

    const plain = pushTargetFor('/home/x/mygame/scripts/demo.lua');
    check(plain.remote === 'scripts/demo.lua', 'a file outside any resource keeps the M1 scripts/ target');
    check(plain.resource === undefined, '  and has no resource to restart');

    // The M1 rule was basename-only, so a file anywhere at all became
    // scripts/<basename>. That stays the fallback: it is what Push & Reload
    // has always done, and changing it would silently retarget every script
    // people already push from outside the tree.
    check(pushTargetFor('/tmp/scratch.lua').remote === 'scripts/scratch.lua',
        'a file from anywhere else falls back to scripts/<basename>');

    // "resources" has to be a path SEGMENT. A directory called "my-resources"
    // is not the resource root, and treating it as one would push into a
    // resource that does not exist.
    check(pushTargetFor('/home/x/my-resources/hello/client.lua').remote === 'scripts/client.lua',
        'a directory merely ending in "resources" is not the resource root');

    // A file sitting directly in resources/ belongs to no resource: there is
    // no <name>/<rel> to build, and RESTART would have nothing to name.
    check(pushTargetFor('/home/x/resources/loose.lua').remote === 'scripts/loose.lua',
        'a file directly inside resources/ belongs to no resource');
}

function testParseChunkError(): void {
    // A resource chunk is loaded as "@<name>/<rel>", so Lua prints the name bare.
    const r = parseChunkError('client.lua: hello/client.lua:12: attempt to index a nil value');
    check(r !== null && r.remote === 'resources/hello/client.lua', 'a resource chunk error maps to its resource file');
    check(r !== null && r.line === 12, '  and carries the line');
    check(r !== null && r.message === 'attempt to index a nil value', '  and the message without the position');

    // A scripts/ file is loaded with a bare chunkname, so Lua wraps it.
    const s = parseChunkError('[string "demo.lua"]:3: bad argument #1 to \'foo\'');
    check(s !== null && s.remote === 'scripts/demo.lua', 'a scripts/ chunk error maps into scripts/');
    check(s !== null && s.line === 3, '  and carries the line');

    // EXEC sends a buffer with no file behind it. Pointing a diagnostic at a
    // file that merely shares a prefix would be worse than none.
    check(parseChunkError('[string "local f = native(0x1000)"]:1: oops') === null,
        'a one-off EXEC chunk maps to no file at all');

    check(parseChunkError('resource hello started') === null, 'an ordinary log line is not an error');
    check(parseChunkError('') === null, 'and neither is an empty one');

    // The message half may contain colons and digits; only the FIRST
    // position after the chunk name is the position.
    const c = parseChunkError('hello/client.lua:7: bad time 12:30 for 4:5');
    check(c !== null && c.line === 7, 'a message containing colons does not move the line number');
    check(c !== null && c.message === 'bad time 12:30 for 4:5', '  and survives intact');

    // A manifest is loaded as "@<name>/fxmanifest.lua" (read_manifest in
    // src/script/lua/resource.lua), so it produces the same shape as a script.
    // Worth its own case: a broken manifest is the most likely first failure of
    // a brand-new resource, and it is the one file New Resource writes that
    // nobody edits afterwards.
    const m = parseChunkError("hello/fxmanifest.lua:3: '=' expected near 'client_script'");
    check(m !== null && m.remote === 'resources/hello/fxmanifest.lua',
        'a manifest error maps to the manifest');
    check(m !== null && m.line === 3, '  and carries its line');

    // A resource may nest its scripts, and the chunk name keeps the whole
    // relative path.
    const deep = parseChunkError('lib/util.lua: hello/lib/util.lua:9: boom');
    check(deep !== null && deep.remote === 'resources/hello/lib/util.lua',
        'a nested resource file keeps every path segment');

    // Run Current File sends the file's console path as the chunk name, so
    // this shape carries a full path already. Prefixing it with scripts/ would
    // aim the diagnostic at scripts/<basename> -- a different file, which may
    // well exist.
    const oneOff = parseChunkError('[string "resources/hello/client.lua"]:3: boom');
    check(oneOff !== null && oneOff.remote === 'resources/hello/client.lua',
        'a one-off run of a resource file lands on that file');
    const oneOffScript = parseChunkError('[string "scripts/demo.lua"]:1: boom');
    check(oneOffScript !== null && oneOffScript.remote === 'scripts/demo.lua',
        '  and an already-prefixed name is not prefixed twice');
    // A file outside every workspace folder runs under the name <one-off>,
    // which must resolve to nothing: naming it scripts/<basename> would
    // squiggle a same-named file that IS in the workspace.
    check(parseChunkError('[string "<one-off>"]:1: boom') === null,
        'a run from outside the workspace maps to no file');
    // The console REPL sends the chunk name "console", which is not a file.
    check(parseChunkError('[string "console"]:1: boom') === null,
        'the REPL chunk still maps to no file');

    // The caller joins this path onto a workspace folder, so a ".." would
    // resolve outside it -- the hole net::path_guard closes on the plugin
    // side. No real chunk name has one, and it is refused rather than
    // normalised.
    check(parseChunkError('../../../etc/passwd.lua:1: boom') === null,
        'a chunk name that climbs out of the tree maps to nothing');
    check(parseChunkError('a/../../x.lua:2: boom') === null,
        '  including one that climbs out halfway through');
    check(parseChunkError('[string ".."]:1: boom') === null,
        '  and one wearing the scripts/ shape');
    // ...while a leading dot in a NAME is ordinary and must still work.
    const dotted = parseChunkError('hello/.config.lua:4: boom');
    check(dotted !== null && dotted.remote === 'resources/hello/.config.lua',
        'a dotfile inside a resource is not a dot segment');

    // A traceback repeats positions. The first one is where it was raised.
    const t = parseChunkError('hello/a.lua:2: boom\nstack traceback:\n\thello/b.lua:9: in function');
    check(t !== null && t.remote === 'resources/hello/a.lua' && t.line === 2,
        'the first position in a traceback wins');
}

testPushTarget();
testParseChunkError();
console.log(failures === 0 ? '\nPASSED (0 failures)' : `\nFAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
