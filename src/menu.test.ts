// src/menu.test.ts
// The status-bar menu, checked against the commands the extension actually
// registers. The interesting failure is not "the list changed" — it is a menu
// entry pointing at a command id that does not exist, which VS Code reports as
// nothing happening at all when you click it.
import * as fs from 'fs';
import * as path from 'path';
import { buildMenu, MenuEntry } from './menu';

let failures = 0;
function check(ok: boolean, what: string) {
    console.log(`${what.padEnd(58)} ${ok ? 'ok' : 'FAIL'}`);
    if (!ok) { failures++; }
}

const state = { connected: false, host: '10.10.10.236', port: 9615 };
const choices = (m: MenuEntry[]) => m.filter((e) => !e.separator);

// --- every command id must be one the extension contributes ----------------
{
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const declared: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);

    const menu = [...buildMenu(state), ...buildMenu({ ...state, connected: true })];
    const unknown = choices(menu)
        .map((e) => e.command!)
        .filter((id) => !declared.includes(id));
    check(unknown.length === 0,
          `every menu entry runs a contributed command${unknown.length ? ` (bad: ${unknown.join(', ')})` : ''}`);

    // ...and the other direction, so a command added to package.json without
    // being offered anywhere does not quietly become unreachable. showMenu is
    // the one exception: it is what opens this menu.
    const missing = declared.filter(
        (id) => id !== 'rageScriptManager.showMenu' && !choices(menu).some((e) => e.command === id));
    check(missing.length === 0,
          `every contributed command is reachable from the menu${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
}

// --- the one thing that changes with state ---------------------------------
{
    const off = buildMenu(state);
    const on = buildMenu({ ...state, connected: true });

    check(choices(off).some((e) => e.command === 'rageScriptManager.connect'),
          'offers Connect while disconnected');
    check(!choices(off).some((e) => e.command === 'rageScriptManager.disconnect'),
          '  and not Disconnect');
    check(choices(on).some((e) => e.command === 'rageScriptManager.disconnect'),
          'offers Disconnect while connected');
    check(!choices(on).some((e) => e.command === 'rageScriptManager.connect'),
          '  and not Connect');
    check(choices(off).length === choices(on).length,
          '  and nothing else appears or disappears with the connection');
}

// --- the connection line names the console ---------------------------------
{
    const entry = choices(buildMenu(state))[0];
    check(entry.description === '10.10.10.236:9615',
          'the connect entry says which console it will reach');

    const nohost = choices(buildMenu({ ...state, host: '' }))[0];
    check(nohost.description === 'no host configured',
          '  and says so plainly when the host setting is empty');
}

// --- separators are headings, not choices ----------------------------------
{
    const menu = buildMenu(state);
    check(menu.filter((e) => e.separator).every((e) => e.command === undefined),
          'separators carry no command, so picking one cannot run anything');
    check(menu[0].separator === true, 'the menu opens with a group heading');
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} (${failures} failures)`);
process.exit(failures ? 1 : 0);
