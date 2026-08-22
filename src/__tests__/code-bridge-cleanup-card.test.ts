// A Csapat lapon eddig SEMMI nem jelezte, hogy letezik a kod-hid: a VS Code
// Claude Code nem tmux-agent, nincs sora az /api/agents valaszaban, ezert a
// kartya-racsbol egyszeruen hianyzott. Az itteni tesztek ket dolgot rognek:
//
//   * a lezart elozmeny torolheto a FELULETROL (nem SQLite-bol kezzel), es a
//     torles sosem viszi el azt, amire meg var valaki;
//   * a Csapat lap AKKOR IS kirak egy kod-hid kartyat, ha nulla projekt van --
//     mert a nema lap pontosan ugy nez ki, mint a nem letezo funkcio.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask,
  claimNextCodeTask, completeCodeTask, cancelCodeTask, listCodeTasks,
  clearFinishedCodeTasks, pruneUnreportedCodeSessions, listCodeSessions,
} from '../web/code-bridge-store.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WS = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

function queue(prompt: string): string {
  upsertCodeSession(WS)
  const out = enqueueCodeTask({ project: 'marvin', prompt, origin: 'dashboard' })
  if ('error' in out) throw new Error(out.error)
  return out.task.id
}

describe('elozmeny-torles', () => {
  it('removes every finished row and reports how many', () => {
    const done = queue('a')
    claimNextCodeTask('HOST')
    completeCodeTask(done, { status: 'done', result: 'OK' })
    const failed = queue('b')
    claimNextCodeTask('HOST')
    completeCodeTask(failed, { status: 'error', error: 'boom' })
    const killed = queue('c')
    cancelCodeTask(killed)

    expect(listCodeTasks({ limit: 50 })).toHaveLength(3)
    expect(clearFinishedCodeTasks()).toBe(3)
    expect(listCodeTasks({ limit: 50 })).toHaveLength(0)
  })

  it('KEEPS a queued and a running task -- someone is still waiting on those', () => {
    // Ez a lenyeg: a "takaritas" nem torolhet olyan sort, amihez meg tartozik
    // egy futo claude.exe (percek mulva POST-ol eredmenyt), vagy amit valaki
    // meg most kert. Kulonben a lap letagadna a folyamatban levo munkat.
    const waiting = queue('sorban all')
    const running = queue('eppen fut')
    const claimed = claimNextCodeTask('HOST')
    expect(claimed?.id).toBe(waiting) // FIFO: az elso a futo
    const finished = queue('lezart')
    claimNextCodeTask('HOST')
    completeCodeTask(running, { status: 'done', result: 'kesz' })

    const removed = clearFinishedCodeTasks()
    expect(removed).toBe(1)
    const left = listCodeTasks({ limit: 50 }).map((t) => t.id)
    expect(left).toContain(claimed!.id)
    expect(left).not.toContain(running)
    expect(left).toContain(finished)
  })

  it('is a no-op on an empty history', () => {
    expect(clearFinishedCodeTasks()).toBe(0)
  })
})

describe('a REST felulet es a gomb', () => {
  const root = join(process.cwd())
  const route = readFileSync(join(root, 'src/web/routes/code.ts'), 'utf8')
  const html = readFileSync(join(root, 'web/index.html'), 'utf8')
  const app = readFileSync(join(root, 'web/app.js'), 'utf8')

  it('exposes DELETE /api/code/tasks', () => {
    expect(route).toContain(`if (path === '/api/code/tasks' && method === 'DELETE')`)
    expect(route).toContain('clearFinishedCodeTasks()')
  })

  it('has a button for it on the page, not just an endpoint', () => {
    expect(html).toContain('id="cbTasksClearBtn"')
    expect(app).toContain(`t.id === 'cbTasksClearBtn'`)
    expect(app).toContain(`cbFetch('/api/code/tasks', { method: 'DELETE' })`)
  })

  it('asks before deleting -- history is not recoverable', () => {
    const idx = app.indexOf(`t.id === 'cbTasksClearBtn'`)
    expect(idx).toBeGreaterThan(-1)
    expect(app.slice(idx, idx + 400)).toContain('confirm(')
  })
})

describe('kod-hid kartya a Csapat lapon', () => {
  const app = readFileSync(join(process.cwd(), 'web/app.js'), 'utf8')

  it('is rendered from renderAgents', () => {
    expect(app).toContain('renderCodeBridgeAgentCards(agentsGrid, addBtn)')
    expect(app).toContain('function renderCodeBridgeAgentCards(')
  })

  it('still shows a card when zero projects are registered', () => {
    // A hianyzo kartya es a "nincs projekt" kartya ket KULON allapot; csak az
    // utobbi mondja meg a tulajnak, hogy mit kell tennie.
    const fn = app.slice(app.indexOf('function renderCodeBridgeAgentCards('))
    expect(fn.slice(0, 3000)).toContain('rows.length')
    // A "mit tegyel most" mondat a cbIdleCardEntry-be kerult, hogy a harom ures
    // allapot -- kikapcsolt hid, hianyzo vegrehajto, nulla projekt -- kulon
    // teendot kaphasson. A kartya maga valtozatlanul kikerul.
    expect(fn.slice(0, 3000)).toContain('cbIdleCardEntry(off)')
    const idle = app.slice(app.indexOf('function cbIdleCardEntry('), app.indexOf('function renderCodeBridgeAgentCards('))
    expect(idle).toContain('egy projekt sincs regisztrálva')
  })

  it('never lets its own fetch break the Csapat page', () => {
    const fn = app.slice(app.indexOf('async function loadCodeBridgeCards('), app.indexOf('async function loadCodeBridgeCards(') + 900)
    expect(fn).toContain('.catch(() => null)')
    expect(app).toContain('loadCodeBridgeCards().catch(() => {})')
  })

  it('opens the settings window instead of duplicating the send form', () => {
    // A kartya read-only. Ha ide is kerulne feladatkuldes, ket helyen kellene
    // karbantartani ugyanazt a projekt-valasztot es prompt-korlatot.
    const fn = app.slice(app.indexOf('function renderCodeBridgeAgentCards('), app.indexOf('function openCodeBridgeModal('))
    expect(fn).toContain('code-bridge-open-btn')
    expect(fn).not.toContain('/api/code/tasks')
    // Kattintasra ugyanaz tortenik, mint barmelyik masik ugynok kartyajan:
    // kinyilik a beallitasai.
    expect(fn).toContain('openCodeBridgeModal()')
  })
})


// ---------------------------------------------------------------------------
// Szellem-projektek: a sor tulelte a workspace-t
// ---------------------------------------------------------------------------

describe('elhagyott projekt-sorok', () => {
  const other = { workspacePath: 'C:\\ws\\masik', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }

  it('drops a session the host stopped reporting', () => {
    upsertCodeSession({ ...WS, host: 'PC1' }, { fromDiscovery: true })
    upsertCodeSession({ project: 'masik', ...other, host: 'PC1' }, { fromDiscovery: true })
    expect(listCodeSessions()).toHaveLength(2)

    // A worker mar csak az egyiket latja: a masik mappaja nincs meg.
    const removed = pruneUnreportedCodeSessions('PC1', ['marvin'])
    expect(removed).toEqual(['masik'])
    expect(listCodeSessions().map((s) => s.project)).toEqual(['marvin'])
  })

  it('never touches a pinned row -- that is the owner map, not a guess', () => {
    upsertCodeSession({ project: 'masik', ...other, host: 'PC1', pinned: true })
    expect(pruneUnreportedCodeSessions('PC1', [])).toEqual([])
    expect(listCodeSessions()).toHaveLength(1)
  })

  it('never prunes another machine on one worker word', () => {
    // Ket gep, az egyik eppen ki van kapcsolva. Ha a bejelentkezo worker
    // jelentese a MASIK gep soraira is vonatkozna, egy offline laptop
    // eltuntetne az asztali gep osszes projektjet.
    upsertCodeSession({ ...WS, host: 'PC2' }, { fromDiscovery: true })
    expect(pruneUnreportedCodeSessions('PC1', [])).toEqual([])
    expect(listCodeSessions()).toHaveLength(1)
  })

  it('keeps a project that still has a queued task', () => {
    upsertCodeSession({ ...WS, host: 'PC1' }, { fromDiscovery: true })
    const out = enqueueCodeTask({ project: 'marvin', prompt: 'meg fut', origin: 'telegram' })
    expect('task' in out).toBe(true)
    // Egy kimaradt jelentes (zarolt transcript) nem kaphatja el az elo munkat:
    // a sor torlese 3 perc mulva hibara futtatna a sorban allo feladatot.
    expect(pruneUnreportedCodeSessions('PC1', [])).toEqual([])
    expect(listCodeSessions()).toHaveLength(1)
  })

  it('keeps a project whose task is running', () => {
    upsertCodeSession({ ...WS, host: 'PC1' }, { fromDiscovery: true })
    enqueueCodeTask({ project: 'marvin', prompt: 'fut', origin: 'telegram' })
    claimNextCodeTask('PC1')
    expect(pruneUnreportedCodeSessions('PC1', [])).toEqual([])
  })

  it('lets go once the work is finished', () => {
    upsertCodeSession({ ...WS, host: 'PC1' }, { fromDiscovery: true })
    const out = enqueueCodeTask({ project: 'marvin', prompt: 'fut', origin: 'telegram' })
    const id = 'task' in out ? out.task.id : ''
    claimNextCodeTask('PC1')
    completeCodeTask(id, { status: 'done', result: 'kesz' })
    expect(pruneUnreportedCodeSessions('PC1', [])).toEqual(['marvin'])
  })

  it('is wired into the discovery route, not just exported', () => {
    const route = readFileSync(join(process.cwd(), 'src/web/routes/code.ts'), 'utf8')
    expect(route).toContain('pruneUnreportedCodeSessions(body.host')
    expect(route).toContain('pruned')
  })
})
