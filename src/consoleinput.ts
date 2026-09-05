// editor/src/consoleinput.ts
// Decides what one line typed into the console pseudoterminal becomes on
// the wire. Split out of console.ts (which imports 'vscode', so it cannot
// be loaded by the plain-Node test runner) so this decision logic can be
// unit tested without a VS Code host — see extension.test.ts's header
// comment for the same reasoning applied to extension.ts's helpers.
import { Op } from './protocol';

export interface ConsoleRequest { op: Op; payload: Buffer; }

// A blank or whitespace-only line sends nothing — the caller just reprompts.
// Otherwise: a line starting with '=' is Lua to evaluate, framed exactly
// like runFile()'s EXEC payload in extension.ts ("chunkname\0<source>", see
// on_exec in src/net/dispatch.cpp) with the chunk name fixed at "console" and
// the source rewritten to `return <expr>` so the result comes back as the
// reply payload; any other line is sent verbatim as a CMD request, which is
// the only way to reach RegisterCommand on a console with no chat box.
export function classifyConsoleInput(line: string): ConsoleRequest | undefined {
    const t = line.trim();
    if (!t) { return undefined; }
    if (t.startsWith('=')) {
        const src = 'return ' + t.slice(1);
        const payload = Buffer.concat([
            Buffer.from('console', 'utf8'), Buffer.from([0]), Buffer.from(src, 'utf8'),
        ]);
        return { op: Op.Exec, payload };
    }
    return { op: Op.Cmd, payload: Buffer.from(t, 'utf8') };
}

// The pty side of the terminal: handleInput in console.ts gets called with
// raw keystrokes, not lines — one call per keypress from typing, or an
// entire pasted blob in one call. This reduces that raw text against the
// running state of the line buffer into the actions console.ts should take,
// so the character-by-character decisions (what submits a line, what is an
// edit, what is an echo) can be unit tested without a VS Code host, the same
// reason classifyConsoleInput above lives here rather than in console.ts.
//
// A submit happens on '\r', on '\n', or on the "\r\n" pair — a real terminal
// (and a paste from one) can send any of the three, and a script or a
// clipboard with Unix line endings has no '\r' at all. `sawCR` is the only
// state carried between characters: it means the previous character was a
// bare '\r', so an immediate '\n' is the second half of that same line
// ending and must be swallowed rather than submitting an empty line again.
export interface KeyState { line: string; sawCR: boolean; }
export const initialKeyState: KeyState = { line: '', sawCR: false };

export type KeyAction =
    | { kind: 'submit'; line: string }
    | { kind: 'backspace' }
    | { kind: 'echo'; ch: string };

export function reduceConsoleKeys(state: KeyState, data: string): { state: KeyState; actions: KeyAction[] } {
    let { line, sawCR } = state;
    const actions: KeyAction[] = [];
    for (const ch of data) {
        const afterCR = sawCR;
        sawCR = false;
        if (afterCR && ch === '\n') { continue; }   // second half of a "\r\n" pair, already submitted
        if (ch === '\r' || ch === '\n') {
            actions.push({ kind: 'submit', line });
            line = '';
            if (ch === '\r') { sawCR = true; }
            continue;
        }
        if (ch === '\x7f') {                        // backspace
            if (line.length > 0) {
                line = line.slice(0, -1);
                actions.push({ kind: 'backspace' });
            }
            continue;
        }
        if (ch >= ' ') {
            line += ch;
            actions.push({ kind: 'echo', ch });
        }
    }
    return { state: { line, sawCR }, actions };
}
