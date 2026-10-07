# dsh-session-delete · a delete action for DSH sidebar conversations

English | [中文](README.md)

Adds a **delete** action to the conversation list of the DeepSeek Harness (DSH) web client: one **Delete conversation** row in a session row's `⋯` menu and one trash icon among the row's hover actions. Confirming removes the conversation from the Harness — and **moves its bytes to the system Trash**, so a mistake costs nothing worse than dragging the folder back out.

DSH ships rename / fork / archive for a conversation. Archive only hides the row and keeps both the log and the accounting slot; this plugin removes the conversation, but never destroys it irreversibly.

## What you see

| Where | What |
| --- | --- |
| Session row `⋯` menu | a red **Delete conversation** row below Archive (`order: 500`) |
| Session row hover actions | a trash icon button (`order: 300`, after Archive and Pin) with a tooltip |
| Confirmation | a destructive-action dialog that stays disabled until you tick the acknowledgement; it also names how much disk the conversation holds |
| After deletion | a report naming the exact path inside the Trash, so you can pull it back out |
| On refusal | a report carrying the Host's own reason (for example "this conversation is running a turn") |

If the deleted conversation is the one currently open, the main view's selection is released first, so the app never keeps displaying a conversation that no longer exists.

## What "delete" actually touches

DSH's real storage layout, one conversation at a time:

| Target | How |
| --- | --- |
| `<DSH_HOME>/sessions/<projectKey>/<session id>/session.v<N>.jsonl.zstd` (plus its lock file and any sibling artifacts) | **moved to the Trash** (`~/.Trash` on macOS) |
| `<DSH_HOME>/storages/session_projcache/sessions/<session id>.json` | **moved to the Trash** |
| the id inside `<DSH_HOME>/storages/workspace.json` (`pinnedSessionIds[]`, `archivedSessionIds[]`, every `workspaces[*].sessionIds[]`) | edited in place — this is an index, not conversation data, and leaving the id behind would point at a log that is gone |
| `<DSH_HOME>/attachments/v1/objects/` (content-addressed attachment objects) | **never touched**: several conversations may share one object, so a per-conversation delete would damage the others |

`projectKey` is a deliberately **lossy** encoding (separators fold, long paths truncate) and cannot be recomputed from a session id, so the plugin **scans** every project bucket under `sessions/` for the encoded id instead of deriving the path. Deletion therefore still works for a conversation whose stored header can no longer be read.

A same-volume move is a `rename` (atomic, instant, inode-preserving). Across devices (`EXDEV`) the tree is copied first and the original removed only after the copy landed, so no failure path loses data. Names inside the Trash carry a `YYYYMMDD-HHMMSS` stamp, so repeated deletions never overwrite each other.

## Conflict discipline

This is a standalone plugin. It does not patch, wrap, replace, or shadow any existing package:

- **Declared seats only** — `sidebar.workspaces.session.menu.item`, `sidebar.workspaces.session.row.action`, and `shell.overlay`, every one registered through `ctx.slots.inject()` (the contribution appears with the seat's declaration and is removed when that declaration collapses). No DOM patching, no reading React fiber props to recover a session id.
- **Namespaced ids** — `session-delete.menu`, `session-delete.row`, `session-delete.confirm`. No shipped id (`pin` / `rename` / `fork` / `archive`) is reused, so nothing existing is shadowed.
- **Its own route** — the HTTP surface lives at `/api2/dsh-session-delete/{inspect,delete}`; it claims no existing route.
- **Zero runtime dependencies** — the Host half uses `node:` builtins only; the browser half uses the Module Loader's `react` and the official primitives, with no build step.
- **Every other service is optional**, read with `ctx.get()` (`agents`, `sessions`, `workspaceRegistry`, `dshHomePath`). A profile that serves none loads the plugin as a no-op instead of leaving it PENDING.

## Trust fence

Because the route is destructive it carries three fences:

1. `POST` only;
2. `application/json` only — a cross-site page cannot send that content type without a CORS preflight, and this route never answers one;
3. a loopback `Host` (extendable through `DSH_SESSION_DELETE_TRUSTED_HOSTS`).

Request bodies are capped at 64 KiB. A session id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`; it is escaped again exactly as the persistence backend does before being joined to a path, and the result is re-checked to still be inside the sessions root.

**A running conversation is refused.** The guard reads DSH's own `agents.get(id).status === 'running'` — the same fact the sidebar's running indicator reads — so the guard and the UI can never disagree. An open but idle conversation deletes normally.

## Install

The package is a **DSH bundle** (`dsh.bundle.patch` → its own `cordis.patch.yml`). Pick **one** of the two ways:

**A. As a bundle (recommended).** Add the package to the profile's `dsh.profile.bundles`, e.g. `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-session-delete": "link:/path/to/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-session-delete"]
    }
  }
}
```

then let pnpm materialize the link (`pnpm install`).

**B. One hand-written insert row** in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

⚠️ Do **not** do both — the plugin would load twice and the Host half would refuse the duplicate route.

`dsh.client.platform` is declared as `web`, and the package ships both halves: the Host half (`index.js`) and the browser half (`client.js`).

Both halves load when the application starts. On a build whose HMR is unavailable, restart DSH after installing; a page refresh alone is not enough. (Editing a profile manifest while the app runs does trigger a recomposition on the builds this plugin was developed against — the plugin was verified live that way.)

## Configuration

| Environment variable | Default | Effect |
| --- | --- | --- |
| `DSH_SESSION_DELETE_TRASH` | `~/.Trash` on macOS, otherwise `<DSH_HOME>/trash` | the directory deleted conversations are moved into |
| `DSH_SESSION_DELETE_TRUSTED_HOSTS` | empty | extra trusted hostnames (comma-separated) for a non-loopback deployment |

## Known limitations

- **A running conversation cannot be deleted** (see above).
- **An already-attached idle conversation keeps an in-process copy** after deletion: a session object is owned by the fiber that created it and a plugin has no authority to dispose it. Disk and list are clean; the copy is released at the next DSH restart.
- **"Put Back" is up to Finder.** The plugin moves the directory into `~/.Trash`; Finder can normally drag it back, but whether the Put Back menu item is offered depends on Finder's own bookkeeping, which this plugin does not write.
- **The workspace-reference prune can be rolled back.** The plugin prefers the Workspace registry service (`unpinSession` / `unarchiveSession` / `detachSession`, which keep memory and disk in step) and falls back to an atomic edit of `workspace.json`. A rolled-back leftover is an id naming a conversation that no longer exists, which no grouping surface renders.
- **Web surface only**; the Host half loads as a no-op in a headless profile.

## Tests

```sh
node --test
```

Zero dependencies, `node:test`, in three layers:

- `test/session-store.test.mjs` — a real filesystem layout in a temp directory, asserting what is left in the Trash, what is left in the Harness tree, that a neighbouring conversation is untouched, name collisions, and the idempotent re-run.
- `test/host.test.mjs` — a fake Cordis context and fake `req`/`res`: the three fences, the running-conversation refusal, the registry-service path and its fallback, the Trash move, both broadcast events, convergence for a row whose storage is already gone, and route disposal when the fiber closes.
- `test/client.test.mjs` — a fake `__ModuleLoader__`, a fake `require` and a fake client context: the three seat registrations (name/id/order and no shadowed shipped id), dictionary key parity, the structure of the menu row and the hover button, the confirm → delete → Trash-report flow, the refusal report, and that an unrelated conversation is never closed.

## License

MIT.
