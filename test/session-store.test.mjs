/**
 * Storage-layer tests: a real temporary Harness home laid out exactly as the
 * persistence backend and the storage-domain JSON backend produce it.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SESSION_ID_PATTERN,
  directorySize,
  encodeSegment,
  inspectSession,
  isInside,
  locateSessionDirs,
  moveToTrash,
  projectionCacheFile,
  pruneWorkspaceDocument,
  removeSession,
  resolveHome,
  trashDirectory,
} from '../session-store.js'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'

/** Build one Harness home with a session log, a cache row, and a registry. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const log = join(home, 'sessions', '--Users-someone-Documents-project--', SESSION_ID)
  await mkdir(log, { recursive: true })
  await writeFile(join(log, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7))
  await writeFile(join(log, 'session.lock'), '')
  const other = join(home, 'sessions', '--Users-someone-Documents-other--', 'session-99999999-0000-0000-0000-000000000000')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, 'session.v4.jsonl.zstd'), Buffer.alloc(16, 1))
  const cache = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `${SESSION_ID}.json`), '{"ver":1}')
  await writeFile(join(cache, 'session-99999999-0000-0000-0000-000000000000.json'), '{"ver":1}')
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-1'],
      archivedSessionIds: [],
      pinnedSessionIds: [SESSION_ID],
      defaultWorkspaceId: 'ws-1',
    },
    tables: {
      workspaces: {
        'ws-1': { path: '/tmp/project', title: 'project', sessionIds: ['session-other', SESSION_ID] },
      },
    },
  }, null, 2))
  return home
}

test('encodeSegment mirrors the persistence backend and cannot escape a directory', () => {
  assert.equal(encodeSegment('session-abc.def'), 'session-abc.def')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a\\b'), 'a~005Cb')
  assert.equal(encodeSegment('~'), '~007E')
  assert.equal(encodeSegment('工作区'), '~5DE5~4F5C~533A')
  assert.ok(!encodeSegment('../../etc/passwd').includes('/'))
})

test('isInside refuses a path that leaves the root', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
})

test('resolveHome prefers the boot service, then DSH_HOME, then the default', () => {
  const ctx = { get: (name) => (name === 'dshHomePath' ? () => '/from/service' : undefined) }
  assert.equal(resolveHome(ctx, { DSH_HOME: '/from/env' }), '/from/service')
  assert.equal(resolveHome({ get: () => undefined }, { DSH_HOME: '/from/env' }), '/from/env')
  assert.match(resolveHome({ get: () => undefined }, {}), /\.dsh$/)
})

test('inspectSession finds a session by scanning project buckets', async () => {
  const home = await fixture()
  try {
    const report = await inspectSession(home, SESSION_ID)
    assert.equal(report.exists, true)
    assert.equal(report.directories.length, 1)
    assert.equal(report.sizeBytes, 2048)
    assert.equal(await directorySize(join(home, 'sessions')), 2048 + 16)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('removeSession trashes only the addressed session', async () => {
  const home = await fixture()
  const trash = join(home, 'test-trash')
  const now = new Date('2026-10-08T01:23:45')
  try {
    const report = await removeSession(home, SESSION_ID, { trashDir: trash, now })
    assert.equal(report.directories.length, 1)
    assert.equal(report.freedBytes, 2048)
    assert.equal(report.trashDir, trash)
    assert.equal(report.trashed.length, 1)
    assert.equal(report.trashed[0].from, report.directories[0])
    assert.equal(report.trashed[0].to, join(trash, `${SESSION_ID} 20261008-012345`))
    assert.equal(typeof report.cacheTrashed, 'string')
    assert.equal(report.registry.pruned, true)
    assert.equal(report.registry.references, 2)

    // Gone from the Harness tree, present in the Trash with its bytes intact.
    await assert.rejects(stat(report.directories[0]))
    await assert.rejects(stat(projectionCacheFile(home, SESSION_ID)))
    assert.equal((await stat(report.trashed[0].to)).isDirectory(), true)
    assert.equal((await stat(join(report.trashed[0].to, 'session.v4.jsonl.zstd'))).size, 2048)
    assert.equal((await stat(report.cacheTrashed)).isFile(), true)

    const state = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    assert.deepEqual(state.global.pinnedSessionIds, [])
    assert.deepEqual(state.tables.workspaces['ws-1'].sessionIds, ['session-other'])

    // The neighbouring session and its cache row are untouched.
    const other = join(home, 'sessions', '--Users-someone-Documents-other--', 'session-99999999-0000-0000-0000-000000000000')
    assert.equal((await stat(other)).isDirectory(), true)
    await stat(join(home, 'storages', 'session_projcache', 'sessions', 'session-99999999-0000-0000-0000-000000000000.json'))

    // Nothing is left for a second pass, and the second pass is not an error.
    const again = await removeSession(home, SESSION_ID, { trashDir: trash, now })
    assert.equal(again.directories.length, 0)
    assert.deepEqual(again.trashed, [])
    assert.equal(again.cacheTrashed, undefined)
    assert.equal(again.registry.reason, 'absent')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('pruneWorkspaceDocument leaves an unrelated document byte-identical', async () => {
  const home = await fixture()
  try {
    const before = await readFile(join(home, 'storages', 'workspace.json'), 'utf8')
    const result = await pruneWorkspaceDocument(home, 'session-not-there')
    assert.deepEqual(result, { pruned: false, reason: 'absent' })
    assert.equal(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('pruneWorkspaceDocument tolerates a missing or unreadable document', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  try {
    assert.deepEqual(await pruneWorkspaceDocument(home, SESSION_ID), { pruned: false, reason: 'missing' })
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages', 'workspace.json'), 'not json')
    assert.deepEqual(await pruneWorkspaceDocument(home, SESSION_ID), { pruned: false, reason: 'unreadable' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('locateSessionDirs returns nothing for a home with no sessions root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  try {
    assert.deepEqual(await locateSessionDirs(home, SESSION_ID), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the Trash directory follows the platform and the environment override', () => {
  assert.equal(trashDirectory('/home', {}, 'darwin'), join(homedir(), '.Trash'))
  assert.equal(trashDirectory('/home', { DSH_SESSION_DELETE_TRASH: '/custom' }, 'darwin'), '/custom')
  assert.equal(trashDirectory('/home', {}, 'linux'), join('/home', 'trash'))
})

test('moveToTrash never overwrites an earlier deletion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const trash = join(home, 'trash')
  const now = new Date('2026-10-08T01:23:45')
  try {
    const first = join(home, 'first')
    await mkdir(first, { recursive: true })
    await writeFile(join(first, 'a'), 'one')
    const second = join(home, 'second')
    await mkdir(second, { recursive: true })
    await writeFile(join(second, 'a'), 'two')

    const one = await moveToTrash(join(first, 'a'), trash, now)
    const two = await moveToTrash(join(second, 'a'), trash, now)
    assert.notEqual(one, two)
    assert.equal(await readFile(one, 'utf8'), 'one')
    assert.equal(await readFile(two, 'utf8'), 'two')

    await assert.rejects(moveToTrash(join(home, 'missing'), trash, now))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('moveToTrash leaves an item already inside the Trash alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const trash = join(home, 'trash')
  try {
    await mkdir(trash, { recursive: true })
    const inside = join(trash, 'already')
    await mkdir(inside)
    assert.equal(await moveToTrash(inside, trash), inside)
    assert.equal(home.length > 0, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the session id pattern admits server ids and refuses path shapers', () => {
  assert.equal(SESSION_ID_PATTERN.test(SESSION_ID), true)
  assert.equal(SESSION_ID_PATTERN.test('a_b.c-d'), true)
  assert.equal(SESSION_ID_PATTERN.test('../etc/passwd'), false)
  assert.equal(SESSION_ID_PATTERN.test('a/b'), false)
  assert.equal(SESSION_ID_PATTERN.test(''), false)
  assert.equal(SESSION_ID_PATTERN.test('-leading'), false)
  assert.equal(SESSION_ID_PATTERN.test('a'.repeat(129)), false)
})
