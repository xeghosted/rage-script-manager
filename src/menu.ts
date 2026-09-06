// src/menu.ts
// What the status-bar button offers when you click it.
//
// No `vscode` import, on purpose: this is the part worth testing — which
// entries exist, which command each one runs, and what changes with the
// connection state — and importing the API would drag the whole editor host
// into the test process to check a list of strings. extension.ts maps these
// onto vscode.QuickPickItem and executes `command`.

export interface MenuEntry {
    /** Shown in the picker. May contain a $(codicon). */
    label: string;
    /** Right-hand grey text: a keybinding, or the console being addressed. */
    description?: string;
    /** Command id to execute. Absent means this is a separator. */
    command?: string;
    /** A group heading rather than a choice. */
    separator?: boolean;
}

export interface MenuState {
    connected: boolean;
    /** Where the connection points, for the Connect/Disconnect line. */
    host: string;
    port: number;
}

const sep = (label: string): MenuEntry => ({ label, separator: true });

/**
 * The menu, in the order it is shown.
 *
 * Every entry is always present except the Connect/Disconnect pair, which is
 * genuinely one action in two states. Nothing else is hidden or greyed out on
 * context — an entry that vanishes when no editor is focused is an entry the
 * user cannot find when they go looking for it, and the commands already
 * report clearly when they have nothing to act on.
 */
export function buildMenu(s: MenuState): MenuEntry[] {
    const where = s.host ? `${s.host}:${s.port}` : 'no host configured';
    return [
        sep('Connection'),
        s.connected
            ? { label: '$(debug-disconnect) Disconnect', description: `connected to ${where}`, command: 'rageScriptManager.disconnect' }
            : { label: '$(plug) Connect', description: where, command: 'rageScriptManager.connect' },

        sep('Scripts'),
        { label: '$(cloud-upload) Push & Restart', description: 'Ctrl+Alt+R', command: 'rageScriptManager.pushReload' },
        { label: '$(play) Run Current File', description: 'Ctrl+Alt+Enter', command: 'rageScriptManager.runFile' },
        { label: '$(new-folder) New Resource', command: 'rageScriptManager.newResource' },

        sep('Resources'),
        { label: '$(debug-start) Start Resource', command: 'rageScriptManager.startResource' },
        { label: '$(debug-stop) Stop Resource', command: 'rageScriptManager.stopResource' },
        { label: '$(debug-restart) Restart Resource', command: 'rageScriptManager.restartResource' },
        { label: '$(refresh) Refresh Resources', command: 'rageScriptManager.refreshResources' },

        sep('Console'),
        { label: '$(terminal) Open Console', description: 'evaluate Lua on the console', command: 'rageScriptManager.openConsole' },
        { label: '$(output) Show Log', command: 'rageScriptManager.showLog' },

        sep('Plugin'),
        { label: '$(rocket) Deploy Plugin (.prx)', description: 'needs a game restart', command: 'rageScriptManager.deployPlugin' },
    ];
}
