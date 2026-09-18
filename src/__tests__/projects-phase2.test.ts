// Projektek 2. fazis (kanban #321, spec 9., 15., 17. pont): munkakezdes a
// projektbol.
//
// Amit ez a teszt orzi:
//   - az AI-osszefoglalo CSAK kerésre keszul, a sajat Claude-elofizetes ->
//     helyi modell lancon, a projekthez mentodik idoponttal ES azzal, hogy mi
//     keszitette; egyszerre egy fut; AI nelkul emberi hibakod jon, nem hamis
//     szoveg; az `updated_at` (a lista "utolso aktivitasa") nem ugrik meg tole;
//   - az uj otlet a projekthez kotve szuletik; a kothetok listajan csak a meg
//     sehova nem tartozo otletek vannak; a kotes bontasa az otletet nem torli;
//   - a projektmappaba irt fajl SOHA nem ir felul, nem lep ki a projekt
//     mappajabol, git-repo belsejebe nem ir, es az ekezetes nev sem torik el;
//   - a projektben cimke nelkul kert kartya a projekt alapertelmezett cimkejet kapja.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, createIdea, createLabel, deleteLabel, getDb, getLabelsForCard } from '../db.js'
import {
  createProject, getProject, linkObject, listProjectIdeas, projectIdeaCandidates, projectDefaultLabel, updateProject,
} from '../projects.js'
import { setAiRunners, resetLimitCooldown, type ClaudeAccount } from '../life-inbox-ai.js'
import { summarizeProject, summaryFacts } from '../project-summary.js'
import { buildProjectOverview } from '../project-overview.js'
import { writeProjectFile, writeProjectNote, projectSubfolders, safeFileName } from '../project-files.js'
import { tryHandleProjects } from '../web/routes/projects.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function mustProject(input: Parameters<typeof createProject>[0]) {
  const r = createProject(input)
  if (!r.ok) throw new Error(r.code)
  return r.project
}

function call(method: string, pathAndQuery: string, body?: unknown | Buffer, handler: (c: RouteContext) => Promise<boolean> = tryHandleProjects) {
  const out: { status: number; body: any; handled: boolean } = { status: 0, body: null, handled: false }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420' + pathAndQuery)
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const req: any = {
    headers: { 'content-length': String(buf.length) },
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && buf.length) cb(buf)
      if (event === 'end') cb()
      return req
    },
    destroy() { /* a teszt-keresnek nincs socketje */ },
  }
  return handler({ req, res, path: url.pathname, method, url } as RouteContext).then((h) => { out.handled = h; return out })
}

const ACCOUNT: ClaudeAccount = { agent: 'teszt', configDir: '/nincs', model: 'claude-opus-4-8', fiveHourPct: 10, usageAt: null }

let savedDepot: string | undefined
let depot: string

beforeEach(() => {
  initDatabase(':memory:')
  resetLimitCooldown()
  savedDepot = process.env.MARVEEN_DEPOT
  depot = mkdtempSync(join(tmpdir(), 'marveen-prj2-'))
  process.env.MARVEEN_DEPOT = depot
})

afterEach(() => {
  setAiRunners({ claude: null, ollama: null, accounts: null })
  if (savedDepot === undefined) delete process.env.MARVEEN_DEPOT
  else process.env.MARVEEN_DEPOT = savedDepot
  rmSync(depot, { recursive: true, force: true })
})

describe('AI-osszefoglalo -- csak keresre, mentve, forrassal', () => {
  it('a Claude valasza a projekthez mentodik: szoveg, idopont, keszito; az updated_at nem valtozik', async () => {
    const p = mustProject({ name: 'Weboldal' })
    createKanbanCard({ id: 'aaaa0001', title: 'Kezdolap szovege', status: 'in_progress', priority: 'high', project: p.id } as any)
    getDb().prepare('UPDATE projects SET updated_at = 1000 WHERE id = ?').run(p.id)
    let seenPrompt = ''
    setAiRunners({
      accounts: () => [ACCOUNT],
      claude: async (_s, prompt) => { seenPrompt = prompt; return { text: '{"summary":"A kezdolap szovege keszul."}', model: 'claude-opus-4-8' } },
      ollama: async () => 'missing',
    })
    const out = await summarizeProject(p.id, 'hu')
    expect(out.ok).toBe(true)
    const row = getProject(p.id)!
    expect(row.summary).toBe('A kezdolap szovege keszul.')
    expect(row.summary_by).toBe('claude:claude-opus-4-8')
    expect(row.summary_at).toBeGreaterThan(0)
    expect(row.updated_at).toBe(1000)
    // A modell a mert tenyeket kapja -- a kartya cimet igen, kitalalt dolgot nem.
    expect(seenPrompt).toContain('"Kezdolap szovege"')
    expect(seenPrompt).toContain('Answer language: Hungarian')
  })

  it('kimerult Claude-fiok utan a helyi modell valaszol', async () => {
    const p = mustProject({ name: 'Helyi' })
    setAiRunners({
      accounts: () => [ACCOUNT],
      claude: async () => 'limit',
      ollama: async () => ({ text: '{"summary":"Helyi osszefoglalo."}', model: 'qwen2.5' }),
    })
    const out = await summarizeProject(p.id, 'en')
    expect(out).toMatchObject({ ok: true, engine: 'ollama', model: 'qwen2.5' })
    expect(getProject(p.id)!.summary_by).toBe('ollama:qwen2.5')
  })

  it('AI nelkul "no_ai", hasznalhatatlan valasznal "no_answer" -- es semmi nem mentodik', async () => {
    const p = mustProject({ name: 'Nincs AI' })
    setAiRunners({ accounts: () => [], ollama: async () => 'missing' })
    expect(await summarizeProject(p.id, 'hu')).toEqual({ ok: false, code: 'no_ai' })
    setAiRunners({ accounts: () => [ACCOUNT], claude: async () => ({ text: 'nem json', model: 'x' }), ollama: async () => null })
    expect(await summarizeProject(p.id, 'hu')).toEqual({ ok: false, code: 'no_answer' })
    expect(getProject(p.id)!.summary).toBeNull()
  })

  it('egy projektre egyszerre egy keszites fut (dupla kattintas)', async () => {
    const p = mustProject({ name: 'Dupla' })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    setAiRunners({
      accounts: () => [ACCOUNT],
      claude: async () => { await gate; return { text: '{"summary":"Kesz."}', model: 'm' } },
    })
    const first = summarizeProject(p.id, 'hu')
    expect(await summarizeProject(p.id, 'hu')).toEqual({ ok: false, code: 'busy' })
    release()
    expect((await first).ok).toBe(true)
  })

  it('a vegpont: 503 + emberi mondat, ha nincs AI; 200 + a frissitett projekt, ha van', async () => {
    const p = mustProject({ name: 'Vegpont' })
    setAiRunners({ accounts: () => [], ollama: async () => 'missing' })
    const bad = await call('POST', `/api/projects/${p.id}/summary?lang=en`)
    expect(bad.status).toBe(503)
    expect(bad.body.error).toBe('no_ai')
    expect(bad.body.message).toMatch(/No AI/)
    setAiRunners({ accounts: () => [ACCOUNT], claude: async () => ({ text: '{"summary":"Rendben."}', model: 'm' }) })
    const good = await call('POST', `/api/projects/${p.id}/summary`)
    expect(good.status).toBe(200)
    expect(good.body.project.summary).toBe('Rendben.')
  })

  it('a tenyek szovege: lejart hatarido jelolve, ures listaknal "none"', () => {
    const p = mustProject({ name: 'Tenyek', client: 'Kovacs Bt.' })
    const past = Math.floor(Date.now() / 1000) - 3 * 86400
    createKanbanCard({ id: 'aaaa0002', title: 'Szamla', status: 'planned', priority: 'normal', project: p.id, due_date: past } as any)
    const facts = summaryFacts(getProject(p.id)!, buildProjectOverview(p.id)!, 'en')
    expect(facts).toContain('For (client): Kovacs Bt.')
    expect(facts).toMatch(/"Szamla".*OVERDUE/)
    expect(facts).toContain("Waiting for the owner's approval:\n- none")
  })
})

describe('otletek a projektben', () => {
  it('az uj otlet a projekthez kotve szuletik, es a projekt Otletek listajaban van', async () => {
    const p = mustProject({ name: 'Otletes' })
    const r = await call('POST', `/api/projects/${p.id}/ideas`, { title: 'Hirlevel', description: 'havonta' })
    expect(r.status).toBe(200)
    const list = listProjectIdeas(p.id)
    expect(list.map((i) => [i.id, i.title, i.via])).toEqual([[r.body.id, 'Hirlevel', 'link']])
    expect((await call('POST', `/api/projects/${p.id}/ideas`, { title: '  ' })).body.error).toBe('title_required')
  })

  it('kothetok: csak a meg sehova nem tartozok (se kotes, se projektbe sorolt kartya), elvetett nem', () => {
    const a = mustProject({ name: 'A' })
    const b = mustProject({ name: 'B' })
    createKanbanCard({ id: 'cccc0001', title: 'A kartyaja', status: 'planned', priority: 'normal', project: a.id } as any)
    createKanbanCard({ id: 'cccc0002', title: 'Regi szoveg', status: 'planned', priority: 'normal', project: 'marveen' } as any)
    const idea = (id: string, status: string, kanban: string | null) => createIdea({ id, title: id, description: null, category: 'Egyéb', status: status as any, source: 'manual', kanban_id: kanban, impact: null, effort: null })
    idea('i-szabad', 'new', null)
    idea('i-kotott', 'new', null)
    idea('i-kartya', 'kanban', 'cccc0001')
    idea('i-regi', 'kanban', 'cccc0002')
    idea('i-elvetett', 'rejected', null)
    linkObject(b.id, 'idea', 'i-kotott')
    expect(projectIdeaCandidates().map((c) => c.id).sort()).toEqual(['i-regi', 'i-szabad'])
    // A kartyan at levezetett otlet is a projekte (via: card).
    expect(listProjectIdeas(a.id).map((i) => [i.id, i.via])).toEqual([['i-kartya', 'card']])
  })

  it('kotes es bontas: a bontas utan az otlet megmarad, csak projekt nelkul', async () => {
    const p = mustProject({ name: 'Kotes' })
    createIdea({ id: 'i-1', title: 'Egy', description: null, category: 'Egyéb', status: 'new', source: 'manual', kanban_id: null, impact: null, effort: null })
    expect((await call('POST', `/api/projects/${p.id}/links`, { type: 'idea', id: 'i-1' })).status).toBe(200)
    expect(listProjectIdeas(p.id).map((i) => i.id)).toEqual(['i-1'])
    expect((await call('POST', `/api/projects/${p.id}/links`, { type: 'idea', id: 'nincs' })).body.error).toBe('idea_missing')
    expect((await call('POST', `/api/projects/${p.id}/links`, { type: 'memory', id: 'x' })).body.error).toBe('bad_link')
    const del = await call('DELETE', `/api/projects/${p.id}/links/idea/i-1`)
    expect(del.status).toBe(200)
    expect(listProjectIdeas(p.id)).toEqual([])
    expect(getDb().prepare('SELECT id FROM idea_box WHERE id = ?').get('i-1')).toBeTruthy()
    expect((await call('DELETE', `/api/projects/${p.id}/links/idea/i-1`)).body.error).toBe('not_linked')
  })
})

describe('uj fajl a projektmappaba', () => {
  function withFolder(name = 'Projektek/Web') {
    mkdirSync(join(depot, ...name.split('/')), { recursive: true })
    return mustProject({ name: 'Web', folder_path: name })
  }

  it('mappa nelkul / Raktar nelkul / eltunt mappaval kulon hibakod', () => {
    const none = mustProject({ name: 'Mappa nelkul' })
    expect(writeProjectFile(none, '', 'a.txt', Buffer.from('x'))).toMatchObject({ ok: false, code: 'no_folder' })
    const gone = mustProject({ name: 'Eltunt', folder_path: 'Projektek/Nincs' })
    expect(writeProjectFile(gone, '', 'a.txt', Buffer.from('x'))).toMatchObject({ ok: false, code: 'missing' })
    delete process.env.MARVEEN_DEPOT
    expect(writeProjectFile(gone, '', 'a.txt', Buffer.from('x'))).toMatchObject({ ok: false, code: 'no_depot' })
  })

  it('soha nem ir felul: foglalt nevnel "(2)" utotag, es a valasz megmondja', () => {
    const p = withFolder()
    const first = writeProjectFile(p, '', 'Ajánlat.pdf', Buffer.from('1'))
    const second = writeProjectFile(p, '', 'Ajánlat.pdf', Buffer.from('2'))
    expect(first).toMatchObject({ ok: true, name: 'Ajánlat.pdf', renamed: false })
    expect(second).toMatchObject({ ok: true, name: 'Ajánlat (2).pdf', renamed: true })
    expect(readFileSync(join(depot, 'Projektek', 'Web', 'Ajánlat.pdf'), 'utf-8')).toBe('1')
  })

  it('almappaba ir, de a projekt mappajabol kilepni nem lehet', () => {
    const p = withFolder()
    mkdirSync(join(depot, 'Projektek', 'Web', 'Tudásbázis'))
    mkdirSync(join(depot, 'Projektek', 'Masik'))
    expect(writeProjectFile(p, 'Tudásbázis', 'jegyzet.txt', Buffer.from('x'))).toMatchObject({ ok: true, rel: 'Projektek/Web/Tudásbázis/jegyzet.txt' })
    expect(writeProjectFile(p, '../Masik', 'x.txt', Buffer.from('x'))).toMatchObject({ ok: false, code: 'bad_folder' })
    expect(writeProjectFile(p, 'Nincs-ilyen', 'x.txt', Buffer.from('x'))).toMatchObject({ ok: false, code: 'bad_folder' })
    // A fajlnevben levo ut elvesz: csak a nev marad.
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('.rejtett')).toBeNull()
    expect(existsSync(join(depot, 'Projektek', 'Masik', 'x.txt'))).toBe(false)
  })

  it('git-repo belsejebe nem ir', () => {
    const p = withFolder()
    mkdirSync(join(depot, 'Projektek', 'Web', '.git'))
    expect(writeProjectFile(p, '', 'a.txt', Buffer.from('x'))).toMatchObject({ ok: false, code: 'repo_inside' })
  })

  it('jegyzet: .md alapbol, .txt kerésre, dupla kiterjesztes nelkul', () => {
    const p = withFolder()
    expect(writeProjectNote(p, '', 'Teendők', '# Lista', undefined)).toMatchObject({ ok: true, name: 'Teendők.md' })
    expect(writeProjectNote(p, '', 'Hívások.txt', 'x', 'txt')).toMatchObject({ ok: true, name: 'Hívások.txt' })
    expect(writeProjectNote(p, '', '  ', 'x', 'md')).toMatchObject({ ok: false, code: 'bad_name' })
    expect(readFileSync(join(depot, 'Projektek', 'Web', 'Teendők.md'), 'utf-8')).toBe('# Lista')
  })

  it('almappak listaja: a rejtettek nelkul, nev szerint', () => {
    const p = withFolder()
    for (const d of ['Tovabbi anyagok', '.git', 'Arajanlatok']) mkdirSync(join(depot, 'Projektek', 'Web', d))
    writeFileSync(join(depot, 'Projektek', 'Web', 'fajl.txt'), 'x')
    expect(projectSubfolders(p)).toEqual(['Arajanlatok', 'Tovabbi anyagok'])
  })

  it('feltoltes a vegponton: nyers bajtok, ekezetes nev a query-ben; tul nagy fajl 413', async () => {
    const p = withFolder()
    const r = await call('POST', `/api/projects/${p.id}/upload?name=${encodeURIComponent('Szerződés.pdf')}`, Buffer.from('%PDF-1'))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, name: 'Szerződés.pdf', bytes: 6 })
    expect(readFileSync(join(depot, 'Projektek', 'Web', 'Szerződés.pdf'), 'utf-8')).toBe('%PDF-1')
    const big: any = await (async () => {
      const out: any = { status: 0, body: null }
      const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
      const url = new URL(`http://localhost:3420/api/projects/${p.id}/upload?name=nagy.bin`)
      const req: any = { headers: { 'content-length': String(60 * 1024 * 1024) }, on() { return req }, destroy() {} }
      await tryHandleProjects({ req, res, path: url.pathname, method: 'POST', url } as RouteContext)
      return out
    })()
    expect(big.status).toBe(413)
    expect(big.body.error).toBe('too_large')
    const folders = await call('GET', `/api/projects/${p.id}/folders`)
    expect(folders.body).toMatchObject({ state: 'ok', path: 'Projektek/Web', subfolders: [] })
  })
})

describe('alapertelmezett cimke', () => {
  it('a projektben cimke nelkul kert kartya a projekt cimkejet kapja; torolt cimke nem akaszt', async () => {
    createLabel({ id: 'lab-web', name: 'web', color: '#123456' })
    createLabel({ id: 'lab-mas', name: 'mas', color: '#654321' })
    const p = mustProject({ name: 'Cimkes', default_label_id: 'lab-web' })
    expect(projectDefaultLabel(p.id)).toBe('lab-web')
    expect(projectDefaultLabel('Cimkes')).toBe('lab-web')
    expect(projectDefaultLabel('ismeretlen')).toBeUndefined()

    const made = await call('POST', '/api/kanban', { title: 'Uj kartya a projektbol', project: p.id, related: [] }, tryHandleKanban)
    expect(made.status).toBeLessThan(300)
    const cardId = made.body.id ?? made.body.card?.id
    expect(getLabelsForCard(cardId).map((l: { id: string }) => l.id)).toEqual(['lab-web'])

    // Ha a kero megnevez cimket, az nyer.
    const named = await call('POST', '/api/kanban', { title: 'Masik kartya kezzel', project: p.id, labels: ['lab-mas'], related: [] }, tryHandleKanban)
    expect(getLabelsForCard(named.body.id ?? named.body.card?.id).map((l: { id: string }) => l.id)).toEqual(['lab-mas'])

    deleteLabel('lab-web')
    expect(projectDefaultLabel(p.id)).toBeUndefined()
    updateProject(p.id, { default_label_id: null })
  })
})
