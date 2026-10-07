/**
 * Browser-half tests.
 *
 * The module is a Module Loader package, so it is loaded here through a fake
 * `window.__ModuleLoader__` with a fake `require`: React becomes a minimal
 * element factory (`createElement` records type/props/children) and the
 * primitives become named stubs. That exercises the real registrations, the
 * real store wiring, and the real Host-call protocol without a browser.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const SESSION_ID = 'session-12345678-9abc-def0-1234-56789abcdef0'

/** Shipped slot ids this plugin must never shadow. */
const SHIPPED_IDS = {
  'sidebar.workspaces.session.menu.item': ['pin', 'rename', 'fork', 'archive'],
  'sidebar.workspaces.session.row.action': ['archive', 'pin'],
}

/** Minimal React stand-in: hooks read state once, createElement records a tree. */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      void subscribe
      return getSnapshot()
    },
    useState(initial) {
      return [initial, () => {}]
    },
    useCallback(fn) {
      return fn
    },
  }
}

/** Named primitives stand-in; every component is its own sentinel. */
function fakePrimitives() {
  const names = [
    'Button', 'IconTrashOutlineRegular', 'MenuItemButton', 'Modal', 'RiskConfirmation', 'Tooltip',
  ]
  const primitives = {}
  for (const name of names) primitives[name] = { componentName: name }
  return primitives
}

/** Import counter: one fresh module instance per test, since ESM caches. */
let importCounter = 0

/** Load the browser half and return its factory result. */
async function loadClient() {
  const react = fakeReact()
  const primitives = fakePrimitives()
  let spec
  globalThis.window = { __ModuleLoader__: { load(value) { spec = value } } }
  await import(`../client.js?case=${importCounter += 1}`)
  assert.equal(spec.id, 'dsh-session-delete')
  const required = []
  const mod = spec.factory((id) => {
    required.push(id)
    if (id === 'react') return react
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require(${id})`)
  })
  return { mod, react, primitives, required }
}

/** A fake client Cordis context capturing every registration. */
function fakeContext({ uiWorkspace } = {}) {
  const slots = []
  const localeRegistrations = []
  const injected = []
  const effects = []
  const ctx = {
    get(name) {
      return name === 'uiWorkspace' ? uiWorkspace : undefined
    },
    effect(fn, label) {
      effects.push(label)
      const disposer = fn()
      return () => { disposer?.() }
    },
    locale: {
      register(namespace, dictionaries) { localeRegistrations.push({ namespace, dictionaries }) },
    },
    slots: {
      inject(name, factory) {
        injected.push(name)
        return factory()
      },
      register(spec, component) {
        slots.push({ spec, component })
        return () => {}
      },
    },
  }
  return { ctx, slots, localeRegistrations, injected, effects }
}

test('the half loads, injects only slots and locale, and registers three seats', async () => {
  const { mod, injected } = await loadClient()
  assert.deepEqual(mod.inject, ['slots', 'locale'])

  const made = fakeContext()
  mod.apply(made.ctx)

  assert.deepEqual(made.injected, [
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.row.action',
    'shell.overlay',
  ])
  assert.deepEqual(made.slots.map((entry) => entry.spec.id), [
    'session-delete.menu',
    'session-delete.row',
    'session-delete.confirm',
  ])
  assert.deepEqual(made.slots.map((entry) => entry.spec.name), made.injected)

  // The menu row lands after the shipped Archive row (order 400); the hover
  // button lands after the shipped Pin button (order 200).
  assert.equal(made.slots[0].spec.order, 500)
  assert.equal(made.slots[1].spec.order, 300)
  assert.equal(made.slots[0].spec.locale, 'dsh-session-delete')

  // No shipped id is reused, so nothing existing is shadowed.
  for (const entry of made.slots.slice(0, 2)) {
    assert.equal(SHIPPED_IDS[entry.spec.name].includes(entry.spec.id), false)
  }
  assert.equal(made.slots[2].spec.name, 'shell.overlay')
  assert.equal(typeof made.slots[2].spec.inject, 'function')
})

test('the dictionaries carry the same keys in both languages', async () => {
  const { mod } = await loadClient()
  const made = fakeContext()
  mod.apply(made.ctx)
  assert.equal(made.localeRegistrations.length, 1)
  const { namespace, dictionaries } = made.localeRegistrations[0]
  assert.equal(namespace, 'dsh-session-delete')
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  for (const value of Object.values(dictionaries.zh)) assert.equal(typeof value, 'string')
  for (const value of Object.values(dictionaries.en)) assert.equal(typeof value, 'string')
  assert.equal(made.effects.includes('dsh-session-delete: dictionaries'), true)
})

test('the menu row is a destructive MenuItemButton that opens the confirmation', async () => {
  const { mod, primitives, react } = await loadClient()
  const made = fakeContext()
  mod.apply(made.ctx)
  const t = (key, values) => `${key}${values === undefined ? '' : JSON.stringify(values)}`
  const component = made.slots[0].component

  let menuOpen = true
  const element = component({
    sessionId: SESSION_ID,
    displayTitle: 'My conversation',
    useMenuOpenState: () => [menuOpen, (open) => { menuOpen = open }],
    t,
  })
  assert.equal(element.type, primitives.MenuItemButton)
  assert.equal(element.props.danger, true)
  assert.equal(element.props.separatorBefore, true)
  assert.equal(element.children[0], 'menu.delete')

  element.props.onSelect()
  assert.equal(menuOpen, false, 'selecting the row must close the menu')

  // The overlay now renders the irreversible confirmation for that row.
  const overlay = made.slots[2].component
  const injected = made.slots[2].spec.inject()
  void react
  const dialog = overlay({ t, ...injected })
  assert.equal(dialog.type, primitives.RiskConfirmation)
  assert.equal(dialog.props.acknowledged, false)
  assert.match(dialog.props.description, /My conversation/)
  assert.equal(dialog.props.disabled, false)
})

test('the hover action is one tooltip-wrapped icon button that opens the same dialog', async () => {
  const { mod, primitives } = await loadClient()
  const made = fakeContext()
  mod.apply(made.ctx)
  const t = (key) => key
  const component = made.slots[1].component
  const element = component({ sessionId: SESSION_ID, displayTitle: 'x', t })
  assert.equal(element.type, primitives.Tooltip)
  const button = element.children[0]
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-label'], 'menu.delete')
  assert.equal(typeof button.props.onClick, 'function')
})

test('confirming deletes through the Host route and forgets the open selection', async () => {
  const { mod, primitives } = await loadClient()
  const cleared = []
  const uiWorkspace = {
    selection: { getSnapshot: () => ({ sessionId: SESSION_ID }) },
    clearMain: () => { cleared.push(SESSION_ID) },
  }
  const made = fakeContext({ uiWorkspace })
  mod.apply(made.ctx)
  const t = (key, values) => `${key}${values === undefined ? '' : JSON.stringify(values)}`
  const injected = made.slots[2].spec.inject()

  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (String(url).endsWith('/inspect')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { sessionId: SESSION_ID, exists: true, sizeBytes: 2048, directories: [] } }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessionId: SESSION_ID,
          freedBytes: 2048,
          missing: false,
          trashDir: '/Users/someone/.Trash',
          trashed: [{ from: '/Users/someone/.dsh/sessions/--x--/session', to: '/Users/someone/.Trash/session-123 20261008-012345' }],
        },
      }),
    }
  }

  made.slots[0].component({ sessionId: SESSION_ID, displayTitle: 'gone', useMenuOpenState: () => [true, () => {}], t }).props.onSelect()
  await new Promise((resolve) => setImmediate(resolve))

  const dialog = made.slots[2].component({ t, ...injected })
  assert.equal(dialog.type, primitives.RiskConfirmation)
  // The probe landed and named the size.
  assert.match(dialog.props.description, /2\.0 KB/)

  dialog.props.onAcknowledgedChange(true)
  const acknowledged = made.slots[2].component({ t, ...injected })
  assert.equal(acknowledged.props.acknowledged, true)

  acknowledged.props.onConfirm()
  await new Promise((resolve) => setImmediate(resolve))

  const del = calls.find((call) => String(call.url).endsWith('/delete'))
  assert.ok(del, 'the delete route must be called')
  assert.equal(del.init.method, 'POST')
  assert.equal(del.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(del.init.body), { sessionId: SESSION_ID })

  assert.deepEqual(cleared, [SESSION_ID], 'the main view must be released for the deleted session')

  const done = made.slots[2].component({ t, ...injected })
  assert.equal(done.type, primitives.Modal, 'the success report names where the bytes went')
  assert.equal(done.props.title, 'done.title')
  assert.match(done.props.description, /Users\/someone\/\.Trash\/session-123 20261008-012345/)
  done.props.onClose()
  assert.equal(made.slots[2].component({ t, ...injected }), null, 'closing the report ends the flow')
})

test('a refused delete keeps the dialog open with the Host sentence', async () => {
  const { mod, primitives } = await loadClient()
  const made = fakeContext()
  mod.apply(made.ctx)
  const t = (key, values) => `${key}${values === undefined ? '' : JSON.stringify(values)}`
  const injected = made.slots[2].spec.inject()

  globalThis.fetch = async (url) => (String(url).endsWith('/inspect')
    ? { ok: true, status: 200, json: async () => ({ ok: true, value: { sessionId: SESSION_ID, exists: false, sizeBytes: 0, directories: [] } }) }
    : { ok: false, status: 409, json: async () => ({ ok: false, error: { code: 'session-running', message: 'session is running' } }) })

  made.slots[1].component({ sessionId: SESSION_ID, displayTitle: 'busy', t }).children[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const dialog = made.slots[2].component({ t, ...injected })
  assert.match(dialog.props.description, /confirm\.missing/)

  dialog.props.onConfirm()
  await new Promise((resolve) => setImmediate(resolve))

  const failed = made.slots[2].component({ t, ...injected })
  assert.equal(failed.type, primitives.Modal)
  assert.equal(failed.props.title, 'confirm.failed')
  assert.equal(failed.props.description, 'confirm.running')
})

test('forgetting a deleted session never closes an unrelated conversation', async () => {
  const { mod } = await loadClient()
  const cleared = []
  const uiWorkspace = {
    selection: { getSnapshot: () => ({ sessionId: 'session-someone-else' }) },
    clearMain: () => { cleared.push('cleared') },
  }
  const made = fakeContext({ uiWorkspace })
  mod.apply(made.ctx)
  made.slots[2].spec.inject().forgetDeletedSession(SESSION_ID)
  assert.deepEqual(cleared, [])

  const withoutService = fakeContext()
  mod.apply(withoutService.ctx)
  assert.doesNotThrow(() => { withoutService.slots[2].spec.inject().forgetDeletedSession(SESSION_ID) })
})
