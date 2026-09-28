// A Munkapad chatbol inditott kod-hid feladat (#433) valasza a Munkapad
// chatjebe megy, NEM Telegramra.
//
// Valos eset (Boss, 2026-09-28 19:01): a teljes erteku ugynok valasza a
// Munkapad chatbe nem ert el, a Telegramon viszont megjott -- "abba a csetbe
// kell nekem visszakapnom az uzenetet, ahonnan kerdeztem". A feladat
// 'dashboard' eredettel ment, es a befejezes-ertesito minden nem-Telegram
// feladatot a tulajdonos Telegramjara kuldott.
//
// Amit ez a fajl bizonyit:
//  1. 'workbench' eredetu feladat valasza a feladat lezarasakor a Munkapad-
//     beszelgetesbe kerul (dashboard-ujrainditas utan is), egyszer, es NEM megy
//     Telegramra; ha a beszelgetes nem talalhato, a Telegram a tartalek (a
//     valasz nem veszhet el); a tobbi eredetnel valtozatlanul megy;
//  2. az elohang 'workbench' eredetnel a Munkapad chatjet nevezi meg, a tobbi
//     eredetnel a szoveg szo szerint a regi (a meglevo feladatok nem mozdulnak);
//  3. kivulrol (API) 'workbench' eredet NEM kerheto -- azzal barki elnemithatna
//     a befejezes-ertesitot.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

const sent: { chatId: string; text: string }[] = []

vi.mock('../web/telegram.js', async (orig) => {
  const actual = await orig<typeof import('../web/telegram.js')>()
  return { ...actual, sendTelegramMessage: async (_token: string, chatId: string, text: string) => { sent.push({ chatId, text }) } }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, CODE_BOT_TOKEN: 'code-bot-token', TELEGRAM_BOT_TOKEN: 'main-bot-token' }
})
vi.mock('../owner-chat.js', async (orig) => {
  const actual = await orig<typeof import('../owner-chat.js')>()
  return { ...actual, resolveOwnerChatId: () => '424242' }
})

import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { openSessionForWorkItem, listAgentMessages, addAgentMessage, addAgentMessageOnce } from '../workbench-agent/sessions.js'
import { notifyCodeTaskFinished } from '../web/code-bridge-notify.js'
import { buildCodeTaskPreamble } from '../web/code-task-preamble.js'
import {
  resetCodeBridgeTablesForTests, getCodeTask, upsertCodeSession, enqueueCodeTask, type CodeTask, type CodeTaskOrigin,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

function task(over: Partial<CodeTask> = {}): CodeTask {
  return {
    id: 'abcdef0123456789',
    project: 'marveen',
    prompt: 'olvasd el a tervet',
    status: 'done',
    origin: 'dashboard',
    requestedBy: null,
    chatId: null,
    sessionId: null,
    targetSessionId: null,
    workspacePath: null,
    host: null,
    result: 'A TELJES VÉLEMÉNY',
    summary: null,
    error: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    attempts: 1,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    cardRef: null,
    ...over,
  } as CodeTask
}

beforeEach(() => {
  initDatabase(':memory:')
  sent.length = 0
})

describe('befejezes-ertesites: a Munkapad-feladat valasza a Munkapad chatjebe megy, nem Telegramra', () => {
  function workbenchSession(lang: 'hu' | 'en' = 'hu'): string {
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Terv', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    return openSessionForWorkItem(p.project.id, w.item.id, lang).id
  }
  const nowMs = () => Date.now()

  it('kesz feladat: a valasz a beszelgetesbe kerul, Telegram-uzenet nem megy', async () => {
    const sid = workbenchSession()
    await notifyCodeTaskFinished(task({ origin: 'workbench', chatId: sid, createdAt: nowMs() }))
    expect(sent).toEqual([])
    expect(listAgentMessages(sid).map((m) => [m.role, m.content])).toEqual([['assistant', 'A TELJES VÉLEMÉNY']])
  })

  it('hibas feladat: a VALODI ok a beszelgetesbe kerul (rendszer-sor), Telegram-uzenet nem megy', async () => {
    const sid = workbenchSession()
    await notifyCodeTaskFinished(task({ origin: 'workbench', chatId: sid, createdAt: nowMs(), status: 'error', result: 'session limit', error: 'Claude Code reported an error' }))
    expect(sent).toEqual([])
    const msgs = listAgentMessages(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('session limit')
  })

  it('ujrainditas-allo: ha az elo fordulo mar beirta, nem kerul be masodszor (es forditva)', async () => {
    const sid = workbenchSession()
    const t = task({ origin: 'workbench', chatId: sid, createdAt: nowMs() })
    // Az elo fordulo mar beirta a valaszt ...
    addAgentMessageOnce(sid, 'assistant', 'A TELJES VÉLEMÉNY', Math.floor(t.createdAt / 1000))
    // ... a lezaras (akar ketszer is, pl. reaper + worker) nem duplaz.
    await notifyCodeTaskFinished(t)
    await notifyCodeTaskFinished(t)
    expect(listAgentMessages(sid).filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('egy KESOBBI fordulo ugyanolyan valasza nem nyelodik el (csak a feladat ota nezunk)', async () => {
    const sid = workbenchSession()
    addAgentMessage(sid, 'assistant', 'Igen.')
    const later = task({ origin: 'workbench', chatId: sid, createdAt: nowMs() + 5000, result: 'Igen.' })
    await notifyCodeTaskFinished(later)
    expect(listAgentMessages(sid).filter((m) => m.content === 'Igen.')).toHaveLength(2)
  })

  it('ha a beszelgetes nem talalhato, a valasz NEM vesz el: Telegramon megy', async () => {
    await notifyCodeTaskFinished(task({ origin: 'workbench', chatId: 'nincs-ilyen-session' }))
    await notifyCodeTaskFinished(task({ origin: 'workbench', chatId: null }))
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(sent.map((s) => s.text).join('\n')).toContain('A TELJES VÉLEMÉNY')
  })

  it('a tobbi eredetnel valtozatlanul megy (a tulajdonos Telegramjara, a teljes eredmennyel)', async () => {
    for (const origin of ['dashboard', 'agent', 'api'] as CodeTaskOrigin[]) {
      sent.length = 0
      await notifyCodeTaskFinished(task({ origin }))
      expect(sent.length).toBeGreaterThan(0)
      expect(sent[0].chatId).toBe('424242')
      expect(sent.map((s) => s.text).join('\n')).toContain('A TELJES VÉLEMÉNY')
    }
  })
})

describe('elohang: a zaro osszefoglalo helye', () => {
  const base = { workspacePath: '/srv/marveen', hostKind: 'unix' as const, projectRoot: '/srv/marveen' }

  it('HU, workbench eredet: a Munkapad chatjet nevezi meg, nem a Telegramot', () => {
    const text = buildCodeTaskPreamble({ ...base, lang: 'hu', origin: 'workbench' })
    expect(text).toContain('amit a tulajdonos a Munkapad chatjeben fog olvasni')
    expect(text).not.toContain('a Telegramon fog olvasni')
    expect(text).toContain('a Munkapad chatjebe teszi')
    // A vedosor (ne probaljon Telegram-uzenetet kuldeni) tovabbra is ott van.
    expect(text).toContain('NE probalj Telegram- vagy')
  })

  it('EN, workbench eredet: ugyanaz angolul', () => {
    const text = buildCodeTaskPreamble({ ...base, lang: 'en', origin: 'workbench' })
    expect(text).toContain('the text the owner will read in the Workbench chat')
    expect(text).not.toContain('will read in Telegram')
    expect(text).toContain('into the Workbench chat')
  })

  it('mas eredetnel (es eredet nelkul) a szoveg szo szerint a regi', () => {
    for (const origin of [undefined, 'dashboard', 'telegram', 'agent', 'api'] as (CodeTaskOrigin | undefined)[]) {
      const hu = buildCodeTaskPreamble({ ...base, lang: 'hu', origin })
      expect(hu).toContain('5. A ZARO OSSZEFOGLALOT -- amit a tulajdonos a Telegramon fog olvasni -- MAGYARUL ird meg')
      expect(hu).toContain('a tulajdonost a Marveen dashboard ertesiti helyetted, amikor a task lezarul.')
      const en = buildCodeTaskPreamble({ ...base, lang: 'en', origin })
      expect(en).toContain('the text the owner will read in Telegram --')
      expect(en).toContain('the Marveen dashboard notifies the owner for you when the task finishes.')
    }
  })
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { 'content-type': 'application/json' }
  const out = { status: 0, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: unknown) { if (chunk) { try { out.body = JSON.parse(String(chunk)) } catch { out.body = String(chunk) } } },
  }
  await tryHandleCode({ req, res, path, method, url: new URL('http://127.0.0.1:3420' + path) } as any)
  return out
}

describe('kod-hid utvonalak: a "workbench" eredet', () => {
  beforeEach(() => {
    resetCodeBridgeTablesForTests()
    upsertCodeSession({ project: 'marveen', workspacePath: '/srv/elsewhere', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', pinned: true })
  })

  it('kivulrol (POST /api/code/tasks) nem kerheto: "api" lesz belole', async () => {
    const r = await call('POST', '/api/code/tasks', { project: 'marveen', prompt: 'valami', origin: 'workbench' })
    expect(r.status).toBe(201)
    expect(getCodeTask(r.body.id)?.origin).toBe('api')
  })

  it('a kiadott Munkapad-feladat elohangja a Munkapad chatjet nevezi meg', async () => {
    const q = enqueueCodeTask({ project: 'marveen', prompt: 'olvasd el a tervet', origin: 'workbench' })
    expect('task' in q).toBe(true)
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'WINPC' })
    expect(claimed.body.task.prompt).toContain('a Munkapad chatjeben fog olvasni')
    expect(claimed.body.task.prompt).not.toContain('a Telegramon fog olvasni')
  })
})
