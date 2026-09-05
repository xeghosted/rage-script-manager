# Changelog

## 0.1.1

- **The `host` setting no longer defaults to the author's own console.** It
  shipped with `10.10.10.235` as its default, which is meaningless on anyone
  else's network and failed as a connection timeout rather than as an
  instruction. It now starts empty, and Connect says what to set.
- Removed two README links to plugin repositories that do not exist publicly.
  The requirement is stated in prose instead.

## 0.1.0

First public release.

Extracted from the GTALua project, where it had been the editor half since the
control channel existed, and generalised: the extension never built console
paths itself -- it sends relative ones and lets the plugin resolve them -- so
serving Red Dead Redemption 2 as well needed no code change, only a port
setting and a name that does not claim one game.

- Connect to a GTALua or RDR2Lua control channel over TCP.
- Push and restart (`Ctrl+Alt+R`): a file under `resources/<name>/` restarts
  that resource, anything else reloads the script directory.
- Run the current buffer as a one-off without writing it to disk.
- A console terminal that evaluates Lua on the console; `=expr` prints a value.
- Live log streaming, with errors that name a file and line turned into
  diagnostics on that line.
- Resources view with start / stop / restart.
- Resource scaffolding, and a deploy command for the plugin `.prx`.
- Token authentication, when the console has a token file.
