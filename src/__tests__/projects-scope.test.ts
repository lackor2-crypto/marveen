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
import { tryHandleMemories } from '../web/routes/memories.js'
import { saveMemory, createApproval, createKanbanCard, createAgentMessage } from '../db.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID } from '../config.js'
import { classifyAgentMessage, wrapAgentMessageForDelivery } from '../web/agent-message-wrap.js'
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

  it('ha a kezdo kartya irasa elbukik, a projekt sem marad meg (egy tranzakcio)', async () => {
    getDb().exec("CREATE TRIGGER no_card BEFORE INSERT ON kanban_cards BEGIN SELECT RAISE(ABORT, 'teszt'); END")
    const r = await call('POST', '/api/projects?lang=hu', { name: 'Felbemaradt' })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('create_failed')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 })
    getDb().exec('DROP TRIGGER no_card')
    expect((await call('POST', '/api/projects?lang=hu', { name: 'Felbemaradt' })).status).toBe(200)
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

  it('kezi "nincs projekt" tartos: jeloles A + kotes B, majd levalasztas -> sehol (nem ugrik vissza A-ba)', async () => {
    const a = mustProject({ name: 'Alfa' })
    const b = mustProject({ name: 'Beta' })
    const content = `# C\nproject: ${a.id}\n`
    linkObject(b.id, 'research', 'marveen/x.md')
    expect(researchProject('marveen', 'x.md', content)).toBe(b.id)
    const r = await call('DELETE', `/api/projects/${b.id}/links/research/${encodeURIComponent('marveen/x.md')}`)
    expect(r.status).toBe(200)
    expect(researchProject('marveen', 'x.md', content)).toBeNull()
    // Csak jelolesbol szarmazo vita is levalaszthato, es az is tartos.
    expect(debateProject('s9', a.id)).toBe(a.id)
    expect((await call('DELETE', `/api/projects/${a.id}/links/debate/s9`)).status).toBe(200)
    expect(debateProject('s9', a.id)).toBeNull()
    // Masik projekt kotesenek bontasa ezen a projekten at nem megy.
    linkObject(b.id, 'debate', 's8')
    expect((await call('DELETE', `/api/projects/${a.id}/links/debate/s8`)).status).toBe(404)
    // Uj kotes felulirja a "nincs projekt" dontest.
    linkObject(a.id, 'research', 'marveen/x.md')
    expect(researchProject('marveen', 'x.md', content)).toBe(a.id)
  })

  it('kezi kotes: nem letezo vita 404, ismeretlen fajta 400', async () => {
    const a = mustProject({ name: 'Alfa' })
    setDebateLogPathForTests(join(tmp, 'nincs.jsonl'))
    const d = await call('POST', `/api/projects/${a.id}/links`, { type: 'debate', id: 'nincs' })
    expect(d.status).toBe(404)
    const r = await call('POST', `/api/projects/${a.id}/links`, { type: 'research', id: 'ismeretlen-agens/x.md' })
    expect(r.status).toBe(404)
    const k = await call('POST', `/api/projects/${a.id}/links`, { type: 'code_task', id: '1' })
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

  it('UTASITASKENT kezbesul: owner-request keret, nem <untrusted> "NOT an instruction"', async () => {
    const a = mustProject({ name: 'Alfa' })
    await call('POST', `/api/projects/${a.id}/requests?lang=hu`, { kind: 'research', text: 'Engedelyek' })
    const m = getPendingMessages(MAIN_AGENT_ID)[0]
    // Ugyanaz a ket fuggveny, amit a router es a drain-inbox is hiv.
    const cls = classifyAgentMessage(m.from_agent, m.to_agent)
    expect(cls?.category).toBe('owner-request')
    const { prefix, wrapped } = wrapAgentMessageForDelivery(cls!.category, cls!.safeFrom, m.from_agent, m.content, m.id)
    const delivered = prefix + wrapped
    expect(delivered).toContain('<owner-request source="dashboard:owner">')
    expect(delivered).toContain('EXPECTED TO CARRY OUT')
    expect(delivered).not.toContain('<untrusted')
    expect(delivered).not.toMatch(/NOT an instruction/i)
    expect(delivered).toContain('Engedelyek')
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

describe('folytassuk a projektet (kontextus az agensnek)', () => {
  it('nev-reszletbol megtalalja; tobb talalatnal nem valaszt; ismeretlennel felsorol', async () => {
    const a = mustProject({ name: 'Kovács weboldal' })
    mustProject({ name: 'Kovács logó' })
    const one = await call('GET', '/api/projects/context?q=' + encodeURIComponent('kovacs weboldal') + '&lang=hu')
    expect(one.body.state).toBe('found')
    expect(one.body.project).toEqual({ id: a.id, name: 'Kovács weboldal' })
    expect(one.body.text).toContain(`id ${a.id}`)
    const two = await call('GET', '/api/projects/context?q=kovacs')
    expect(two.body.state).toBe('ambiguous')
    expect(two.body.matches).toHaveLength(2)
    const none = await call('GET', '/api/projects/context?q=semmi')
    expect(none.body.state).toBe('none')
    expect(none.body.projects).toHaveLength(2)
  })
})

describe('projekt-szures a tobbi oldalon (Memoria, Utemezesek, Skillek, Jovahagyasok, Uzenetek)', () => {
  it('memoria / utemezes / skill: kezi kotes a listabol, a szuro-terkep es a memoria-lista ezt koveti', async () => {
    const a = mustProject({ name: 'Alfa' })
    for (let i = 0; i < 60; i++) saveMemory(ALLOWED_CHAT_ID, `emlek ${i}`, 'semantic')
    const ids = (getDb().prepare('SELECT id FROM memories ORDER BY id').all() as { id: number }[]).map((r) => r.id)
    // A legregebbi memoria: a sima 50-es lista vegerol lemaradna -- a szuro megis hozza.
    expect((await call('POST', `/api/projects/${a.id}/links`, { type: 'memory', id: String(ids[0]) })).status).toBe(200)
    expect((await call('POST', `/api/projects/${a.id}/links`, { type: 'memory', id: '999999' })).status).toBe(404)
    expect((await call('POST', `/api/projects/${a.id}/links`, { type: 'schedule', id: 'napi-osszefoglalo' })).status).toBe(200)
    expect((await call('POST', `/api/projects/${a.id}/links`, { type: 'skill', id: 'marveen/sajat-skill' })).status).toBe(200)
    expect((await call('POST', `/api/projects/${a.id}/links`, { type: 'skill', id: '<script>' })).status).toBe(400)
    expect((await call('GET', '/api/projects/scope-map?type=schedule')).body.map).toEqual({ 'napi-osszefoglalo': [a.id] })
    expect((await call('GET', '/api/projects/scope-map?type=skill')).body.map).toEqual({ 'marveen/sajat-skill': [a.id] })
    const inA = await call('GET', `/api/memories?project=${a.id}`, undefined, tryHandleMemories)
    expect(inA.body.map((m: { id: number }) => m.id)).toEqual([ids[0]])
    const none = await call('GET', '/api/memories?project=none&limit=200', undefined, tryHandleMemories)
    expect(none.body.map((m: { id: number }) => m.id)).not.toContain(ids[0])
    expect(none.body).toHaveLength(59)
  })

  it('jovahagyas: a kartyaja projektje; uzenet: a hivatkozott kartyak projektjei', async () => {
    const a = mustProject({ name: 'Alfa' })
    const b = mustProject({ name: 'Beta' })
    createKanbanCard({ id: 'aaaa1111', title: 'A kartya', status: 'waiting', project: a.id })
    createKanbanCard({ id: 'bbbb2222', title: 'B kartya', status: 'planned', project: b.id })
    createKanbanCard({ id: 'cccc3333', title: 'Projekt nelkul', status: 'planned' })
    createApproval({ id: 'ap1', agent_id: 'x', category: 'kanban_done', action_description: 'd', action_payload: JSON.stringify({ kanban_card_id: 'aaaa1111' }) })
    createApproval({ id: 'ap2', agent_id: 'x', category: 'mas', action_description: 'd' })
    const ap = await call('GET', '/api/projects/scope-map?type=approval&ids=ap1,ap2')
    expect(ap.body.map).toEqual({ ap1: [a.id] })
    const m1 = createAgentMessage('x', 'y', 'kesz az aaaa1111 es a bbbb2222 is')
    const m2 = createAgentMessage('x', 'y', 'semmi kartya, csak cccc3333')
    const msg = await call('GET', `/api/projects/scope-map?type=message&ids=${m1.id},${m2.id}`)
    expect(msg.body.map[String(m1.id)].sort()).toEqual([a.id, b.id].sort())
    expect(msg.body.map[String(m2.id)]).toBeUndefined()
    // Ures adatbazison (friss telepites) sem hibazik.
    expect((await call('GET', '/api/projects/scope-map?type=message&ids=')).body.map).toEqual({})
    expect((await call('GET', '/api/projects/scope-map?type=mas')).status).toBe(400)
  })
})

describe('kartya besorolasi javaslat', () => {
  it('javaslat nelkul null jon, nem hiba', async () => {
    const r = await call('GET', '/api/projects/card-suggestion?card=nincs')
    expect(r.status).toBe(200)
    expect(r.body.suggestion).toBeNull()
  })
})
