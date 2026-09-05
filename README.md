# RAGE Script Manager

Write, push and run Lua inside a running RAGE game on a jailbroken PS4 — without
restarting the game.

The editor talks to a GoldHEN plugin over its control channel. Save a file, press
`Ctrl+Alt+R`, and the script is on the console and running before you have let go
of the key. Errors come back as squiggles on the line that raised them.

**This extension is only the editor half.** It needs one of the plugins running
on the console:

| Game | Plugin | Port |
| --- | --- | --- |
| Grand Theft Auto V (CUSA00411 v1.57) | GTALua | 9615 |
| Red Dead Redemption 2 (CUSA03041 v1.32) | RDR2Lua | 9616 |

The plugins are a separate project from this extension and are not published
yet, so there is nothing to link to.  Without one of them running on the
console there is nothing for this extension to talk to.

One extension serves both. It speaks the protocol and sends relative paths; the
plugin resolves them under its own data root, so nothing here is game-specific
except the port you point it at.

## Getting started

1. Deploy the plugin for your game and start it (see that project's README).
2. Set `rageScriptManager.host` to your console's IP, and `rageScriptManager.port`
   to the port from the table above. Both are workspace settings, so a GTA V
   workspace and an RDR2 workspace can sit open side by side.
3. Run **RAGE: Connect**.

## Commands

All under the `RAGE:` category in the Command Palette.

| Command | Keybinding | What it does |
| --- | --- | --- |
| Connect / Disconnect | | Opens the control channel |
| Push & Restart | `Ctrl+Alt+R` | Saves the active file, sends it, restarts what it belongs to |
| Run Current File | `Ctrl+Alt+Enter` | Runs the buffer as a one-off, without saving or writing it to disk |
| Open Console | | A terminal that evaluates Lua on the console; `=expr` prints a value |
| Show Log | | The plugin's log, streamed live |
| New Resource | | Scaffolds a working resource — manifest, client script, `.luarc.json` |
| Start / Stop / Restart Resource | | From the palette or the Resources view |
| Refresh Resources | | Re-reads the resource list |
| Deploy Plugin (.prx) | | Runs the project's deploy script in a terminal |

`Push & Restart` decides where a file belongs by its path: something under
`resources/<name>/` is written there and **that resource** is restarted, anything
else goes to `scripts/` and reloads the script directory.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `rageScriptManager.host` | *(empty)* | Console IP or hostname — you must set this |
| `rageScriptManager.port` | `9615` | 9615 for GTALua, 9616 for RDR2Lua |
| `rageScriptManager.token` | *(empty)* | Shared secret, if the console has a token file |

## Two things worth knowing

**The channel serves one client at a time.** Run **Disconnect** before pointing
another tool at the same port, or the second connection is accepted and then
never answered — which looks exactly like a hang.

**There is no authentication unless you add it.** Anyone who can reach the port
can run arbitrary Lua in the game. That is the same trust level GoldHEN's FTP
already grants on the same network: fine on a home LAN, not fine anywhere else.
Write a secret to the plugin's token file and set `rageScriptManager.token` to
match, and the channel refuses everything else.

## Type definitions and autocomplete

Autocomplete for the game's natives comes from the *plugin project*, not from
this extension: each project generates a `lua-defs/` folder and wires it up
through `.luarc.json`. It needs the `sumneko.lua` extension. The definition
files are large (tens of thousands of lines), which is why they live with the
game they describe rather than being bundled here.

The extension knows about them only well enough to refuse to push one to the
console — a type stub in `scripts/` would be run on every boot from then on.

## Licence

MIT.
