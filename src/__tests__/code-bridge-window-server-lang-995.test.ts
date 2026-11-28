// #995, second round: the window's own labels follow the selected language, but the sentences the SERVER
// sends into it did not (restart reason, skill folder reason, conversation action lines, the card check
// detail), and a few texts stayed in the previous language after a switch.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type http from 'node:http'
import vm from 'node:vm'
import ts from 'typescript'

// The card check reads git; here no branch is readable (a fresh install unpacked from an archive).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((cmd: string, args: string[], opts: any) => {
      if (Array.isArray(args) && args[0] === 'rev-parse' && args.includes('--verify')) throw new Error('no ref')
      return actual.execFileSync(cmd, args, opts)
    }) as typeof actual.execFileSync,
  }
})

import { PROJECT_ROOT } from '../config.js'
import { initDatabase, createKanbanCard } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, claimNextCodeTask, completeCodeTaskDetailed,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'
import { restartAvailability } from '../self-restart.js'
import { buildRestartAllPlan } from '../restart-all.js'
import { readCodeConversation } from '../web/code-conversation.js'

const ACCENT = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
function dict(lang: 'hu' | 'en'): Record<string, string> {
  const window = { _i18n: {} as Record<string, Record<string, string>> }
  vm.runInContext(readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf8'), vm.createContext({ window }))
  return window._i18n[lang]
}

async function call(method: string, path: string, lang: 'hu' | 'en', body?: unknown): Promise<any> {
  const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json', 'x-ui-lang': lang }
  let out: any = null
  const res = {
    writeHead() { return res }, setHeader() { return res },
    end(chunk?: any) { if (chunk) out = JSON.parse(String(chunk)) },
  } as unknown as http.ServerResponse
  const url = new URL('http://127.0.0.1:3420' + path)
  expect(await tryHandleCode({ req, res, path: url.pathname, method, url } as any)).toBe(true)
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('server sentences shown in the code bridge window follow the UI language (#995)', () => {
  it('the reason why the skill folder cannot be opened', async () => {
    upsertCodeSession({ project: 'share', workspacePath: '\\\\server\\share\\x', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' })
    const en = await call('GET', '/api/code/skills?project=share', 'en')
    const hu = await call('GET', '/api/code/skills?project=share', 'hu')
    expect(en.reachable).toBe(false)
    expect(en.reason).toMatch(/cannot be opened/)
    expect(en.reason).not.toMatch(ACCENT)
    expect(hu.reason).toMatch(/nem lehet megnyitni/)
  })

  it('the reason why the restart button is not offered', () => {
    const unit = '0::/user.slice/lackor2-bot-channels.service\n'
    for (const cg of ['0::/user.slice/x.scope\n', unit]) {
      expect(restartAvailability(cg, 'en').reason).not.toMatch(ACCENT)
      expect(restartAvailability(cg, 'hu').reason).toMatch(ACCENT)
    }
    const agent = { name: 'a', displayName: 'A', running: true, busy: false }
    const plan = buildRestartAllPlan({
      agents: [], main: agent, lang: 'en',
      dashboard: { possible: true, unit: 'x-channels.service', reason: '' },
    })
    expect(plan.dashboardReason).toMatch(/[a-z]/)
    expect(plan.dashboardReason).not.toMatch(ACCENT)
  })

  it('the restart routes pass the language of the request on', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'system-restart.ts'), 'utf8')
    expect(src).not.toMatch(/restartAvailability\(\)/)
    expect(readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'backup-restore.ts'), 'utf8')).not.toMatch(/restartAvailability\(\)/)
  })

  it('the action lines of the conversation view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb995-'))
    try {
      const sid = 'cccccccc-0000-4000-8000-000000000003'
      mkdirSync(join(dir, '.claude', 'projects', 'p'), { recursive: true })
      const file = join(dir, '.claude', 'projects', 'p', `${sid}.jsonl`)
      const tool = (name: string, input: object, i: number) => JSON.stringify({
        type: 'assistant', uuid: `u${i}`, timestamp: '2026-11-28T10:00:00Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input }] },
      })
      writeFileSync(file, [tool('Task', { description: 'd' }, 1), tool('WebSearch', { query: 'q' }, 2),
        tool('WebFetch', { url: 'u' }, 3), tool('TodoWrite', {}, 4)].join('\n'))
      const texts = (lang: 'hu' | 'en') => readCodeConversation(file, sid, { limit: 20, offset: 0, lang }).entries.map((e) => e.text)
      expect(texts('en')).toEqual(['Agent: d', 'Web search: q', 'Web fetch: u', 'To-do list update'])
      expect(texts('hu')).toEqual(['Ügynök: d', 'Web keresés: q', 'Web lekérés: u', 'Teendőlista frissítése'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
    const route = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
    const reads = route.match(/readCodeConversation\([^)]*\{[^}]*\}\)/g) ?? []
    expect(reads.length).toBe(2)
    for (const r of reads) expect(r).toContain('lang')
  })

  it('the detail of "could not check the card" in the send warning', async () => {
    createKanbanCard({ id: 'deadbeef-9950-4000-8000-000000000001', title: 'card', status: 'in_progress' })
    upsertCodeSession({ project: 'p', workspacePath: 'C:\\p', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', pinned: true })
    const out = await call('POST', '/api/code/tasks', 'en', { project: 'p', prompt: 'work on deadbeef', origin: 'dashboard' })
    expect(out.warning.key).toBe('cb.warn.card_uncheckable')
    expect(out.warning.params.detail).toMatch(/no readable git branch/)
  })

  it('keeps the quota warning beside the first warning, so the window can show both', async () => {
    createKanbanCard({ id: 'deadbeef-9950-4000-8000-000000000001', title: 'card', status: 'in_progress' })
    upsertCodeSession({ project: 'p', workspacePath: 'C:\\p', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', pinned: true })
    const first = await call('POST', '/api/code/tasks', 'en', { project: 'p', prompt: 'first', origin: 'dashboard' })
    claimNextCodeTask('H')
    completeCodeTaskDetailed(first.id, { ok: false, error: "You've hit your session limit · resets 4:20pm (Europe/Budapest)" }, Date.now(), 'H')
    const out = await call('POST', '/api/code/tasks', 'en', { project: 'p', prompt: 'work on deadbeef', origin: 'dashboard' })
    expect(out.warning.key).toBe('cb.warn.card_uncheckable')
    expect((out.warning.also ?? []).map((w: any) => w.key.replace(/_est$/, ''))).toEqual(['cb.warn.executor_limit'])
  })
})

// ---- the window script --------------------------------------------------

/** The named functions of web/app.js, taken as they are, run in an empty sandbox. */
function pick(names: string[], globals: Record<string, unknown>): any {
  const sf = ts.createSourceFile('app.js', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const found = new Map<string, string>()
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && names.includes(n.name.text)) found.set(n.name.text, n.getText())
    ts.forEachChild(n, visit)
  }
  visit(sf)
  expect([...found.keys()].sort()).toEqual([...names].sort())
  const ctx = vm.createContext(globals)
  vm.runInContext([...found.values()].join('\n'), ctx)
  return ctx
}
const tr = (d: Record<string, string>) => (k: string, p: Record<string, unknown> = {}) =>
  (d[k] ?? k).replace(/\{(\w+)\}/g, (m, n: string) => (n in p ? String(p[n]) : m))

describe('texts the window writes itself follow a language switch (#995)', () => {
  it('names the last action of the executor in the selected language', () => {
    for (const lang of ['hu', 'en'] as const) {
      const d = dict(lang)
      const ctx = pick(['cbWorkerAction'], { t: tr(d) })
      for (const a of ['discovery', 'claim', 'heartbeat', 'result']) {
        expect(d[`cb.worker.action.${a}`], `${lang} ${a}`).toBeTruthy()
        expect(ctx.cbWorkerAction(a)).toBe(d[`cb.worker.action.${a}`])
      }
      expect(ctx.cbWorkerAction('something-new')).toBe('something-new')
    }
    expect(app).toContain('cbWorkerAction(w.lastAction)')
  })

  it('translates the failure reasons the server itself writes on a task', () => {
    const store = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'code-bridge-store.ts'), 'utf8')
    // The two English sentences the dashboard recognises must stay what the store writes.
    expect(store).toContain('`project "${task.project}" has no registered session any more`')
    expect(store).toContain('`worker stopped responding after ${task.attempts} attempt(s)`')
    const hu = dict('hu')
    const ctx = pick(['cbTaskErrorText'], { t: tr(hu) })
    expect(ctx.cbTaskErrorText('project "x y" has no registered session any more')).toBe(tr(hu)('cb.task.err_no_session', { project: 'x y' }))
    expect(ctx.cbTaskErrorText('worker stopped responding after 3 attempt(s)')).toBe(tr(hu)('cb.task.err_worker_lost', { n: 3 }))
    expect(hu['cb.task.err_worker_lost']).toMatch(ACCENT)
    expect(ctx.cbTaskErrorText('ENOENT: raw executor output')).toBe('ENOENT: raw executor output')
    expect(app).toContain('cbTaskErrorText(task.error)')
  })

  it('rebuilds the restart note after a language switch', async () => {
    const mounted: string[] = []
    const window = { _lang: 'hu' }
    const ctx = pick(['cbMountRestart'], {
      window, _cbRestartState: {}, document: { getElementById: () => ({ innerHTML: '' }) },
      mountRestartButton: async () => { mounted.push(window._lang) },
    })
    await ctx.cbMountRestart('s', true, 'n')
    await ctx.cbMountRestart('s', true, 'n')
    window._lang = 'en'
    await ctx.cbMountRestart('s', true, 'n')
    expect(mounted).toEqual(['hu', 'en'])
  })

  it('drops the status lines left in the previous language when the window is opened again', () => {
    const els: Record<string, { textContent: string; hidden: boolean }> = {}
    const el = (id: string) => (els[id] ??= { textContent: 'magyar mondat', hidden: false })
    const window = { _lang: 'hu' }
    let stopped = 0
    const ctx = pick(['cbDropOtherLanguageTexts'], {
      window, _cbTextLang: null, document: { getElementById: el }, cbBrowseStop: () => { stopped++ },
    })
    const ids = ['cbTaskStatus', 'cbTaskCounter', 'cbOpsStatus', 'cbBotStatus', 'cbSkillStatus', 'cbAddStatus', 'cbBrowseStatus']
    ids.forEach(el)
    ctx.cbDropOtherLanguageTexts()
    ctx.cbDropOtherLanguageTexts()
    expect(ids.map((i) => els[i]!.textContent)).toEqual(ids.map(() => 'magyar mondat'))
    window._lang = 'en'
    ctx.cbDropOtherLanguageTexts()
    expect(ids.map((i) => els[i]!.textContent)).toEqual(ids.map(() => ''))
    expect(el('cbBrowseBox').hidden).toBe(true)
    expect(stopped).toBe(1)
    expect(app).toMatch(/loadCodeBridgePage = function \(\) \{\s*cbDropOtherLanguageTexts\(\)/)
  })

  it('shows every warning of a dispatch, not only the first', () => {
    expect(app).toMatch(/\[task\.warning\]\.concat\(task\.warning\.also \|\| \[\]\)/)
  })
})
