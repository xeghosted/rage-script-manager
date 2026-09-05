// editor/src/extension.ts
// Wires the control-channel Client into VS Code: connect/disconnect, push a
// file into scripts/ on the console and reload, run a file as a one-off, a
// log/event output channel, and a status bar item that surfaces connection
// state and whether the hash-native registry is ready.
import * as vscode from 'vscode';
import * as path from 'path';
import { Client } from './client';
import { Op } from './protocol';
import { classifyReply, ReplyOutcome } from './replies';
import { isEditorDefinitionFile, isSafeConsoleHost } from './paths';
import { pushTargetFor, parseChunkError, PushTarget } from './locate';
import { scaffoldFiles, gameForPort, validateResourceName } from './scaffold';
import { ResourceTreeProvider, ResourceItem, ResourceNode } from './resources';
import { parseResourceList } from './reslist';
import { createConsole } from './console';

let client: Client | null = null;
let output: vscode.OutputChannel;
// Errors from the console become squiggles here. Created at activation and
// disposed with the extension; keyed by file, so a fixed file clears on its
// next push rather than accumulating positions that no longer exist.
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
const tree = new ResourceTreeProvider();

// Same glyph in every state ($(plug): linked to a device) - only the text and
// the warning background change, so the item stays recognisable at a glance
// instead of the icon itself trying to encode state.
function setStatus(text: string, warn = false) {
    status.text = `$(plug) RAGE: ${text}`;
    status.backgroundColor = warn
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    status.show();
}

// A console path (resources/hello/client.lua, scripts/demo.lua) resolved
// against the open workspace folders. Undefined when no folder holds the file:
// a diagnostic on a path VS Code cannot open sits in the Problems panel with
// no way to reach it, which is worse than showing none.
//
// This is the ONE rule for turning a console name into a local file, and both
// directions use it — attaching a diagnostic and clearing one. They have to
// agree: resolving one by URI and the other by name means a clear that deletes
// nothing while the squiggle sits on a different folder's copy.
//
// Two limits follow from the rule being "first folder that has this exact
// relative path", and neither is worth machinery to remove:
//   * A multi-root workspace where two folders both hold resources/hello/ puts
//     every diagnostic for that resource on the FIRST one. Consistently, at
//     least, so a clear finds what an add left.
//   * A workspace that does not mirror /data/<plugin> at its root — resources/
//     nested one level down — matches nothing, so no diagnostics appear at all.
//     A `findFiles('**/' + remote)` fallback would cover it and would run on
//     every unresolvable error line, which is the common case for a resource
//     that lives only on the console. Caching that would then go stale exactly
//     when New Resource creates the file. Not worth it for a layout this
//     project does not use: the README and the scaffold both put resources/ at
//     the workspace root.
async function localFileFor(remote: string): Promise<vscode.Uri | undefined> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const candidate = vscode.Uri.joinPath(folder.uri, ...remote.split('/'));
        try {
            await vscode.workspace.fs.stat(candidate);
            return candidate;
        } catch {
            // Not in this folder. Try the next one.
        }
    }
    return undefined;
}

// Turns one line of console output into a diagnostic, if it names a file and a
// line. Everything else passes through untouched -- this only ever ADDS a
// squiggle; the output channel still gets every line either way.
//
// Every mutation of the collection queues behind the last one. Without this,
// two errors arriving in the same tick -- which is the normal case, since a
// failed START reports through both the ERR reply and the log -- would both
// await the file lookup, both read the same array, and the second set() would
// drop the first one's diagnostic.
let diagnosticQueue: Promise<void> = Promise.resolve();

function noteConsoleError(text: string): Promise<void> {
    diagnosticQueue = diagnosticQueue.then(() => addConsoleError(text)).catch(() => { });
    return diagnosticQueue;
}

// Same queue, for the same reason: a clear that overtook a pending add would
// leave the squiggle from the version being replaced standing over new code.
function clearConsoleErrors(remote: string): Promise<void> {
    diagnosticQueue = diagnosticQueue.then(async () => {
        const uri = await localFileFor(remote);
        if (uri) { diagnostics.delete(uri); }
    }).catch(() => { });
    return diagnosticQueue;
}

// Same file and line replaces rather than stacks: the console reports one
// failure through more than one channel (a START error arrives as an ERR reply
// AND in the log), and two identical squiggles on one line help nobody.
async function addConsoleError(text: string): Promise<void> {
    const ref = parseChunkError(text);
    if (!ref) { return; }
    const uri = await localFileFor(ref.remote);
    if (!uri) { return; }
    // Lua counts lines from 1 and VS Code from 0. Lua reports no column, so the
    // whole line is underlined rather than guessing at one.
    const line = Math.max(0, ref.line - 1);
    const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        ref.message, vscode.DiagnosticSeverity.Error);
    d.source = 'rageScriptManager';
    const kept = (diagnostics.get(uri) ?? []).filter((e) => e.range.start.line !== line);
    diagnostics.set(uri, [...kept, d]);
}

// Reports a non-ok ReplyOutcome the same way everywhere: output channel,
// revealed, plus a notification, since this is always a reply to a command
// the user triggered directly (push, reload, run), and a silent miss on a
// keybinding is the worst outcome. BUSY gets its own plain wording, since it
// is transient by nature and the fix is simply to retry, not to debug
// anything.
function reportReplyFailure(outcome: { kind: 'error'; text: string } | { kind: 'busy' }, what: string): void {
    const msg = outcome.kind === 'busy'
        ? `RAGE Script Manager: console was busy - ${what} was not performed, try again`
        : `RAGE Script Manager: ${what} failed - ${outcome.text}`;
    output.appendLine(`[error] ${msg}`);
    output.show(true);
    vscode.window.showErrorMessage(msg);
    // A START that fails to compile a file reports through the ERR frame and
    // never reaches the log, so the reply text is a source of positions too.
    if (outcome.kind === 'error') { void noteConsoleError(outcome.text); }
}

async function connect(): Promise<Client> {
    if (client?.connected) { return client; }
    const cfg = vscode.workspace.getConfiguration('rageScriptManager');
    const host = cfg.get<string>('host', '10.10.10.235');
    const port = cfg.get<number>('port', 9615);
    // Empty by default, which matches a console with no /data/<plugin>/token:
    // a HELLO with no payload is exactly what an unauthenticated channel
    // expects, so the setting costs nothing until somebody wants it.
    const token = cfg.get<string>('token', '');

    const c = new Client();
    c.on('log', (line: string) => { output.appendLine(line); void noteConsoleError(line); });
    c.on('event', (line: string) => { output.appendLine(`[event] ${line}`); void noteConsoleError(line); });
    c.on('state', (up: boolean) => {
        if (!up) { setStatus('disconnected', true); client = null; tree.clear(); }
    });

    setStatus(`connecting to ${host}...`);
    await c.connect(host, port);

    // `client` is adopted only once the handshake has actually succeeded.
    // Assigning it right after c.connect() — as this used to do — left a
    // REJECTED request (c.request() rejects on a timeout rather than
    // resolving with a Reply) with the client already set and the socket
    // still open, while the catch in activate()'s `wrap` set the status bar
    // to "disconnected". connect() would then early-return on
    // `client?.connected` and hand back that stale client forever: the bar
    // never corrects itself and the handshake never re-runs. So every
    // failure from here on — a thrown rejection or a non-ok reply — tears
    // the socket down and leaves `client` untouched (still null), exactly
    // as if connect() had never run.
    let hello: ReplyOutcome;
    try {
        hello = classifyReply(await c.request(
            Op.Hello, token ? Buffer.from(token, 'utf8') : undefined));
    } catch (e) {
        c.disconnect();
        setStatus('disconnected', true);
        throw e;
    }
    if (hello.kind !== 'ok') {
        // A HELLO that comes back anything but ok means the handshake never
        // completed, so nothing past this point can be trusted. Routing it
        // through classifyReply too closes the last gap where a call site
        // could get away with reading a bare Reply directly.
        c.disconnect();
        setStatus('disconnected', true);
        // "bad token" is the one handshake failure with a fix the user can
        // act on, and the raw reply text does not say what to do about it.
        const hint = hello.kind === 'error' && hello.text.includes('bad token')
            ? ' - the console has a token file and the rageScriptManager.token setting does not match it'
            : '';
        throw new Error(hello.kind === 'busy'
            ? 'console was busy - connect was not performed, try again'
            : `handshake failed - ${hello.text}${hint}`);
    }
    client = c;
    const info = Object.fromEntries(
        hello.payload.toString('utf8').split('\n').filter(Boolean).map((l) => l.split('='))
    );
    // A missing key means the server sent a HELLO payload with a different
    // shape than expected, not a JS bug - fall back to "?" rather than let
    // a bare property access print the literal string "undefined" into a
    // diagnostic surface.
    const natives = info.natives_ready === '1' ? 'ready' : info.natives_ready === '0' ? 'pending' : '?';
    output.appendLine(`[rage] connected to ${host}:${port} - plugin ${info.plugin ?? '?'}, base ${info.base ?? '?'}, natives_ready=${info.natives_ready ?? '?'}`);
    setStatus(`${host} (natives ${natives})`);
    await refreshResources();
    return c;
}

// Refreshes the tree from a live RESLIST, or clears it when there is nothing
// to show it (not connected, or the request itself failed) — an empty tree
// beats a stale one that no longer reflects the console. Only the "not
// connected" case is silent: a RESLIST that actually fails (error or busy)
// is reported like every other failure in this file, so a tree that goes
// empty after, say, a successful start/stop/restart doesn't read to the
// user as "there are no resources" with no explanation.
async function refreshResources(): Promise<void> {
    if (!client?.connected) { tree.clear(); return; }
    const r = await client.request(Op.ResList);
    const outcome = classifyReply(r);
    if (outcome.kind !== 'ok') {
        tree.clear();
        reportReplyFailure(outcome, 'refresh resources');
        return;
    }
    const { entries, truncated } = parseResourceList(r.payload.toString('utf8'));
    tree.setEntries(entries, truncated);
}

// Lists resources for a QuickPick when a lifecycle command was invoked from
// the command palette rather than from a tree item (which already carries
// its own name). A truncated RESLIST is never silently narrowed to whatever
// fit — the picker's placeholder and an explicit warning both say so, since
// a truncation the user cannot see is exactly the failure mode RESLIST's
// truncation marker exists to prevent.
async function pickResource(verb: string): Promise<string | undefined> {
    const c = await connect();
    const r = await c.request(Op.ResList);
    const outcome = classifyReply(r);
    if (outcome.kind !== 'ok') { reportReplyFailure(outcome, 'list resources'); return undefined; }
    const { entries, truncated } = parseResourceList(r.payload.toString('utf8'));
    if (entries.length === 0) {
        vscode.window.showInformationMessage(truncated
            ? "RAGE Script Manager: the resource list is incomplete and no entries fit in the console's reply"
            : 'RAGE Script Manager: the console reports no resources');
        return undefined;
    }
    if (truncated) {
        vscode.window.showWarningMessage(
            'RAGE Script Manager: the resource list is incomplete — the console could not fit every resource into its '
            + 'reply. Showing only what it sent.');
    }
    const names = entries.map((e) => `${e.name} (${e.state})`);
    const picked = await vscode.window.showQuickPick(names, {
        placeHolder: truncated ? `Resource to ${verb} (list incomplete)` : `Resource to ${verb}`,
    });
    // The label carries the state for the reader; the name is everything before
    // the trailing " (state)".
    return picked ? picked.slice(0, picked.lastIndexOf(' (')) : undefined;
}

// `item` is whatever VS Code handed the view/item/context command, which is a
// ResourceNode: a ResourceItem (which has `entry`) or a TruncationItem (which
// does not). This used to be typed as ResourceItem and read `item?.entry.name`
// — the optional chain guards a missing item, not a missing `entry` — so a
// TruncationItem threw a TypeError that reached the user through activate()'s
// `wrap` as "RAGE Script Manager: Cannot read properties of undefined", plus a status bar
// reading "disconnected" for a connection that was fine. Only the `when`
// clauses in package.json kept one from ever getting here. Narrowing is what
// makes the compiler enforce that instead of a comment claiming it.
async function lifecycle(op: Op, item: ResourceNode | undefined, verb: string): Promise<void> {
    const fromItem = item instanceof ResourceItem ? item.entry.name : undefined;
    const name = fromItem ?? await pickResource(verb);
    if (!name) { return; }
    const c = await connect();
    const r = await c.request(op, Buffer.from(name, 'utf8'));
    const outcome = classifyReply(r);
    if (outcome.kind === 'ok') {
        vscode.window.setStatusBarMessage(`RAGE Script Manager: ${r.payload.toString()}`, 3000);
    } else {
        reportReplyFailure(outcome, verb);
    }
    await refreshResources();
}

function refuseDefinitionFile(doc: vscode.TextDocument, action: 'push' | 'run'): void {
    const msg = `RAGE Script Manager: ${path.basename(doc.fileName)} is a type definition for the editor, not a console script - refusing to ${action} it.`;
    output.appendLine(`[error] ${msg}`);
    vscode.window.showErrorMessage(msg);
}

// One file, written where the target says. Returns the reply outcome so the
// caller decides what a failure means.
async function putFile(c: Client, remote: string, body: Uint8Array): Promise<ReplyOutcome> {
    const payload = Buffer.concat([
        Buffer.from(remote, 'utf8'),
        Buffer.from([0]),
        Buffer.from(body),
    ]);
    return classifyReply(await c.request(Op.Put, payload));
}

// A resource without its manifest on the console cannot start: read_manifest
// (src/script/lua/resource.lua) answers "no fxmanifest.lua" and RESTART fails.
// Pushing one file at a time made that the NORMAL first experience of a new
// resource -- New Resource scaffolds three files, Ctrl+Alt+R sends one of them,
// and the restart it triggers reports a failure on a resource that is simply
// incomplete on the far side.
//
// So the manifest rides along with every push into a resource. It is a few
// hundred bytes, the local tree is the side you are editing from, and the
// alternative -- probing with LS first -- costs a round trip to answer a
// question whose answer is almost always "push it".
async function pushManifestFor(c: Client, doc: vscode.TextDocument,
                               target: PushTarget): Promise<void> {
    const remote = `resources/${target.resource}/fxmanifest.lua`;
    if (remote === target.remote) { return; }   // it IS the file being pushed

    // Walked up from the pushed file itself rather than resolved against the
    // workspace folders. In a multi-root workspace where two folders both have
    // resources/hello/, resolving by name can find the OTHER folder's manifest
    // and pair it with this folder's script.
    const up = target.remote.split('/').slice(2).map(() => '..');   // past resources/<name>
    const manifest = vscode.Uri.joinPath(doc.uri, ...up, 'fxmanifest.lua');

    // The active document was saved before the push; this one may be open and
    // dirty in another tab, and uploading its stale on-disk copy over the
    // console's would quietly undo an edit -- a client_script line added and
    // not yet saved would restart the resource without the script it names.
    const open = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === manifest.toString());
    if (open?.isDirty) {
        // save() RESOLVES FALSE rather than rejecting when the save does not
        // happen -- a read-only file, a vetoing save participant, a failing
        // format-on-save. Ignoring that would upload the stale bytes while the
        // dirty check made it look handled, which is the exact failure this
        // block exists to prevent. The push still goes ahead: a resource
        // without a manifest on the console cannot start at all, so a stale
        // one beats none -- but not silently.
        if (!await open.save()) {
            output.appendLine(`[warn] ${remote} could not be saved; pushing the copy on disk`);
        }
    }

    let body: Uint8Array;
    try {
        body = await vscode.workspace.fs.readFile(manifest);
    } catch (e: any) {
        // No manifest is ordinary -- the console may already have one, and the
        // restart will say if it does not. Anything ELSE (a lock, a permission)
        // would otherwise be swallowed here and resurface as the console's
        // "no fxmanifest.lua", which points at the wrong thing entirely.
        if (e?.code !== 'FileNotFound') {
            output.appendLine(`[warn] could not read ${remote}: ${e?.message ?? e}`);
        }
        return;
    }

    // It is being replaced too, so the same rule applies to it: a squiggle from
    // the version now going away must not outlive it.
    //
    // By NAME, deliberately, even though the URI is right there. Diagnostics
    // are ATTACHED by name -- the console reports a console path and nothing
    // else -- so clearing by URI would key on a rule the add path does not use
    // and, in the multi-root case, delete nothing at all while the stale
    // squiggle sat on the other folder's copy. The two directions have to
    // agree; only the PUSH can afford to be exact, because it knows which file
    // it is holding.
    await clearConsoleErrors(remote);
    const put = await putFile(c, remote, body);
    if (put.kind !== 'ok') {
        // Reported, not fatal: the file the user actually asked to push is
        // still worth sending, and the restart after it will say plainly
        // whether the resource came up.
        output.appendLine(`[warn] could not push ${remote}`);
    }
}

async function pushReload() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showWarningMessage('RAGE Script Manager: no active editor'); return; }
    if (isEditorDefinitionFile(ed.document.fileName)) { refuseDefinitionFile(ed.document, 'push'); return; }
    await ed.document.save();

    const c = await connect();
    const target = pushTargetFor(ed.document.fileName);

    // The file is about to be replaced, so its old errors are about a version
    // that no longer exists. Clearing on the push rather than on a successful
    // restart is deliberate: if the new version fails too, its error arrives
    // moments later and fills the empty set back in.
    await clearConsoleErrors(target.remote);
    if (target.resource) { await pushManifestFor(c, ed.document, target); }

    const put = await putFile(c, target.remote,
        Buffer.from(ed.document.getText(), 'utf8'));
    if (put.kind !== 'ok') {
        // Stop here. Restarting after a write that never happened just runs
        // whatever was already on disk and reports that stale result as if it
        // were fresh.
        reportReplyFailure(put, 'push');
        return;
    }

    // A resource file restarts its resource; anything else keeps the M1
    // behaviour of reloading the script directory. RESTART on a resource that
    // is not running is not an error -- resource.lua treats it as a start --
    // so there is no state to check first.
    const verb = target.resource ? 'restart' : 'reload';
    const after = classifyReply(target.resource
        ? await c.request(Op.Restart, Buffer.from(target.resource, 'utf8'))
        : await c.request(Op.Reload));
    if (after.kind !== 'ok') {
        reportReplyFailure(after, verb);
        return;
    }
    // The tree carries each resource's state, and a restart just changed one.
    if (target.resource) { await refreshResources(); }
    vscode.window.setStatusBarMessage(
        `RAGE Script Manager: ${target.remote} pushed, ${after.payload.toString()}`, 4000);
}

// The chunk name is the file's identity in every error Lua reports, so it has
// to be a name that resolves back to THIS file. Workspace-relative does that
// for anything in the tree -- and happens to equal the console path for
// resources/ and scripts/ files, so a pushed file and a one-off run name the
// same thing.
//
// A file outside every folder gets a name that resolves to nothing at all.
// The alternative is what this replaced: /tmp/scratch.lua ran as
// scripts/scratch.lua and its errors squiggled a same-named workspace file --
// the wrong-file failure the whole feature is built to avoid.
function chunkNameFor(doc: vscode.TextDocument): string {
    // An untitled buffer has no file behind it, and asRelativePath hands back
    // its bare name -- which is NOT absolute, so the check below would let it
    // through and `foo.lua` would then squiggle scripts/foo.lua. The scheme
    // test is what closes that door; the absolute test covers a saved file that
    // lives outside every folder.
    if (doc.uri.scheme !== 'file') { return '<one-off>'; }
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    if (path.isAbsolute(rel)) { return '<one-off>'; }
    return rel.split(path.sep).join('/');
}

async function runFile() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showWarningMessage('RAGE Script Manager: no active editor'); return; }
    if (isEditorDefinitionFile(ed.document.fileName)) { refuseDefinitionFile(ed.document, 'run'); return; }
    const c = await connect();
    const name = chunkNameFor(ed.document);

    // Same reasoning as the push: the version that produced the old errors is
    // about to be replaced by this run. Without it a squiggle from a failed
    // run stayed until the file was PUSHED, which a one-off run never does.
    await clearConsoleErrors(name);
    const payload = Buffer.concat([
        Buffer.from(name, 'utf8'),
        Buffer.from([0]),
        Buffer.from(ed.document.getText(), 'utf8'),
    ]);
    const r = classifyReply(await c.request(Op.Exec, payload));
    if (r.kind !== 'ok') {
        reportReplyFailure(r, 'run');
        return;
    }
    vscode.window.setStatusBarMessage(`RAGE Script Manager: ${name} ran`, 3000);
}

// Scaffolds a resource into the first workspace folder and opens its client
// script. Nothing is pushed: the resource exists locally until the first
// Ctrl+Alt+R, which is also the moment it gets tested end to end.
async function newResource(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showWarningMessage('RAGE Script Manager: no folder is open'); return; }

    const name = await vscode.window.showInputBox({
        prompt: 'Resource name',
        placeHolder: 'my_resource',
        validateInput: validateResourceName,
    });
    if (!name) { return; }

    // Refuse rather than merge. Writing client.lua over somebody's work
    // because the name collided is not recoverable from inside the editor,
    // and a resource directory that already exists is never what New Resource
    // was asked for.
    const dir = vscode.Uri.joinPath(folder.uri, 'resources', name);
    try {
        await vscode.workspace.fs.stat(dir);
        vscode.window.showErrorMessage(`RAGE Script Manager: resources/${name} already exists`);
        return;
    } catch {
        // Does not exist, which is the case we want.
    }

    // The manifest's `game` directive follows the port this workspace is
    // pointed at, so an RDR2 workspace does not scaffold a GTA V manifest.
    const port = vscode.workspace.getConfiguration('rageScriptManager').get<number>('port', 9615);
    for (const f of scaffoldFiles(name, gameForPort(port))) {
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(folder.uri, ...f.path.split('/')),
            Buffer.from(f.body, 'utf8'));
    }
    const client = vscode.Uri.joinPath(dir, 'client.lua');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(client));
    vscode.window.setStatusBarMessage(
        `RAGE Script Manager: resources/${name} created - push it with Ctrl+Alt+R`, 5000);
}

// The .prx goes over FTP, not the control channel: without a running plugin
// there is no channel to push it through. That is why this command shells out
// to tools/deploy.ps1 rather than doing the transfer itself -- one
// implementation of the FTP walk, already used from the shell, rather than a
// second one here that could drift from it.
//
// It runs in a visible terminal on purpose. A deploy is followed by a game
// restart, and the reason to watch it is that a failure here (console off, FTP
// not up) otherwise shows up minutes later as "my change did nothing".
async function deployPlugin(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showWarningMessage('RAGE Script Manager: no folder is open'); return; }
    const cfg = vscode.workspace.getConfiguration('rageScriptManager');
    const host = cfg.get<string>('host', '10.10.10.235');

    // The plugin is loaded at title launch only, so pushing it while the game
    // runs changes nothing until a restart. Saying so before the transfer is
    // the difference between a deploy that looks broken and one that is simply
    // not live yet.
    // rageScriptManager.host reaches a shell here, and a setting can come from the open
    // folder's own .vscode/settings.json. Refused rather than quoted -- see
    // isSafeConsoleHost.
    if (!isSafeConsoleHost(host)) {
        vscode.window.showErrorMessage(
            `RAGE Script Manager: refusing to deploy - rageScriptManager.host is not an address (${host})`);
        return;
    }

    const term = vscode.window.createTerminal({ name: 'RAGE deploy', cwd: folder.uri });
    term.show();
    term.sendText(`pwsh tools/deploy.ps1 -Ip ${host}`);
    vscode.window.showInformationMessage(
        'RAGE Script Manager: deploying over FTP. The plugin only loads at title launch - restart the game.');
}

export function activate(ctx: vscode.ExtensionContext) {
    output = vscode.window.createOutputChannel('RAGE Script Manager');
    diagnostics = vscode.languages.createDiagnosticCollection('rageScriptManager');
    ctx.subscriptions.push(diagnostics);
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'rageScriptManager.showLog';
    setStatus('disconnected', true);

    // Generic over its argument list so it can wrap both a plain () =>
    // Promise<void> command and one that receives VS Code's own callback
    // argument, such as the ResourceItem a view/item/context command is
    // invoked with — while still forwarding that argument through to fn.
    const wrap = <A extends unknown[]>(fn: (...args: A) => Promise<void>) => async (...args: A) => {
        try { await fn(...args); }
        catch (e: any) {
            output.appendLine(`[error] ${e?.message ?? e}`);
            vscode.window.showErrorMessage(`RAGE Script Manager: ${e?.message ?? e}`);
            setStatus('disconnected', true);
        }
    };

    ctx.subscriptions.push(
        output,
        status,
        vscode.commands.registerCommand('rageScriptManager.connect', wrap(async () => { await connect(); })),
        vscode.commands.registerCommand('rageScriptManager.disconnect', () => { client?.disconnect(); client = null; setStatus('disconnected', true); tree.clear(); }),
        vscode.commands.registerCommand('rageScriptManager.pushReload', wrap(pushReload)),
        vscode.commands.registerCommand('rageScriptManager.runFile', wrap(runFile)),
        vscode.commands.registerCommand('rageScriptManager.showLog', () => output.show()),
        vscode.window.registerTreeDataProvider('rageScriptManagerResources', tree),
        vscode.commands.registerCommand('rageScriptManager.refreshResources', wrap(refreshResources)),
        vscode.commands.registerCommand('rageScriptManager.startResource',
            wrap((i?: ResourceNode) => lifecycle(Op.Start, i, 'start'))),
        vscode.commands.registerCommand('rageScriptManager.stopResource',
            wrap((i?: ResourceNode) => lifecycle(Op.Stop, i, 'stop'))),
        vscode.commands.registerCommand('rageScriptManager.restartResource',
            wrap((i?: ResourceNode) => lifecycle(Op.Restart, i, 'restart'))),
        vscode.commands.registerCommand('rageScriptManager.newResource', wrap(newResource)),
        vscode.commands.registerCommand('rageScriptManager.deployPlugin', wrap(deployPlugin)),
        vscode.commands.registerCommand('rageScriptManager.openConsole', () => {
            const pty = createConsole(() => connect());
            const term = vscode.window.createTerminal({ name: 'RAGE Console', pty });
            term.show();
        }),
    );
}

export function deactivate() {
    client?.disconnect();
}
