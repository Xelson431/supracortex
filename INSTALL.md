# SupraCortex — Install tutorial

A short, copy-paste guide for installing SupraCortex as an MCP server and CLI.
For architecture, host status, and the full tool contract see
[README.md](./README.md), [COMPATIBILITY.md](./COMPATIBILITY.md), and
[MCP_PROTOCOL.md](./MCP_PROTOCOL.md).

SupraCortex is designed for **MCP stdio clients**; verified and unverified hosts
are listed in the README support matrix. You do **not** need OpenCode to use the
MCP server. The OpenCode adapter is an optional extra that adds native tools and
lifecycle hooks.

---

## 0. Prerequisites

- **Node.js >= 22.6** (declared in `package.json`) for the CLI and stdio MCP
  server. Check with:
  ```bash
  node --version
  ```
- **npm** (bundled with Node) for the packaged install. `pnpm` is only needed
  when working from a source checkout.

---

## 1. Install the CLI

Global install (recommended if you want `supracortex` on your PATH):

```bash
npm install -g supracortex
supracortex --version
```

Local install (use `npx` or `node_modules/.bin`):

```bash
npm install supracortex
npx supracortex --version
```

From a source checkout, build once and use the Node entrypoint:

```bash
cd /path/to/supracortex
pnpm install
pnpm run build
node dist/cli.js --version
```

The package ships two entry points: the `supracortex` CLI
(`dist/cli.js`) and the `supracortex-mcp` stdio shim. They resolve the project
root the same way, so hosts can use either.

---

## 2. Wire the project

Run this inside each project you want SupraCortex to remember:

```bash
cd /path/to/your/project
supracortex init --yes
```

- Without `--yes`, `init` prints a **plan only** and changes no files.
- With `--yes`, it wires the project and detected hosts, writes the guidance it
  owns, enables the project, and backfills the project index.
- Limit detection with `--agent claude` (repeatable; known values: `claude`,
  `codex`, `cursor`, `gemini`, `opencode`, `pi`).
- Wire another CLI on the standard `mcpServers` convention with
  `--target name=relative/path.json[:bare]`. The `:bare` suffix omits the `type`
  field for clients that reject it.

Runtime state is created lazily under `<project>/.supracortex/`. The generated
`.supracortex/.gitignore` keeps runtime memory, tasks, and cache out of Git
while leaving `config.jsonc`, `config.schema.json`, and `.supracortexignore`
visible. Settings stay central in `~/.config/supracortex/config.jsonc`; a
project file holds only store identity and a per-project kill switch.

---

## 3. Register the host

`init` handles project-local wiring. `connect` additionally registers the server
for a host once, at user/global scope:

```bash
supracortex connect claude     # Claude Code user scope
supracortex connect codex      # Codex ~/.codex/config.toml marker block
supracortex connect generic    # print an mcpServers JSON snippet
supracortex connect all        # claude + codex
```

Then **restart the host** so it loads the server. The server entry point is:

```bash
supracortex mcp
```

For a local install use `npx supracortex mcp` or the `supracortex-mcp` shim; on
Windows use the Node entrypoint. The server resolves its project root as
`SUPRACORTEX_ROOT ?? process.cwd()`, so the host must launch it with its working
directory set to the project root (or export `SUPRACORTEX_ROOT`). Launching it
elsewhere creates or reads a different `.supracortex/`.

For a host with no built-in adapter, paste the `connect generic` snippet into
its MCP configuration. This documents the wiring convention; it is not a claim
that the host has been live-tested.

| Host | Recommended wiring | Verification level |
|---|---|---|
| Claude Code | `supracortex connect claude` or project `init` | Wiring live-verified |
| Codex CLI | `supracortex connect codex` or project `init` | Wiring live-verified |
| OpenCode V1 | Project `init` installs the native V1 plugin | Live-tested |
| OpenCode V2 | Project `init` installs the native V2 plugin | Fixture/tarball-verified only |
| Cursor | `init` detection or a custom `--target` | Documented only |
| Gemini CLI | `init` detection or a bare `--target` | Documented only |
| Pi | Bundled experimental extension | Fixture/tarball-verified only |
| Other MCP stdio clients | `connect generic` snippet | Documented only |

See [COMPATIBILITY.md](./COMPATIBILITY.md) for the full status definitions and
recorded versions.

Disconnect with `supracortex disconnect claude`, `disconnect codex`, or
`disconnect all`.

---

## 4. Verify

From the project directory:

```bash
supracortex doctor                  # health checks; exit 1 if a check fails
supracortex status                  # enabled state, storage, counts, last error
supracortex status --json           # machine-readable
supracortex inspect "fix login"     # preview the context packet, no model call
```

Inside OpenCode, the equivalent slash commands are `/cortex-status`,
`/cortex-doctor`, and `/cortex-inspect <query>`. Other hosts call the MCP tools
directly (`cortex_status`, `cortex_context`, ...).

If `doctor` fails, read its first failing check; it names the file or setting it
could not validate. `supracortex doctor --fix` can repair the loader wiring.

---

## 5. Everyday commands

| Task | Command |
|---|---|
| Status | `supracortex status` |
| Health check | `supracortex doctor` |
| Enable this project | `supracortex enable` |
| Disable this project | `supracortex disable` |
| Preview context | `supracortex inspect "task"` |
| Compact memory | `supracortex compact` |
| Rebuild the experimental code graph | `supracortex code-graph rebuild --yes` |
| Clear generated data (keeps memory) | `supracortex reset all-generated --yes` |

Emergency kill switch (overrides configuration):

```bash
export SUPRACORTEX_DISABLE=1        # macOS/Linux
$env:SUPRACORTEX_DISABLE = "1"      # Windows PowerShell
```

`SUPRACORTEX_ENABLE=1` is also honoured, but disable wins.

---

## 6. Uninstall

Uninstall is mutating, so it requires `--yes`. Data is kept by default:

```bash
# Remove wiring, keep memory and configuration:
supracortex uninstall --yes

# Remove runtime data as well:
supracortex uninstall --yes --remove-data

# Global install:
supracortex uninstall --global --yes
```

Uninstall removes only files it owns and reverts only its own marker block in
shared files. It does not touch your source files.

---

## 7. Windows

The `supracortex-mcp` launcher is a POSIX bash script and is **not supported on
Windows**. Use the Node entrypoint instead:

```powershell
node C:\path\to\supracortex\dist\cli.js init --yes
node C:\path\to\supracortex\dist\cli.js connect generic
node C:\path\to\supracortex\dist\cli.js doctor
node C:\path\to\supracortex\dist\cli.js mcp
```

For an installed package, replace the path with
`node_modules\supracortex\dist\cli.js`. The compatibility CI matrix exercises
the Node CLI and MCP transport on Windows.

---

## Gotchas

1. **Restart the host** after install, connect, or enable/disable. A running
   OpenCode session needs a new session to fully reload the plugin module.
2. **Paths matter.** `supracortex init` records absolute paths for a source
   checkout. If you move or rename the checkout, re-run `init --yes`.
3. **One project root.** Every host that should share memory must launch
   `supracortex mcp` with the same working directory (or the same
   `SUPRACORTEX_ROOT`).
4. **Global install is enabled everywhere by default.** Opt one project out
   with `supracortex disable` inside it; `enable` removes the opt-out. Settings
   themselves stay central.
5. **SQLite is opt-in.** JSONL is the default. If `storage.driver` is set to
   `"sqlite"` and the database cannot open, the engine reports an error rather
   than silently switching stores.
6. **No hot unload.** Disabling makes the adapter inert immediately; a new host
   session completes the unload.
