// editor/src/consoleinput.test.ts
// Covers classifyConsoleInput and reduceConsoleKeys in isolation — see
// consoleinput.ts's header comment for why both live outside console.ts
// (which imports 'vscode' and so cannot be loaded by this plain-Node runner).
import { classifyConsoleInput, reduceConsoleKeys, initialKeyState, KeyState, KeyAction } from './consoleinput';
import { Op } from './protocol';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

function testExec(): void {
    const r = classifyConsoleInput('=1+1');
    check(r !== undefined, "a line starting with '=' produces a request");
    check(r?.op === Op.Exec, '  as an EXEC op');
    const expected = Buffer.concat([
        Buffer.from('console', 'utf8'), Buffer.from([0]), Buffer.from('return 1+1', 'utf8'),
    ]);
    check(!!r && r.payload.equals(expected),
        "  with payload 'console' NUL 'return <expr>', matching on_exec's framing");
}

function testCmd(): void {
    const r = classifyConsoleInput('spawn adder');
    check(r !== undefined, 'an ordinary line produces a request');
    check(r?.op === Op.Cmd, '  as a CMD op');
    check(!!r && r.payload.equals(Buffer.from('spawn adder', 'utf8')),
        '  with the raw line as payload');
}

function testBlank(): void {
    check(classifyConsoleInput('') === undefined, 'an empty line produces no request');
    check(classifyConsoleInput('   ') === undefined, 'a whitespace-only line produces no request');
    check(classifyConsoleInput('\t\t') === undefined, '  including tabs');
}

// A small stand-in for feeding one or more chunks through the reducer and
// collecting every action across the whole sequence, threading the state
// exactly as console.ts's handleInput does.
function run(chunks: string[]): { state: KeyState; actions: KeyAction[] } {
    let state = initialKeyState;
    const actions: KeyAction[] = [];
    for (const chunk of chunks) {
        const r = reduceConsoleKeys(state, chunk);
        state = r.state;
        actions.push(...r.actions);
    }
    return { state, actions };
}

function submits(actions: KeyAction[]): string[] {
    return actions.filter((a): a is { kind: 'submit'; line: string } => a.kind === 'submit').map(a => a.line);
}

function testCR(): void {
    const { actions } = run(['abc\r']);
    check(submits(actions).length === 1 && submits(actions)[0] === 'abc',
        "'\\r' submits the buffered line");
}

function testBareLF(): void {
    // The bug this reducer exists to fix: a paste with Unix line endings has
    // no '\r' at all, and used to be dropped by handleInput's old ch === '\r'
    // check with no feedback whatsoever.
    const { actions } = run(['cmd1\ncmd2\n']);
    check(JSON.stringify(submits(actions)) === JSON.stringify(['cmd1', 'cmd2']),
        "a bare '\\n' submits too, so Unix-style pasted lines are not lost");
}

function testCRLFPairSubmitsOnce(): void {
    const { actions } = run(['abc\r\n']);
    check(submits(actions).length === 1 && submits(actions)[0] === 'abc',
        '"\\r\\n" submits exactly once, not twice, for one Windows-style line ending');
}

function testCRLFSplitAcrossChunks(): void {
    // handleInput can be called once per keystroke, so the '\r' and the '\n'
    // of one CRLF can arrive in separate calls. sawCR has to survive that.
    const { actions } = run(['abc\r', '\n']);
    check(submits(actions).length === 1 && submits(actions)[0] === 'abc',
        'a "\\r\\n" split across two handleInput calls still submits once');
}

function testLFThenCRAreTwoLines(): void {
    // Not a pairing case: '\n' followed by a later, unrelated '\r' is two
    // separate line endings, each submitting whatever was typed since.
    const { actions } = run(['abc\ndef\r']);
    check(JSON.stringify(submits(actions)) === JSON.stringify(['abc', 'def']),
        "'\\n' and a later '\\r' are two independent submits");
}

function testBackspace(): void {
    const { state, actions } = run(['ab\x7f']);
    check(state.line === 'a', 'backspace removes the last buffered character');
    check(actions.filter(a => a.kind === 'backspace').length === 1, '  and emits one backspace action');
    const none = reduceConsoleKeys(initialKeyState, '\x7f');
    check(none.actions.length === 0, 'backspace on an empty line does nothing');
}

function testEcho(): void {
    const { state, actions } = run(['hi']);
    check(state.line === 'hi', 'ordinary characters accumulate in the line buffer');
    check(JSON.stringify(actions) === JSON.stringify([{ kind: 'echo', ch: 'h' }, { kind: 'echo', ch: 'i' }]),
        '  each producing its own echo action');
}

testExec();
testCmd();
testBlank();
testCR();
testBareLF();
testCRLFPairSubmitsOnce();
testCRLFSplitAcrossChunks();
testLFThenCRAreTwoLines();
testBackspace();
testEcho();

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
