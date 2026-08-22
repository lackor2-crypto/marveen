// The bridge could always DISPATCH. What it could not do was tell anyone that
// its executor had stopped -- and that is the only way it fails silently: tasks
// queue up, every page stays green, and nothing anywhere says the Windows
// worker died. (Measured 2026-08-22: it had been down since 08-20 19:47 and the
// only trace was an empty project list.)
//
// These tests pin the presence signal, the self-check row it feeds, and the
// settings surface that makes the bridge operable from a fresh install without
// a terminal.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask,
  recordCodeWorkerSeen, listCodeWorkers, codeBridgeHealth, WORKER_STALE_MS,
} from '../web/code-bridge-store.js'
import { codeBridgeRows } from '../web/system-health.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingDefinition } from '../config-registry.js'

const WS = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('worker presence', () => {
  it('a worker that reports ZERO sessions still counts as alive', () => {
    // This exact state -- running, finding nothing dispatchable -- is what the
    // machine was in on 2026-08-20. Calling it dead would send the owner
    // chasing the wrong problem.
    recordCodeWorkerSeen('DESKTOP-X', 'discovery', 0)
    const h = codeBridgeHealth()
    expect(h.workerOnline).toBe(true)
    expect(h.sessions).toBe(0)
    expect(h.workers[0]!.sessionsReported).toBe(0)
  })

  it('goes offline once nothing has checked in for the stale window', () => {
    const now = Date.now()
    recordCodeWorkerSeen('DESKTOP-X', 'claim', 3, now - WORKER_STALE_MS - 1000)
    expect(codeBridgeHealth(now).workerOnline).toBe(false)
    recordCodeWorkerSeen('DESKTOP-X', 'claim', 3, now)
    expect(codeBridgeHealth(now).workerOnline).toBe(true)
  })

  it('a heartbeat refreshes the stamp without erasing the session count', () => {
    // Heartbeats carry no session count. If the UPSERT wrote NULL over it, the
    // page would lose the one number that distinguishes 'nothing to do' from
    // 'nothing found'.
    recordCodeWorkerSeen('DESKTOP-X', 'discovery', 3)
    recordCodeWorkerSeen('DESKTOP-X', 'heartbeat')
    const w = listCodeWorkers()[0]!
    expect(w.lastAction).toBe('heartbeat')
    expect(w.sessionsReported).toBe(3)
  })

  it('counts the queue so the alarm can say how much is stuck behind it', () => {
    upsertCodeSession(WS)
    enqueueCodeTask({ project: 'marvin', prompt: 'x', origin: 'api' })
    enqueueCodeTask({ project: 'marvin', prompt: 'y', origin: 'api' })
    expect(codeBridgeHealth().queued).toBe(2)
  })
})

describe('self-check row', () => {
  const health = (over: Partial<ReturnType<typeof codeBridgeHealth>>) => ({
    workerOnline: true, lastSeenAt: Date.now(), workers: [], sessions: 1,
    queued: 0, running: 0, failed24h: 0, done24h: 0, ...over,
  }) as ReturnType<typeof codeBridgeHealth>

  it('stays SILENT on an install where nobody ever set the bridge up', () => {
    // A feature that was never switched on is not a fault, and a fresh install
    // must not open on a red row about something the owner never started.
    expect(codeBridgeRows(Date.now(), health({ lastSeenAt: null, sessions: 0 }))).toEqual([])
  })

  it('shouts when a task is waiting and no executor ever appeared', () => {
    const rows = codeBridgeRows(Date.now(), health({ lastSeenAt: null, sessions: 0, queued: 1 }))
    expect(rows[0]!.id).toBe('code_bridge_never')
    expect(rows[0]!.status).toBe('bad')
    expect(rows[0]!.params!['n']).toBe(1)
  })

  it('shouts when the executor stops, and says how long and how much is stuck', () => {
    const now = Date.now()
    const rows = codeBridgeRows(now, health({ lastSeenAt: now - 40 * 60 * 1000, queued: 2, running: 1 }))
    expect(rows[0]!.id).toBe('code_bridge_dead')
    expect(rows[0]!.status).toBe('bad')
    expect(rows[0]!.params!['p']).toBe(40)
    expect(rows[0]!.params!['n']).toBe(3)
  })

  it('says it out loud when everything is fine', () => {
    // Silence here would be indistinguishable from the check not running --
    // which is exactly the shape of the bug this whole row exists to catch.
    const rows = codeBridgeRows(Date.now(), health({ sessions: 3 }))
    expect(rows[0]!.id).toBe('code_bridge_ok')
    expect(rows[0]!.status).toBe('ok')
    expect(rows[0]!.params!['n']).toBe(3)
  })

  it('every row id it can emit has both a label and an advice line, in both languages', () => {
    const ids = ['code_bridge_never', 'code_bridge_dead', 'code_bridge_ok']
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(process.cwd(), 'web', 'lang', lang + '.js'), 'utf8')
      for (const id of ids) {
        expect(src, lang + ' missing health.' + id).toContain("'health." + id + "'")
        expect(src, lang + ' missing health.' + id + '_action').toContain("'health." + id + "_action'")
      }
    }
  })

  it('the overview renderer actually draws the green row and links the red one', () => {
    const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
    expect(app).toContain("health.find(h => h.id === 'code_bridge_ok')")
    expect(app).toContain("h.id === 'code_bridge_dead' || h.id === 'code_bridge_never'")
  })
})

describe('operable from the dashboard alone', () => {
  it('every setting the bridge runs on is editable from the Settings page', () => {
    // The registry IS the settings page. A key missing from it can only be
    // changed by hand-editing a file on the server -- which is the thing a
    // fresh install cannot do.
    for (const key of ['CODE_BRIDGE_ENABLED', 'CODE_PERMISSION_MODE', 'CODE_BOT_TOKEN', 'CODE_BOT_ALLOWED_CHAT_IDS', 'CODE_BRIDGE_EXCLUDE']) {
      expect(getSettingDefinition(key), 'missing from settings registry: ' + key).toBeTruthy()
    }
  })

  it('the bot token is marked secret, so it is never echoed back to a browser', () => {
    expect(getSettingDefinition('CODE_BOT_TOKEN')!.secret).toBe(true)
  })

  it('the health/config surface answers even while the bridge is switched OFF', () => {
    // Otherwise flipping the switch in the UI locks you out of the only page
    // that can flip it back.
    const route = readFileSync(join(process.cwd(), 'src', 'web', 'routes', 'code.ts'), 'utf8')
    expect(route).toMatch(/const alwaysOn = [^\n]*\/api\/code\/health/)
    expect(route).toContain('if (!CODE_BRIDGE_ENABLED && !alwaysOn)')
  })

  it('an untouched password field cannot wipe a configured token', () => {
    const route = readFileSync(join(process.cwd(), 'src', 'web', 'routes', 'code.ts'), 'utf8')
    expect(route).toContain("if (key === 'CODE_BOT_TOKEN' && raw === '') continue")
  })

  it('the worker download cannot be turned into an arbitrary file read', () => {
    // It sits behind the dashboard token, but a path parameter here would still
    // hand out any file on the server to anyone who has that token.
    const route = readFileSync(join(process.cwd(), 'src', 'web', 'routes', 'code.ts'), 'utf8')
    expect(route).toContain("const which = url.searchParams.get('file') === 'cmd' ? 'cmd' : 'ps1'")
    // A ket megengedett fajlnev LITERAL a forrasban, es a query parameter csak
    // kozottuk valaszt -- sehol nem kerul bele magaba az utvonalba.
    expect(route).toContain("const name = which === 'cmd' ? 'marvin-code-worker.cmd' : 'marvin-code-worker.ps1'")
    const joinLine = /join\(PROJECT_ROOT, 'scripts', 'windows', ([^)]+)\)/.exec(route)
    expect(joinLine, 'the worker-script join() moved or changed shape').toBeTruthy()
    expect(joinLine![1]).toBe('name')
    expect(route).not.toMatch(/join\([^)]*searchParams/)
  })

  it('the Kod-hid is reachable from the VS Code card, not from a menu of its own', () => {
    // Boss, 2026-08-22: "miert kivetelezunk vele? mindenki alapbol is ott
    // keresne". Minden mas ugynok beallitasa a sajat kartyajarol nyilik --
    // egy kulon menupont a bal oldalon pont azt teszi megtalalhatatlanna,
    // amit mindenki a kartya alatt keres.
    const html = readFileSync(join(process.cwd(), 'web', 'index.html'), 'utf8')
    const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
    expect(html).toContain('id="cbOverlay"')
    expect(html).toContain('id="cbModalBody"')
    expect(html).not.toContain('data-page="codeBridge"')
    expect(app).toContain("callPageLoader('loadCodeBridgePage')")
    // A regi mely-hivatkozasok (#codeBridge hash, onellenorzes-sorok) sem
    // vezethetnek ures lapra.
    expect(app).toContain("if (pageId === 'codeBridge') { switchPage('agents'); openCodeBridgeModal(); return }")
  })

  it('closing the window stops the poll', () => {
    // Amig lap volt, a switchPage allitotta le. Ablaknal a bezaras az egyetlen
    // pont, ahol ez megtortenhet -- enelkul a 5 masodperces kor orokre futna.
    const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
    expect(app).toContain('const close = () => { closeModal(overlay); _cbStopPoll() }')
  })

  it('the poll stops when you leave the page, and the shim cannot call itself', () => {
    // A top-level 'function _cbStopPoll()' IS window._cbStopPoll in a classic
    // script; if the IIFE overwrote that same property the shim would recurse
    // forever the first time switchPage ran before the IIFE was reached.
    const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
    expect(app).toContain('window.__cbStopPollImpl = function ()')
    expect(app).toContain("if (typeof window.__cbStopPollImpl === 'function') window.__cbStopPollImpl()")
  })

  it('the worker scripts the page hands out are actually present in the checkout', () => {
    for (const name of ['marvin-code-worker.ps1', 'marvin-code-worker.cmd']) {
      const text = readFileSync(join(process.cwd(), 'scripts', 'windows', name), 'utf8')
      expect(text.length).toBeGreaterThan(500)
    }
  })

  it('no GUI automation anywhere in the executor', () => {
    // The spec forbids it outright: no AutoHotKey, no keystrokes, no clipboard,
    // no window focus. This is the test that keeps a 'quick fix' from
    // reintroducing it later.
    const ps1 = readFileSync(join(process.cwd(), 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    for (const banned of ['SendKeys', 'AutoHotkey', 'AutoHotKey', 'SetForegroundWindow', 'Set-Clipboard', 'AppActivate']) {
      expect(ps1, 'GUI automation found: ' + banned).not.toContain(banned)
    }
  })
})
