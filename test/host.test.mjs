/**
 * Host-half tests: the trust fences, the running-session refusal, the
 * registry-service path, the Trash move, and the deletion broadcast — all
 * against a fake Cordis context and fake `req`/`res` objects, so no Harness is
 * required.
 *
 * The Trash directory is redirected to a temp directory for the whole file, so
 * a test run never touches the machine's real Trash.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

import { apply } from '../index.js'
import { TRASH_DIR_ENV } from '../session-store.js'

const SESSION_ID = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_ID = 'session-99999999-0000-0000-0000-000000000000'

/** The redirected Trash directory for this file. */
let trashDir

before(async () => {
  trashDir = await mkdtemp(join(tmpdir(), 'dsh-session-delete-trash-'))
  process.env[TRASH_DIR_ENV] = trashDir
})

after(async () => {
  delete process.env[TRASH_DIR_ENV]
  await rm(trashDir, { recursive: true, force: true })
})

/** One recorded route registration. */
function routesOf() {
  const routes = new Map()
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  }
  return { routes, webServer }
}

/** Run `apply` against a fake Host and return everything it touched. */
function mountHost({ agents, sessions, registry, home }) {
  const { routes, webServer } = routesOf()
  const emitted = []
  const effects = []
  const base = {
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'agents') return agents
      if (name === 'sessions') return sessions
      if (name === 'workspaceRegistry') return registry
      if (name === 'dshHomePath') return home === undefined ? undefined : () => home
      return undefined
    },
    emit(event, ...args) { emitted.push([event, ...args]) },
    logger: { warn() {} },
    effect(fn, label) { effects.push({ label, dispose: fn() }) },
  }
  const ctx = {
    ...base,
    inject(names, callback) {
      // Cordis publishes an injected service as a property on the injecting
      // context as well as through `get`, so the fake carries both.
      const injected = { ...base, get: (name) => base.get(name) }
      for (const name of names) injected[name] = base.get(name)
      callback(injected)
    },
  }
  apply(ctx)
  return { routes, emitted, effects, dispose: () => { for (const effect of effects) effect.dispose?.() } }
}

/** A fake `req` that streams one JSON body. */
function request({ method = 'POST', contentType = 'application/json', host = '127.0.0.1:19387', body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers: { 'content-type': contentType, host },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** A fake `res` capturing status and body. */
function response() {
  return {
    status: undefined,
    headers: undefined,
    payload: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(text) { this.payload = text === undefined ? undefined : JSON.parse(text) },
  }
}

/** A Harness home holding one session log, cache row, and registry document. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-host-'))
  const log = join(home, 'sessions', '--project--', SESSION_ID)
  await mkdir(log, { recursive: true })
  await writeFile(join(log, 'session.v4.jsonl.zstd'), Buffer.alloc(512, 3))
  const cache = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `${SESSION_ID}.json`), '{"ver":1}')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { workspaceIds: ['ws-1'], archivedSessionIds: [SESSION_ID], pinnedSessionIds: [SESSION_ID] },
    tables: { workspaces: { 'ws-1': { path: '/tmp/project', sessionIds: [SESSION_ID, OTHER_ID] } } },
  }, null, 2))
  return home
}

/** A registry stub shaped like the real `workspaceRegistry` service. */
function registryStub(calls) {
  const entity = {
    sessionIds: [SESSION_ID, OTHER_ID],
    async detachSession(id) { calls.push(['detach', id]); this.sessionIds = this.sessionIds.filter((entry) => entry !== id) },
  }
  return {
    async unpinSession(id) { calls.push(['unpin', id]) },
    async unarchiveSession(id) { calls.push(['unarchive', id]) },
    list() { return [entity] },
  }
}

test('mounts exactly its own two routes under its own prefix', () => {
  const host = mountHost({})
  assert.deepEqual([...host.routes.keys()].sort(), [
    '/api2/session-delete-trash/delete',
    '/api2/session-delete-trash/inspect',
  ])
  for (const route of host.routes.values()) assert.equal(route.kind, 'exact')
})

test('a headless profile (no webServer) loads as a no-op', () => {
  const ctx = { inject: () => {}, get: () => undefined, emit: () => {}, logger: { warn() {} }, effect: () => {} }
  assert.doesNotThrow(() => { apply(ctx) })
})

test('rejects a non-POST, a non-JSON content type, and a foreign Host', async () => {
  const host = mountHost({})
  const handler = host.routes.get('/api2/session-delete-trash/delete').handler

  const wrongMethod = response()
  await handler(request({ method: 'GET', body: { sessionId: SESSION_ID } }), wrongMethod)
  assert.equal(wrongMethod.status, 405)

  const wrongType = response()
  await handler(request({ contentType: 'text/plain', body: { sessionId: SESSION_ID } }), wrongType)
  assert.equal(wrongType.status, 415)

  const foreignHost = response()
  await handler(request({ host: 'evil.example.com', body: { sessionId: SESSION_ID } }), foreignHost)
  assert.equal(foreignHost.status, 403)

  const badId = response()
  await handler(request({ body: { sessionId: '../../etc/passwd' } }), badId)
  assert.equal(badId.status, 400)
  assert.equal(badId.payload.error.code, 'bad-request')

  const oversized = response()
  await handler(request({ body: { sessionId: SESSION_ID, pad: 'x'.repeat(70 * 1024) } }), oversized)
  assert.equal(oversized.status, 400)
})

test('refuses a running conversation and leaves its storage alone', async () => {
  const home = await fixture()
  try {
    const host = mountHost({
      home,
      agents: { get: (id) => (id === SESSION_ID ? { status: 'running' } : undefined) },
    })
    const res = response()
    await host.routes.get('/api2/session-delete-trash/delete').handler(
      request({ body: { sessionId: SESSION_ID } }),
      res,
    )
    assert.equal(res.status, 409)
    assert.equal(res.payload.error.code, 'session-running')
    await readFile(join(home, 'sessions', '--project--', SESSION_ID, 'session.v4.jsonl.zstd'))
    assert.equal(host.emitted.length, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('moves the log to the Trash, prunes through the service, and announces the removal', async () => {
  const home = await fixture()
  try {
    const calls = []
    const host = mountHost({
      home,
      registry: registryStub(calls),
      sessions: { get: () => undefined },
      agents: { get: () => ({ status: 'idle' }) },
    })
    const res = response()
    await host.routes.get('/api2/session-delete-trash/delete').handler(
      request({ body: { sessionId: SESSION_ID } }),
      res,
    )
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.value.freedBytes, 512)
    assert.equal(res.payload.value.missing, false)
    assert.equal(res.payload.value.registry.service, true)
    assert.deepEqual(calls, [['unpin', SESSION_ID], ['unarchive', SESSION_ID], ['detach', SESSION_ID]])
    assert.deepEqual(host.emitted, [['conversation/deleted', SESSION_ID], ['api-session/removed', SESSION_ID]])

    // The log is gone from the Harness tree and present in the Trash.
    assert.equal(res.payload.value.trashDir, trashDir)
    assert.equal(res.payload.value.trashed.length, 1)
    await assert.rejects(stat(join(home, 'sessions', '--project--', SESSION_ID)))
    assert.equal((await stat(res.payload.value.trashed[0].to)).isDirectory(), true)
    assert.equal(await readFile(join(res.payload.value.trashed[0].to, 'session.v4.jsonl.zstd')).then((buf) => buf.length), 512)
    assert.equal(typeof res.payload.value.cacheTrashed, 'string')

    // The document is pruned even when the service already did the work, because
    // a service-side prune only guarantees the in-memory generation.
    const state = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(state.global.pinnedSessionIds, [])
    assert.deepEqual(state.global.archivedSessionIds, [])
    assert.deepEqual(state.tables.workspaces['ws-1'].sessionIds, [OTHER_ID])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a registry whose service throws falls back to the document', async () => {
  const home = await fixture()
  try {
    const host = mountHost({
      home,
      registry: {
        async unpinSession() { throw new Error('registry unavailable') },
        async unarchiveSession() {},
        list() { return [] },
      },
    })
    const res = response()
    await host.routes.get('/api2/session-delete-trash/delete').handler(
      request({ body: { sessionId: SESSION_ID } }),
      res,
    )
    assert.equal(res.status, 200)
    assert.equal(res.payload.value.registry.service, false)
    assert.equal(res.payload.value.registry.pruned, true)
    const state = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(state.tables.workspaces['ws-1'].sessionIds, [OTHER_ID])
    assert.deepEqual(host.emitted, [['conversation/deleted', SESSION_ID], ['api-session/removed', SESSION_ID]])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a row whose storage is already gone still converges the list', async () => {
  const home = await fixture()
  try {
    const host = mountHost({ home })
    const res = response()
    await host.routes.get('/api2/session-delete-trash/delete').handler(
      request({ body: { sessionId: 'session-00000000-0000-0000-0000-000000000000' } }),
      res,
    )
    assert.equal(res.status, 200)
    assert.equal(res.payload.value.missing, true)
    assert.equal(res.payload.value.freedBytes, 0)
    assert.deepEqual(res.payload.value.trashed, [])
    assert.deepEqual(host.emitted, [
      ['conversation/deleted', 'session-00000000-0000-0000-0000-000000000000'],
      ['api-session/removed', 'session-00000000-0000-0000-0000-000000000000'],
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('inspect reports the size without changing anything', async () => {
  const home = await fixture()
  try {
    const host = mountHost({ home, sessions: { get: () => ({}) } })
    const res = response()
    await host.routes.get('/api2/session-delete-trash/inspect').handler(
      request({ body: { sessionId: SESSION_ID } }),
      res,
    )
    assert.equal(res.status, 200)
    assert.equal(res.payload.value.exists, true)
    assert.equal(res.payload.value.sizeBytes, 512)
    assert.equal(res.payload.value.attached, true)
    assert.equal(res.payload.value.running, false)
    assert.equal(host.emitted.length, 0)
    await readFile(join(home, 'sessions', '--project--', SESSION_ID, 'session.v4.jsonl.zstd'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a Host that closes its fiber unregisters both routes', () => {
  const host = mountHost({})
  assert.equal(host.routes.size, 2)
  host.dispose()
  assert.equal(host.routes.size, 0)
})
