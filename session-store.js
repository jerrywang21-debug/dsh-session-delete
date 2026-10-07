/**
 * Reversible removal of one Conversation, for `dsh-session-delete`.
 *
 * The Conversation leaves the Harness — its log, its projection-cache row, and
 * its Workspace-registry references all go — but the bytes are **moved to the
 * system Trash** instead of being unlinked, so the user can pull the log back
 * out of the Trash if the deletion was a mistake. Only the index references
 * (which are not the conversation) are edited in place.
 *
 * The Harness ships no delete primitive: `sessionPersistence` offers
 * create/open/stat/list, and the Workspace registry offers archive — which
 * deliberately keeps both the log and the accounting slot so unarchive can
 * restore the row. This module is the missing operation, written against the
 * layout those two owners produce:
 *
 *   <home>/sessions/<projectKey>/<encoded session id>/session.v<N>.jsonl.zstd
 *   <home>/storages/session_projcache/sessions/<encoded id>.json
 *   <home>/storages/workspace.json   (global.pinnedSessionIds,
 *                                     global.archivedSessionIds,
 *                                     tables.workspaces[*].sessionIds)
 *
 * `projectKey` is intentionally lossy (separators fold, long paths truncate),
 * so the owning bucket cannot be recomputed from a session id. The bucket is
 * therefore **found by scanning** the sessions root for a child named after
 * the encoded id — which also keeps deletion working for a session whose
 * header can no longer be read.
 *
 * Everything here is filesystem work behind injectable inputs, so it is
 * testable without a running Harness.
 *
 * @module dsh-session-delete/session-store
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, platform as hostPlatform } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

/** The session-id shape this module will address. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Suffix of the staging file a registry rewrite goes through. */
const STAGING_SUFFIX = '.dsh-session-delete.tmp'

/** Environment variable that overrides the Trash directory. */
export const TRASH_DIR_ENV = 'DSH_SESSION_DELETE_TRASH'

/**
 * Filesystem-safe encoding of one path segment, mirroring the persistence
 * backend so a session id addresses the same directory the log lives in.
 *
 * Only `A-Za-z0-9._-` survive; everything else — including `~` itself, `/`,
 * `\`, and dot-only names — becomes `~XXXX` (the UTF-16 code unit in hex).
 * An encoded segment therefore can never introduce a separator or a parent
 * reference.
 * @param raw - the raw path segment.
 * @returns one safe path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    out += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Resolve the Harness home this module reads.
 *
 * The boot-provided `dshHomePath` service is authoritative when present (it
 * honours an explicit `--home`), then `DSH_HOME`, then the default.
 * @param ctx - Host plugin context, or undefined outside a Harness process.
 * @param env - environment mapping read for `DSH_HOME`.
 * @returns the absolute Harness home.
 */
export function resolveHome(ctx, env = process.env) {
  const provided = ctx?.get?.('dshHomePath')
  if (typeof provided === 'function') {
    const value = provided()
    if (typeof value === 'string' && value.length > 0) return value
  }
  const configured = env?.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * The directory a deleted session is moved into.
 *
 * macOS uses `~/.Trash`, so the session appears in Finder's Trash where the
 * user already looks for deleted things. Everywhere else — and on any platform
 * through {@link TRASH_DIR_ENV} — one directory under the Harness home is used,
 * never `/tmp`: the point is that the log survives until the user empties it.
 * @param home - the Harness home.
 * @param env - environment mapping read for the override.
 * @param platformName - the platform whose default Trash to use.
 * @returns the absolute Trash directory.
 */
export function trashDirectory(home, env = process.env, platformName = hostPlatform()) {
  const configured = env?.[TRASH_DIR_ENV]
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  if (platformName === 'darwin') return join(homedir(), '.Trash')
  return join(home, 'trash')
}

/** The sessions root beneath one Harness home. */
export function sessionsRoot(home) {
  return join(home, 'sessions')
}

/** The per-session projection-cache document beneath one Harness home. */
export function projectionCacheFile(home, sessionId) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${encodeSegment(sessionId)}.json`)
}

/** The Workspace registry document beneath one Harness home. */
export function workspaceRegistryFile(home) {
  return join(home, 'storages', 'workspace.json')
}

/**
 * Whether `candidate` resolves inside `root`, as defence in depth behind
 * {@link encodeSegment}.
 * @param root - the directory the result must stay under.
 * @param candidate - the joined path to test.
 * @returns true when the resolved candidate is `root` or beneath it.
 */
export function isInside(root, candidate) {
  const base = resolve(root)
  const full = resolve(candidate)
  return full === base || full.startsWith(base + sep)
}

/**
 * Every directory this Conversation owns, across all project buckets.
 * @param home - the Harness home.
 * @param sessionId - the session to locate.
 * @returns absolute session directories; empty when nothing is on disk.
 */
export async function locateSessionDirs(home, sessionId) {
  const root = sessionsRoot(home)
  let buckets
  try {
    buckets = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const segment = encodeSegment(sessionId)
  const found = []
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const candidate = join(root, bucket.name, segment)
    if (!isInside(root, candidate)) continue
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isDirectory() === true) found.push(candidate)
  }
  return found
}

/**
 * Total size of one directory tree in bytes.
 *
 * Symbolic links are measured as links, never followed: a link is not this
 * session's storage, and following one could inflate the figure or walk a
 * cycle.
 * @param root - the directory to measure.
 * @returns bytes beneath `root`, or 0 when it is already gone.
 */
export async function directorySize(root) {
  const info = await stat(root).catch(() => undefined)
  if (info === undefined) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    total += await directorySize(join(root, entry.name))
  }
  return total
}

/**
 * One `YYYYMMDD-HHMMSS` stamp, so repeated deletions never collide by name.
 * @param now - the clock to stamp.
 * @returns the compact stamp.
 */
function trashStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Move one path into the Trash directory under a collision-free name.
 *
 * A same-volume `rename` is the normal path: atomic, instant, and inode
 * -preserving. Across devices (`EXDEV`) the tree is copied first and the
 * original removed only after the copy landed, so a failed move never loses
 * the Conversation.
 * @param target - the file or directory to move.
 * @param trashDir - the Trash directory.
 * @param now - the clock used for the name stamp.
 * @returns the destination path inside the Trash.
 */
export async function moveToTrash(target, trashDir, now = new Date()) {
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) throw new Error(`cannot trash "${target}": it does not exist`)
  if (isInside(trashDir, target)) return target
  await mkdir(trashDir, { recursive: true })
  const stamp = trashStamp(now)
  const base = basename(target)
  let destination = join(trashDir, `${base} ${stamp}`)
  for (let attempt = 2; ; attempt += 1) {
    if ((await stat(destination).catch(() => undefined)) === undefined) break
    destination = join(trashDir, `${base} ${stamp} (${attempt})`)
  }
  try {
    await rename(target, destination)
    return destination
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  await cp(target, destination, { recursive: true, force: false, errorOnExist: true })
  await rm(target, { recursive: true, force: true })
  return destination
}

/**
 * Describe one Conversation without changing it.
 * @param home - the Harness home.
 * @param sessionId - the session to describe.
 * @returns whether it exists on disk, its size, and the directories holding it.
 */
export async function inspectSession(home, sessionId) {
  const directories = await locateSessionDirs(home, sessionId)
  let sizeBytes = 0
  for (const directory of directories) sizeBytes += await directorySize(directory)
  return { exists: directories.length > 0, sizeBytes, directories }
}

/**
 * Drop one session id from the Workspace registry document on disk.
 *
 * This is the fallback used when the Host serves no `workspaceRegistry`
 * service. It removes the id from the pin set, the archive set, and every
 * workspace's account. A registry rewrite is atomic (staging file plus
 * same-directory rename), so a concurrent reader never sees a torn document.
 *
 * The document is an index, not the conversation, so it is edited rather than
 * trashed: leaving the id behind would keep pointing at a log that is no
 * longer there.
 * @param home - the Harness home.
 * @param sessionId - the session id to drop.
 * @returns whether the document changed, and why not when it did not.
 */
export async function pruneWorkspaceDocument(home, sessionId) {
  const file = workspaceRegistryFile(home)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { pruned: false, reason: 'missing' }
    throw error
  }
  let state
  try {
    state = JSON.parse(text)
  } catch {
    return { pruned: false, reason: 'unreadable' }
  }
  let references = 0
  const withoutId = (ids) => {
    const next = ids.filter((id) => id !== sessionId)
    references += ids.length - next.length
    return next
  }
  const global = state?.global
  if (global !== null && typeof global === 'object') {
    if (Array.isArray(global.pinnedSessionIds)) global.pinnedSessionIds = withoutId(global.pinnedSessionIds)
    if (Array.isArray(global.archivedSessionIds)) global.archivedSessionIds = withoutId(global.archivedSessionIds)
  }
  const workspaces = state?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const record of Object.values(workspaces)) {
      if (Array.isArray(record?.sessionIds)) record.sessionIds = withoutId(record.sessionIds)
    }
  }
  if (references === 0) return { pruned: false, reason: 'absent' }
  const staging = `${file}${STAGING_SUFFIX}`
  await writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(staging, file)
  return { pruned: true, references }
}

/**
 * Remove one Conversation from the Harness while keeping its bytes reachable:
 * its log directory and projection-cache row move to the Trash, and its
 * Workspace-registry references are dropped from the document.
 *
 * The move runs to completion before the registry document is touched, so a
 * registry that cannot be rewritten still leaves the Conversation out of the
 * list with its bytes recoverable; the returned report says which parts landed.
 * @param home - the Harness home.
 * @param sessionId - the session to remove.
 * @param options - `trashDir` overrides the destination, `now` the name stamp,
 * and `pruneDocument: false` skips the registry-document fallback.
 * @returns what moved where, how many bytes it held, and the non-fatal outcomes.
 */
export async function removeSession(home, sessionId, options = {}) {
  const trashDir = options.trashDir
    ?? trashDirectory(home, options.env ?? process.env, options.platform ?? hostPlatform())
  const now = options.now ?? new Date()
  const directories = await locateSessionDirs(home, sessionId)
  const trashed = []
  let freedBytes = 0
  for (const directory of directories) {
    freedBytes += await directorySize(directory)
    trashed.push({ from: directory, to: await moveToTrash(directory, trashDir, now) })
  }
  const cacheFile = projectionCacheFile(home, sessionId)
  const cacheExisted = (await stat(cacheFile).catch(() => undefined)) !== undefined
  const cacheTrashed = cacheExisted ? await moveToTrash(cacheFile, trashDir, now) : undefined
  const registry = options.pruneDocument === false
    ? { pruned: false, reason: 'registry-service' }
    : await pruneWorkspaceDocument(home, sessionId)
  return { directories, trashed, trashDir, freedBytes, cacheTrashed, registry }
}
