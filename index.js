/**
 * `dsh-session-delete` Host half.
 *
 * Owns the one operation the browser cannot perform: permanently removing one
 * Conversation from disk. It mounts a small JSON surface on the Host Web
 * server (`/api2/session-delete-trash/<op>`) that the browser half calls. The
 * official `/api` channel is a generated Remote assembly that an out-of-tree
 * plugin has no seat in, so a plugin-owned route is the only available
 * transport.
 *
 * The surface is destructive and therefore fenced three ways, matching what
 * the official loopback surfaces do:
 *
 *   1. `POST` only;
 *   2. `application/json` only — cross-site pages cannot send that content
 *      type without a CORS preflight, and this route never answers one;
 *   3. a loopback `Host` (extendable through `DSH_SESSION_DELETE_TRUSTED_HOSTS`).
 *
 * A Conversation that is **running** a turn is refused instead of deleted: the
 * turn would keep appending to a log this surface just moved away, losing both
 * the answer and the record of the question. An attached-but-idle Conversation
 * is deleted normally, and the Host forwards `api-session/removed` — the same
 * signal a disposed Session produces — so the sidebar row leaves with the
 * storage.
 *
 * Deletion is reversible by construction: the log directory and the projection
 * -cache row are **moved to the system Trash** (`~/.Trash` on macOS, or
 * `$DSH_SESSION_DELETE_TRASH`), not unlinked, so a mistake costs nothing worse
 * than dragging the folder back out. Only the Workspace registry document —
 * an index of ids rather than the conversation — is edited in place.
 *
 * Conflict discipline: this plugin registers only its own two routes, reuses
 * no existing plugin id, edits no other plugin's files, and reaches other
 * subsystems exclusively through published services (`webServer`, `agents`,
 * `workspaceRegistry`, `dshHomePath`) resolved with `ctx.get`. Every one of
 * them is optional, so a profile that serves none loads this plugin as a
 * no-op rather than staying PENDING.
 *
 * @module dsh-session-delete
 */

import { readFile } from 'node:fs/promises'

import {
  SESSION_ID_PATTERN,
  inspectSession,
  removeSession,
  resolveHome,
  workspaceRegistryFile,
} from './session-store.js'

/** Base path of this plugin's JSON surface. */
const ROUTE_PREFIX = '/api2/session-delete-trash'

/** Operations mounted, one exact route each. */
const OPERATIONS = ['inspect', 'delete']

/** One request body carries one id; anything larger is a malformed caller. */
const MAX_BODY_BYTES = 64 * 1024

/** Hostnames that are always trusted (the Web UI binds loopback). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/** Additional trusted hostnames, comma-separated, for a proxied deployment. */
const TRUSTED_HOSTS_ENV = 'DSH_SESSION_DELETE_TRUSTED_HOSTS'

/** Plugin name reported to the Loader. */
export const name = 'session-delete'

/**
 * Hostname part of an HTTP authority, with an IPv6 literal kept bracketed.
 * @param authority - the raw `Host` header value.
 * @returns the lowercased hostname.
 */
function hostnameOf(authority) {
  const value = String(authority ?? '').trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end >= 0 ? value.slice(0, end + 1) : value
  }
  const colon = value.lastIndexOf(':')
  return colon >= 0 ? value.slice(0, colon) : value
}

/**
 * Whether a request is locally addressed.
 * @param req - the incoming request.
 * @param env - environment mapping read for the trusted-host list.
 * @returns true when the request is allowed to drive a mutation.
 */
function isTrustedRequest(req, env = process.env) {
  const host = hostnameOf(req?.headers?.host)
  if (LOOPBACK_HOSTNAMES.has(host)) return true
  const extra = String(env?.[TRUSTED_HOSTS_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  return extra.includes(host)
}

/**
 * Read and parse one bounded JSON object body.
 * @param req - the incoming request.
 * @returns the parsed object.
 * @throws when the body is not one JSON object within the byte budget.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be one JSON object')
  }
  return parsed
}

/**
 * Validate the caller-supplied id before it reaches a path join.
 * @param body - the parsed request body.
 * @returns the validated session id.
 * @throws when the id is absent or not a legal session id.
 */
function requireSessionId(body) {
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('sessionId must be a session id')
  }
  return sessionId
}

/**
 * Whether this process holds a live Agent for the session.
 * @param ctx - Host plugin context.
 * @param sessionId - the session to test.
 * @returns true while that Agent reports `running`.
 */
function isRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  const agent = agents === undefined ? undefined : agents.get(sessionId)
  return agent !== undefined && agent !== null && agent.status === 'running'
}

/**
 * Whether this process holds the Session object itself.
 *
 * Reported, never refused: an attached-but-idle session can be deleted safely
 * (its in-memory copy is released at the next Host restart).
 * @param ctx - Host plugin context.
 * @param sessionId - the session to test.
 * @returns true when a Session instance is attached in this process.
 */
function isAttached(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  return sessions !== undefined && sessions.get(sessionId) !== undefined
}

/**
 * Drop one session id from the Workspace registry through its own service.
 *
 * Preferred over editing the registry document, because the service owns the
 * in-memory projection: unpin, unarchive, and per-workspace detach all keep
 * memory and disk in step, so the sidebar cannot render an account slot this
 * plugin left behind. Every call is idempotent, and an absent service is not
 * an error (the caller then falls back to the document).
 * @param ctx - Host plugin context.
 * @param sessionId - the session id to drop.
 * @returns whether the registry service performed the prune.
 */
async function pruneRegistryThroughService(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  let pruned = true
  try {
    await registry.unpinSession(sessionId)
    await registry.unarchiveSession(sessionId)
    for (const workspace of registry.list()) {
      if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
    }
  } catch (error) {
    ctx.logger?.warn?.(new Error(`session-delete-trash: workspace registry prune failed: ${String(error)}`))
    pruned = false
  }
  return pruned
}

/**
 * Whether the registry document still names one session id.
 *
 * Guards the case where the service reports success but a concurrent writer
 * restored the id, and the case where the registry service exists while the
 * document on disk is a different generation.
 * @param home - the Harness home.
 * @param sessionId - the session id to look for.
 * @returns true when the document must still be pruned.
 */
async function documentNamesSession(home, sessionId) {
  let text
  try {
    text = await readFile(workspaceRegistryFile(home), 'utf8')
  } catch {
    return false
  }
  if (!text.includes(sessionId)) return false
  try {
    const state = JSON.parse(text)
    const global = state?.global
    if (Array.isArray(global?.pinnedSessionIds) && global.pinnedSessionIds.includes(sessionId)) return true
    if (Array.isArray(global?.archivedSessionIds) && global.archivedSessionIds.includes(sessionId)) return true
    const workspaces = state?.tables?.workspaces
    if (workspaces !== null && typeof workspaces === 'object') {
      for (const record of Object.values(workspaces)) {
        if (Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)) return true
      }
    }
  } catch {
    return false
  }
  return false
}

/**
 * Tell the browser this Conversation left the Session list.
 *
 * `api-session/removed` is on the forwarded-event allowlist and is already
 * consumed by the Client Session store to drop a row, so emitting it is the
 * same signal a disposed Session produces — without claiming an Agent
 * capability this plugin does not own. A listener failure is contained: the
 * storage is already gone.
 * @param ctx - Host plugin context.
 * @param sessionId - the removed session.
 */
function announceRemoval(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    ctx.logger?.warn?.(new Error(`session-delete-trash: api-session/removed listener failed: ${String(error)}`))
  }
}

/**
 * Offer every other plugin the chance to forget a Conversation it recorded.
 *
 * A nickname, an edge, or a rule that survives in another plugin's state file
 * would keep the conversation alive after its row disappeared. Host-local
 * only (the event is not on the forwarded allowlist), and failures are
 * contained: the filesystem half of the deletion already landed.
 * @param ctx - Host plugin context.
 * @param sessionId - the removed session.
 */
function announceConversationDeleted(ctx, sessionId) {
  try {
    ctx.emit('conversation/deleted', sessionId)
  } catch (error) {
    ctx.logger?.warn?.(new Error(`session-delete-trash: conversation/deleted listener failed: ${String(error)}`))
  }
}

/**
 * Build the handler for one operation.
 * @param ctx - Host plugin context.
 * @param op - the operation this route answers.
 * @returns an HTTP handler.
 */
function createHandler(ctx, op) {
  return async (req, res) => {
    /** Answer one request with a JSON envelope. */
    const respond = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      if ((req.method ?? '') !== 'POST') {
        respond(405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
        return
      }
      if (!String(req.headers?.['content-type'] ?? '').toLowerCase().includes('application/json')) {
        respond(415, { ok: false, error: { code: 'unsupported-media-type', message: 'application/json required' } })
        return
      }
      if (!isTrustedRequest(req)) {
        respond(403, { ok: false, error: { code: 'forbidden', message: 'untrusted request' } })
        return
      }
      const body = await readJsonBody(req)
      const sessionId = requireSessionId(body)
      const home = resolveHome(ctx)
      const attached = isAttached(ctx, sessionId)
      const running = isRunning(ctx, sessionId)
      if (op === 'inspect') {
        const report = await inspectSession(home, sessionId)
        respond(200, { ok: true, value: { sessionId, attached, running, ...report } })
        return
      }
      if (running) {
        respond(409, {
          ok: false,
          error: {
            code: 'session-running',
            message: `session "${sessionId}" is running a turn in this process`,
            sessionId,
          },
        })
        return
      }
      const servicePruned = await pruneRegistryThroughService(ctx, sessionId)
      const stillReferenced = servicePruned ? await documentNamesSession(home, sessionId) : true
      const report = await removeSession(home, sessionId, { pruneDocument: stillReferenced })
      announceConversationDeleted(ctx, sessionId)
      announceRemoval(ctx, sessionId)
      respond(200, {
        ok: true,
        value: {
          sessionId,
          attached,
          ...report,
          registry: { ...report.registry, service: servicePruned },
          missing: report.directories.length === 0,
        },
      })
    } catch (error) {
      respond(400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/**
 * Mount the JSON surface once a Web server exists.
 *
 * `webServer` is optional: a headless profile has none, and the plugin then
 * loads as a no-op instead of staying PENDING forever.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = OPERATIONS.map((op) => webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/${op}`,
        handler: createHandler(webCtx, op),
      }))
      return () => { for (const dispose of disposers) dispose() }
    }, 'session-delete-trash: routes')
  })
}
