// editor/src/console.ts
// A pseudoterminal that talks to the game. The PS4 has no chat box, so this is
// the only way to reach RegisterCommand — and a line starting with '=' is
// evaluated as Lua instead, which makes it a REPL as well.
//
// The wire-level decision (which op, what payload) lives in ./consoleinput
// so it can be unit tested without a VS Code host; this file is only the
// terminal plumbing around it.

import * as vscode from 'vscode';
import { Client } from './client';
import { classifyReply } from './replies';
import { classifyConsoleInput, reduceConsoleKeys, initialKeyState, KeyState } from './consoleinput';

export function createConsole(getClient: () => Promise<Client>): vscode.Pseudoterminal {
    const writeEmitter = new vscode.EventEmitter<string>();
    let keys: KeyState = initialKeyState;
    // Guards against a second line submitted before the first reply arrives:
    // without it, `void submit(...)` from handleInput would put two requests
    // in flight at once and their replies would interleave in the terminal.
    // A line typed while one is outstanding is dropped rather than queued —
    // the user just retypes it once the prompt returns.
    let inflight = false;

    const prompt = () => writeEmitter.fire('\r\nrage> ');

    async function submit(text: string): Promise<void> {
        const req = classifyConsoleInput(text);
        if (!req) { prompt(); return; }
        try {
            const c = await getClient();
            const r = await c.request(req.op, req.payload);
            const outcome = classifyReply(r);
            if (outcome.kind === 'ok') {
                const body = r.payload.toString('utf8');
                writeEmitter.fire('\r\n' + (body || 'ok').replace(/\n/g, '\r\n'));
            } else if (outcome.kind === 'busy') {
                writeEmitter.fire('\r\nconsole busy — not performed, try again');
            } else {
                writeEmitter.fire('\r\n' + outcome.text.replace(/\n/g, '\r\n'));
            }
        } catch (e: any) {
            writeEmitter.fire('\r\n' + String(e?.message ?? e));
        }
        prompt();
    }

    return {
        onDidWrite: writeEmitter.event,
        open: () => {
            writeEmitter.fire('RAGE Script Manager console. A line is a command; "=expr" evaluates Lua.');
            prompt();
        },
        close: () => { /* nothing to release: the client is owned by the extension */ },
        handleInput: (data: string) => {
            const { state, actions } = reduceConsoleKeys(keys, data);
            keys = state;
            for (const action of actions) {
                if (action.kind === 'submit') {
                    if (inflight) {
                        writeEmitter.fire('\r\nrage: still waiting on the previous line, ignored');
                        prompt();
                        continue;
                    }
                    inflight = true;
                    void submit(action.line).finally(() => { inflight = false; });
                } else if (action.kind === 'backspace') {
                    writeEmitter.fire('\b \b');
                } else {
                    writeEmitter.fire(action.ch);
                }
            }
        },
    };
}
