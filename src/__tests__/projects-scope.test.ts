// A projekt mindenhol (kanban #321, Boss 2026-09-19): ami egy projekten belul
// szuletik (kartya, otlet, vitaztatas, hatteranyag), az magatol a projekte, es
// a Marvin-oldali listak projektre szurhetok.
//
// Amit ez a teszt orzi:
//   - uj projekt = egy kezdo kartya is, a projekt alapertelmezett cimkejevel; ha
//     a tablan kotelezo a cimke es nincs megadva, a projekt sem jon letre
//     (nem marad felig kesz allapot);
//   - az Otletladaban projekttel felvett otlet a projekthez kotodik, a lista
//     szurheto, a kanbanra vitt otlet kartyaja a projektben marad;
//   - a vitaztatas es a hatteranyag projektje: kifejezett kotes > a naplo /
//     a fajl elejen allo jeloles;
//   - a projektbol inditott keres a fo agensnek megy, a pontos jelolesi
//     utasitassal.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createLabel, createIdea, getDb, getLabelsForCard, getPendingMessages } from '../db.js'
import { createProject, linkObject } from '../projects.js'
import { debateProject, researchProject, researchProjectMark, ideaProjectMap, knownProjectId } from '../project-scope.js'
import { linkedDebates, setDebateLogPathForTests } from '../project-context.js'
import { tryHandleProjects } from '../web/routes/projects.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'
import { MAIN_AGENT_ID } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

function mustProject(input: Parameters<typeof createProject>[0]) {
  const r = createProject(input)
  if (!r.ok) throw new Error(r.code)
  return r.project
}

function call(method: string, pathAndQuery: string, body?: unknown, handler: (c: RouteContext) => Promise<boolean> = tryHandleProjects) {
  const out: { status: number; body: any; handled: boolean } = { status: 200, body: null, handled: false }
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
  return handler({ req, res, path: url.pathname, method, url } as RouteContext).then((h) => { out.handled = h; return out })
}

const cardsOf = (pid: string) => getDb().prepare('SELECT id, title FROM kanban_cards WHERE project = ?').all(pid) as { id: string; title: string }[]

let tmp: string

beforeEach(() => {
  initDatabase(':memory:')
  tmp = mkdtempSync(join(tmpdir(), 'marveen-prjscope-'))
})

afterEach(() => {
  setDebateLogPathForTests(null)
  rmSync(tmp, { recursive: true, force: true })
})

describe('uj projekt -> kezdo kartya', () => {
  it('cimke nelkuli tablan: a projekt kezdo kartyat kap, a nyelv szerinti cimmel', async () => {
    const r = await call('POST', '/api/projects?lang=hu', { name: 'Kovacs weboldal', description: 'Egy uj weboldal.' })
    expect(r.status).toBe(200)
    const cards = cardsOf(r.body.project.id)
    expect(cards).toHaveLength(1)
    expect(cards[0].id).toBe(r.body.starterCardId)
    expect(cards[0].title).toBe('Indulás: Kovacs weboldal')
    const en = await call('POST', '/api/projects?lang=en', { name: 'Garden' })
    expect(cardsOf(en.body.project.id)[0].title).toBe('Kickoff: Garden')
  })

  it('kotelezo cimkenel: alapertelmezett cimke nelkul 400, es a projekt SEM jon letre', async () => {
    createLabel({ id: 'lab-web', name: 'web', color: '#123456' })
    const bad = await call('POST', '/api/projects?lang=hu', { name: 'Cimke nelkul' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('starter_label_required')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 })

    const ok = await call('POST', '/api/projects?lang=hu', { name: 'Cimkevel', default_label_id: 'lab-web' })
    expect(ok.status).toBe(200)
    expect(getLabelsForCard(ok.body.starterCardId).map((l: { id: string }) => l.id)).toEqual(['lab-web'])
  })

  it('starter_card:false -> nincs kezdo kartya (es cimke sem kell)', async () => {
    createLabel({ id: 'lab-web', name: 'web', color: '#123456' })
    const r = await call('POST', '/api/projects', { name: 'Kartya nelkul', starter_card: false })
    expect(r.status).toBe(200)
    expect(r.body.starterCardId).toBeNull()
    expect(cardsOf(r.body.project.id)).toHaveLength(0)
  })
})

describe('Otletlada projektre szurve', () => {
  it('projekttel felvett otlet a projekte; a lista szurheto; ismeretlen projekt 400', async () => {
    const p = mustProject({ name: 'Kert' })
    const made = await call('POST', '/api/ideas', { title: 'Szokokut', project: 'Kert' }, tryHandleIdeas)
    expect(made.body.project).toBe(p.id)
    await call('POST', '/api/ideas', { title: 'Projekt nelkuli' }, tryHandleIdeas)

    const scoped = await call('GET', '/api/ideas?project=' + p.id, undefined, tryHandleIdeas)
    expect(scoped.body.map((i: any) => i.title)).toEqual(['Szokokut'])
    expect(scoped.body[0].project).toBe(p.id)
    const none = await call('GET', '/api/ideas?project=none', undefined, tryHandleIdeas)
    expect(none.body.map((i: any) => i.title)).toEqual(['Projekt nelkuli'])

    const bad = await call('POST', '/api/ideas', { title: 'X', project: 'nincs ilyen' }, tryHandleIdeas)
    expect(bad.status).toBe(400)
  })

  it('a kanbanra vitt otlet kartyaja a projektben marad; projekt nelkuli otlet a regi helyre megy', async () => {
    const p = mustProject({ name: 'Kert' })
    const a = await call('POST', '/api/ideas', { title: 'Szokokut', project: p.id }, tryHandleIdeas)
    const pa = await call('POST', `/api/ideas/${a.body.id}/promote`, { phase: 'plan' }, tryHandleIdeas)
    expect(cardsOf(p.id).map((c) => c.id)).toContain(pa.body.kanban_id)

    const b = await call('POST', '/api/ideas', { title: 'Mashova' }, tryHandleIdeas)
    const pb = await call('POST', `/api/ideas/${b.body.id}/promote`, { phase: 'plan' }, tryHandleIdeas)
    const row = getDb().prepare('SELECT project FROM kanban_cards WHERE id = ?').get(pb.body.kanban_id) as { project: string }
    expect(row.project).toBe('Fejlesztési ötletek')
  })

  it('a kifejezett kotes nyer a kartyan at levezetett felett', () => {
    const a = mustProject({ name: 'A' })
    const b = mustProject({ name: 'B' })
    getDb().prepare("INSERT INTO kanban_cards (id, title, status, priority, project, created_at, updated_at) VALUES ('c1','k','planned','normal',?,1,1)").run(a.id)
    createIdea({ id: 'i1', title: 'o', description: null, category: 'x', status: 'kanban', source: 'manual', kanban_id: 'c1', impact: null, effort: null })
    expect(ideaProjectMap().get('i1')).toBe(a.id)
    linkObject(b.id, 'idea', 'i1')
    expect(ideaProjectMap().get('i1')).toBe(b.id)
  })
})

describe('vitaztatas es hatteranyag projektje', () => {
  it('vita: a naplo project-mezoje (id vagy nev), a kifejezett kotes felulirja', () => {
    const a = mustProject({ name: 'Alfa' })
    const b = mustProject({ name: 'Beta' })
    expect(debateProject('s1', a.id)).toBe(a.id)
    expect(debateProject('s1', 'Alfa')).toBe(a.id)
    expect(debateProject('s1', 'nincs ilyen')).toBeNull()
    linkObject(b.id, 'debate', 's1')
    expect(debateProject('s1', a.id)).toBe(b.id)
  })

  it('a projekt vitai kozott a projektbol inditott (naplozott) vita is ott van', () => {
    const a = mustProject({ name: 'Alfa' })
    const log = join(tmp, 'debate-log.jsonl')
    writeFileSync(log, [
      JSON.stringify({ ts: 10, session: 's1', round: 1, type: 'round', prompt: 'Melyik?', model: 'm', ok: true, text: 'x', project: a.id }),
      JSON.stringify({ ts: 11, session: 's2', round: 1, type: 'round', prompt: 'Mas', model: 'm', ok: true, text: 'y' }),
    ].join('\n') + '\n')
    setDebateLogPathForTests(log)
    expect(linkedDebates(a.id).map((d) => d.id)).toEqual(['s1'])
  })

  it('hatteranyag: a fajl elejen allo jeloles, tobbfele irasmoddal; kotes felulirja', () => {
    const a = mustProject({ name: 'Alfa' })
    const b = mustProject({ name: 'Beta' })
    expect(researchProjectMark(`# Cim\nproject: ${a.id}\n\nszoveg`)).toBe(a.id)
    expect(researchProjectMark('# Cim\n**Projekt:** Alfa\n')).toBe('Alfa')
    expect(researchProjectMark('# Cim\n\nA project: szo a szovegben.\n')).toBeNull()
    expect(researchProject('marveen', 'x.md', '# C\nProjekt: Alfa')).toBe(a.id)
    linkObject(b.id, 'research', 'marveen/x.md')
    expect(researchProject('marveen', 'x.md', '# C\nProjekt: Alfa')).toBe(b.id)
    expect(knownProjectId('')).toBeNull()
  })

  it('kezi kotes: nem letezo vita 404, ismeretlen fajta 400', async () => {
    const a = mustProject({ name: 'Alfa' })
    setDebateLogPathForTests(join(tmp, 'nincs.jsonl'))
    const d = await call('POST', `/api/projects/${a.id}/links`, { type: 'debate', id: 'nincs' })
    expect(d.status).toBe(404)
    const r = await call('POST', `/api/projects/${a.id}/links`, { type: 'research', id: 'ismeretlen-agens/x.md' })
    expect(r.status).toBe(404)
    const k = await call('POST', `/api/projects/${a.id}/links`, { type: 'memory', id: '1' })
    expect(k.status).toBe(400)
  })
})

describe('projektbol inditott keres a fo agensnek', () => {
  it('a vitaztatas-keres a fo agensnek megy, a --project jelolessel', async () => {
    const a = mustProject({ name: 'Alfa' })
    const r = await call('POST', `/api/projects/${a.id}/requests?lang=hu`, { kind: 'debate', text: 'Melyik tarhely?' })
    expect(r.status).toBe(200)
    const msgs = getPendingMessages(MAIN_AGENT_ID)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('Melyik tarhely?')
    expect(msgs[0].content).toContain(`--project ${a.id}`)
  })

  it('a hatteranyag-keres a pontos jelolo sort irja elo; ures szoveg / ismeretlen fajta 400', async () => {
    const a = mustProject({ name: 'Alfa' })
    await call('POST', `/api/projects/${a.id}/requests`, { kind: 'research', text: 'Engedelyek' })
    const msg = getPendingMessages(MAIN_AGENT_ID)[0].content
    expect(msg).toContain(`project: ${a.id}`)
    // A kert jeloles pontosan azt adja, amit a felismero var.
    expect(researchProjectMark(`# Engedelyek\nproject: ${a.id}\n`)).toBe(a.id)
    expect((await call('POST', `/api/projects/${a.id}/requests`, { kind: 'research', text: '  ' })).status).toBe(400)
    expect((await call('POST', `/api/projects/${a.id}/requests`, { kind: 'mas', text: 'x' })).status).toBe(400)
  })
})

describe('kartya besorolasi javaslat', () => {
  it('javaslat nelkul null jon, nem hiba', async () => {
    const r = await call('GET', '/api/projects/card-suggestion?card=nincs')
    expect(r.status).toBe(200)
    expect(r.body.suggestion).toBeNull()
  })
})
