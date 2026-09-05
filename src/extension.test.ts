// editor/src/extension.test.ts
// Covers classifyReply and isEditorDefinitionFile — the two pure decision
// functions extension.ts relies on. extension.ts itself imports 'vscode',
// which does not exist outside the extension host, so it can never be
// imported from a plain Node test; both functions live instead in
// vscode-free modules (./replies, ./paths) that extension.ts imports, and
// this file tests those modules directly.
import { classifyReply } from './replies';
import { isEditorDefinitionFile, isSafeConsoleHost } from './paths';
import { Op } from './protocol';
import { Reply } from './client';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

function reply(op: number, text = ''): Reply {
    return { op, payload: Buffer.from(text, 'utf8') };
}

function testClassifyReply(): void {
    const ok = classifyReply(reply(Op.Ok, 'answer'));
    check(ok.kind === 'ok', 'classifies OP_OK as ok');
    check(ok.kind === 'ok' && ok.payload.toString('utf8') === 'answer',
        '  and carries the payload through');

    const err = classifyReply(reply(Op.Err, 'boom'));
    check(err.kind === 'error', 'classifies OP_ERR as error');
    check(err.kind === 'error' && err.text === 'boom', '  and carries the message text');

    // This is the exact bug classifyReply exists to prevent: naive code that
    // tests only `op === Op.Err` reads a BUSY reply as success, so a caller
    // reports "pushed" or "ran" for a request the console silently refused.
    const busy = classifyReply(reply(Op.Busy));
    check(busy.kind === 'busy', 'classifies OP_BUSY as busy');
    check(busy.kind !== 'ok', '  and OP_BUSY is NOT classified as ok');

    // Any other op — a real answer such as PONG or the payload of a GET —
    // is a plain ok, not a special case.
    const pong = classifyReply(reply(Op.Pong, 'pong-data'));
    check(pong.kind === 'ok', 'classifies a non-OK/ERR/BUSY op (e.g. PONG) as ok too');
}

function testIsEditorDefinitionFile(): void {
    check(isEditorDefinitionFile('/home/dev/project/editor/lua-defs/natives.def.lua'),
        'a forward-slash path under editor/lua-defs is a definition file');
    check(isEditorDefinitionFile('C:\\work\\MyGame\\editor\\lua-defs\\natives.def.lua'),
        'a backslash Windows path with a drive letter is a definition file');
    check(isEditorDefinitionFile('C:\\work\\MyGame\\EDITOR\\Lua-Defs\\natives.def.lua'),
        'matching is case-insensitive');
    check(isEditorDefinitionFile('editor/lua-defs/x.lua'),
        'a bare relative editor/lua-defs path is a definition file');

    check(!isEditorDefinitionFile('/home/dev/project/scripts/hello.lua'),
        'an ordinary scripts/ file is not a definition file');
    // False positives the earlier review checked by hand.
    check(!isEditorDefinitionFile('/home/dev/project/my-editor/lua-defs/x.lua'),
        'a folder merely named "my-editor" does not match "editor"');
    check(!isEditorDefinitionFile('/home/dev/project/lua-defs/x.lua'),
        'a bare "lua-defs/" with no "editor" parent does not match');
}

function testSafeConsoleHost(): void {
    check(isSafeConsoleHost('10.10.10.235'), 'an IPv4 address is a usable host');
    check(isSafeConsoleHost('ps4.local'), 'and so is a hostname');
    check(isSafeConsoleHost('a'), 'and a single label');

    // rageScriptManager.host is read from settings, and settings can come from the open
    // folder's own .vscode/settings.json -- so on someone else's repository it
    // is attacker-controlled text that Deploy Plugin puts on a command line.
    // Each of these would run something.
    check(!isSafeConsoleHost('1.2.3.4; rm -rf ~'), 'a semicolon is refused');
    check(!isSafeConsoleHost('1.2.3.4 && calc'), 'and a command chain');
    check(!isSafeConsoleHost('$(whoami)'), 'and a substitution');
    check(!isSafeConsoleHost('`whoami`'), 'and a backtick');
    check(!isSafeConsoleHost('1.2.3.4\nwhoami'), 'and a newline');
    // JavaScript's $ matches before a TRAILING newline even without the m
    // flag, so this one passed the first version of the check.
    check(!isSafeConsoleHost('1.2.3.4\n'), 'and a merely trailing newline');
    check(!isSafeConsoleHost("1.2.3.4' -x '"), 'and a quote');
    check(!isSafeConsoleHost(''), 'an empty host is refused');
    check(!isSafeConsoleHost('-Ip'), 'and one that would read as a flag');
    check(!isSafeConsoleHost('a'.repeat(256)), 'and an absurdly long one');
}

testClassifyReply();
testIsEditorDefinitionFile();
testSafeConsoleHost();

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
