// A projekt nelkuli kartyak besorolasi JAVASLATA a tartalmuk alapjan
// (kanban #321, migracio 4. pont).
//
// Amit ez a teszt orzi:
//   - a javaslat SEMMIT nem mozgat, csak egy kulon tablaba ir;
//   - a modell a kartya cimet es leirasat kapja, a cimke csak "jelzes";
//   - ismeretlen kartya- vagy projekt-azonosito nem kerulhet be, a valaszbol
//     kimaradt kartya "bizonytalan" (nem vesz el);
//   - AI nelkul nem tesz ugy, mintha dolgozna: `no_ai`; projekt nelkul `no_projects`;
//   - egyszerre egy futas, es a felulet a vegpontrol latja a haladast.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, createLabel, addLabelToCard } from '../db.js'
import { createProject } from '../projects.js'
import { setAiRunners, resetLimitCooldown, type ClaudeAccount } from '../life-inbox-ai.js'
import {
  classifyPrompt, parseClassifyAnswer, startCardClassification, classificationStatus, listCardSuggestions,
  resetClassificationForTests, runClassification,
} from '../project-card-classify.js'
import { tryHandleProjects } from '../web/routes/projects.js'
import type { RouteContext } from '../web/routes/types.js'

const ACCOUNT: ClaudeAccount = { agent: 'teszt', configDir: '/nincs', model: 'claude-opus-4-8', fiveHourPct: 10, usageAt: null }

function mustProject(name: string, description?: string) {
  const r = createProject({ name, description })
  if (!r.ok) throw new Error(r.code)
  return r.project
}

function call(method: string, pathAndQuery: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420' + pathAndQuery)
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req: any = {
    headers: { 'content-length': String(buf.length) },
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && buf.length) cb(buf)
      if (event === 'end') cb()
      return req
    },
    destroy() { /* nincs socket */ },
  }
  return tryHandleProjects({ req, res, path: url.pathname, method, url } as RouteContext).then(() => out)
}

/** Megvarja, amig a hatterben futo besorolas veget er. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200 && classificationStatus().state === 'running'; i++) await new Promise((r) => setTimeout(r, 5))
}

beforeEach(() => {
  initDatabase(':memory:')
  resetLimitCooldown()
  resetClassificationForTests()
})

afterEach(() => {
  setAiRunners({ claude: null, ollama: null, accounts: null })
})

describe('a kerdes es a valasz ellenorzese', () => {
  it('a kerdesben a kartya tartalma all, a cimke csak jelzeskent', () => {
    const txt = classifyPrompt(
      [{ id: 'p1', name: 'Marvin fejlesztés', description: 'A Marveen fejlesztese', client: null, samples: ['Kanban szuro'] }],
      [{ id: 'c1', title: 'Login javitasa', description: 'A jelszo-mezo hibat dob', labels: ['fejlesztes'] }],
      'hu',
    )
    expect(txt).toContain('id p1: "Marvin fejlesztés" -- A Marveen fejlesztese')
    expect(txt).toContain('example cards: "Kanban szuro"')
    expect(txt).toContain('id c1: "Login javitasa" [label hint: fejlesztes]')
    expect(txt).toContain('description: A jelszo-mezo hibat dob')
  })

  it('csak a kerdezett kartyak es a letezo projektek; ismeretlen projekt = bizonytalan', () => {
    const out = parseClassifyAnswer({
      items: [
        { id: 'c1', project: 'p1', confidence: 0.9, reason: 'Marveen-munka' },
        { id: 'c2', project: 'kitalalt', confidence: 0.99, reason: 'x' },
        { id: 'idegen', project: 'p1', confidence: 1 },
        { id: 'c1', project: null, confidence: 0 },
        { id: 'c3', project: 'p1', confidence: 7 },
      ],
    }, new Set(['c1', 'c2', 'c3']), new Set(['p1']))
    expect(out).toEqual([
      { id: 'c1', project: 'p1', confidence: 0.9, reason: 'Marveen-munka' },
      { id: 'c2', project: null, confidence: 0, reason: 'x' },
      { id: 'c3', project: 'p1', confidence: 1, reason: '' },
    ])
    expect(parseClassifyAnswer({ nope: 1 }, new Set(), new Set())).toBeNull()
  })
})

describe('a javaslat-keszites', () => {
  it('semmit nem mozgat; a valaszbol kimaradt kartya bizonytalan; a projektet kapott kartya kiesik a listabol', async () => {
    const p = mustProject('Marvin fejlesztés', 'A Marveen fejlesztese')
    createLabel({ id: 'lf', name: 'fejlesztes', color: '#000' })
    createKanbanCard({ id: 'c1', title: 'Kanban szuro javitasa', status: 'planned' })
    addLabelToCard('c1', 'lf')
    createKanbanCard({ id: 'c2', title: 'Fogorvos idopont', status: 'planned' })
    createKanbanCard({ id: 'c3', title: 'Valami mas', status: 'done' })
    createKanbanCard({ id: 'bent', title: 'Mar projektben', status: 'planned', project: p.id })
    let prompts = 0
    let seen = ''
    setAiRunners({
      accounts: () => [ACCOUNT],
      claude: async (_s, prompt) => {
        prompts++
        seen = prompt
        return { text: JSON.stringify({ items: [{ id: 'c1', project: p.id, confidence: 0.9, reason: 'Marveen kanban' }, { id: 'c2', project: null, confidence: 0 }] }), model: 'claude-opus-4-8' }
      },
      ollama: async () => 'missing',
    })
    const started = startCardClassification('hu')
    expect(started).toMatchObject({ ok: true, status: { state: 'running', total: 3 } })
    // Egyszerre egy futas.
    expect(startCardClassification('hu')).toMatchObject({ ok: false, code: 'busy' })
    await settle()
    expect(classificationStatus()).toMatchObject({ state: 'done', done: 3, failed: 0, engine: 'claude:claude-opus-4-8' })
    expect(prompts).toBe(1)
    expect(seen).not.toContain('Mar projektben: ')
    expect(seen).not.toContain('id bent')

    const byCard = Object.fromEntries(listCardSuggestions().map((s) => [s.cardId, s]))
    expect(byCard.c1).toMatchObject({ projectId: p.id, confidence: 0.9, reason: 'Marveen kanban' })
    expect(byCard.c2).toMatchObject({ projectId: null, confidence: 0 })
    expect(byCard.c3).toMatchObject({ projectId: null, confidence: 0, reason: '' })
    // Semmi nem mozdult.
    expect(getKanbanCard('c1')?.project ?? null).toBeNull()

    // Ha a kartya kozben projektet kap, a javaslata eltunik a listabol.
    const { getDb } = await import('../db.js')
    getDb().prepare('UPDATE kanban_cards SET project = ? WHERE id = ?').run(p.id, 'c1')
    expect(listCardSuggestions().map((s) => s.cardId).sort()).toEqual(['c2', 'c3'])
  })

  it('AI nelkul no_ai (nem tesz ugy, mintha dolgozna); projekt nelkul no_projects', async () => {
    createKanbanCard({ id: 'c1', title: 'X', status: 'planned' })
    expect(startCardClassification('hu')).toMatchObject({ ok: false, code: 'no_projects' })
    mustProject('P')
    setAiRunners({ accounts: () => [], ollama: async () => 'missing' })
    expect(startCardClassification('hu').ok).toBe(true)
    await settle()
    expect(classificationStatus()).toMatchObject({ state: 'failed', error: 'no_ai', failed: 1 })
    expect(listCardSuggestions()).toEqual([])
  })

  it('egy rossz valasz csak a sajat kotegét buktatja el; a tobbi megmarad', async () => {
    const p = mustProject('P')
    const cards = Array.from({ length: 17 }, (_, i) => ({ id: `k${i}`, title: `Kartya ${i}`, description: '', labels: [] }))
    for (const c of cards) createKanbanCard({ id: c.id, title: c.title, status: 'planned' })
    let n = 0
    setAiRunners({
      accounts: () => [ACCOUNT],
      claude: async (_s, prompt) => {
        n++
        if (n === 1) return { text: 'nem JSON', model: 'm' }
        const ids = [...prompt.matchAll(/id (k\d+):/g)].map((m) => m[1])
        return { text: JSON.stringify({ items: ids.map((id) => ({ id, project: p.id, confidence: 0.8 })) }), model: 'm' }
      },
      ollama: async () => 'missing',
    })
    expect(startCardClassification('hu').ok).toBe(true)
    await settle()
    // Az elso 15-os koteg elbukott (a fiok maga "valaszolt", csak hasznalhatatlanul), a masodik 2 kartya atment.
    expect(listCardSuggestions()).toHaveLength(2)
    expect(classificationStatus()).toMatchObject({ state: 'done', done: 2, failed: 15 })
    // Egy regi (felulirt) futas nem ir tobbe: a runId-je mar nem az aktualis.
    await runClassification('regi', [{ id: p.id, name: 'P', description: null, client: null, samples: [] }], cards, 'hu')
    expect(listCardSuggestions()).toHaveLength(2)
  })
})

describe('a vegpont', () => {
  it('a GET a javaslatokat es az allapotot is visszaadja; a POST indit', async () => {
    const p = mustProject('P')
    createKanbanCard({ id: 'c1', title: 'X', status: 'planned' })
    setAiRunners({
      accounts: () => [ACCOUNT],
      claude: async () => {
        await new Promise((r) => setTimeout(r, 40))
        return { text: JSON.stringify({ items: [{ id: 'c1', project: p.id, confidence: 0.95, reason: 'ok' }] }), model: 'm' }
      },
      ollama: async () => 'missing',
    })
    const start = await call('POST', '/api/projects/migration/classify?lang=hu', {})
    expect(start.status).toBe(202)
    const again = await call('POST', '/api/projects/migration/classify?lang=hu', {})
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('classify_busy')
    await settle()
    const got = await call('GET', '/api/projects/migration?lang=hu')
    expect(got.body.classification.status.state).toBe('done')
    expect(got.body.classification.confident).toBeGreaterThan(0.5)
    expect(got.body.classification.suggestions).toEqual([expect.objectContaining({ cardId: 'c1', projectId: p.id })])
    expect(got.body.plan.unassignedCards.cards.map((c: { id: string }) => c.id)).toEqual(['c1'])
  })
})
