// Otletlada: archivalas torles helyett (kanban #422, Boss 2026-09-27).
//
// Amit ez a teszt orzi:
//   - egy elo otlet NEM torolheto: a DELETE 409-et ad, emberi mondattal;
//   - az archivalt otlet kikerul a listabol es a projekt otletei kozul,
//     ?archived=1 alatt viszont ott van, es onnan visszaallithato;
//   - veglegesen torolni csak archivalt otletet lehet;
//   - a felulet: nincs kozvetlen Torol gomb, az athelyezo legordulo mas
//     feliratot kap, mint a szuro, es minden uj szoveg HU+EN.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, listProjectIdeas, projectIdeaCandidates } from '../projects.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'
import type { RouteContext } from '../web/routes/types.js'

function call(method: string, pathAndQuery: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
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
    destroy() { /* no socket */ },
  }
  return tryHandleIdeas({ req, res, path: url.pathname, method, url } as RouteContext).then(() => out)
}

const titles = (r: { body: any }) => (r.body as { title: string }[]).map((i) => i.title)

beforeEach(() => { initDatabase(':memory:') })

describe('Otletlada archivalas (#422)', () => {
  it('elo otlet nem torolheto: 409 emberi mondattal, az otlet megmarad', async () => {
    const a = await call('POST', '/api/ideas', { title: 'Szokokut' })
    const del = await call('DELETE', `/api/ideas/${a.body.id}?lang=hu`)
    expect(del.status).toBe(409)
    expect(del.body.error).toBe('not_archived')
    expect(del.body.message).toMatch(/archiválni/)
    expect(titles(await call('GET', '/api/ideas'))).toEqual(['Szokokut'])
  })

  it('archival -> eltunik a listabol, az archivumban ott van, visszaallithato', async () => {
    const a = await call('POST', '/api/ideas', { title: 'Szokokut' })
    await call('POST', '/api/ideas', { title: 'Marad' })
    expect((await call('POST', `/api/ideas/${a.body.id}/archive`)).body.ok).toBe(true)
    expect(titles(await call('GET', '/api/ideas'))).toEqual(['Marad'])
    expect(titles(await call('GET', '/api/ideas?archived=1'))).toEqual(['Szokokut'])

    expect((await call('POST', `/api/ideas/${a.body.id}/unarchive`)).body.ok).toBe(true)
    expect(titles(await call('GET', '/api/ideas')).sort()).toEqual(['Marad', 'Szokokut'])
    expect(titles(await call('GET', '/api/ideas?archived=1'))).toEqual([])
  })

  it('veglegesen torolni csak az archivumbol lehet', async () => {
    const a = await call('POST', '/api/ideas', { title: 'Szokokut' })
    await call('POST', `/api/ideas/${a.body.id}/archive`)
    const del = await call('DELETE', `/api/ideas/${a.body.id}`)
    expect(del.body.ok).toBe(true)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM idea_box').get()).toEqual({ n: 0 })
  })

  it('nem letezo otlet: 404, nem 409', async () => {
    expect((await call('POST', '/api/ideas/nincs/archive')).status).toBe(404)
    expect((await call('DELETE', '/api/ideas/nincs')).status).toBe(404)
  })

  it('az archivalt otlet a projekt otletei es a kotheto jeloltek kozul is kikerul', async () => {
    const r = createProject({ name: 'Kert' })
    if (!r.ok) throw new Error(r.code)
    const a = await call('POST', '/api/ideas', { title: 'Szokokut', project: r.project.id })
    const b = await call('POST', '/api/ideas', { title: 'Szabad' })
    expect(listProjectIdeas(r.project.id).map((i) => i.title)).toEqual(['Szokokut'])
    await call('POST', `/api/ideas/${a.body.id}/archive`)
    await call('POST', `/api/ideas/${b.body.id}/archive`)
    expect(listProjectIdeas(r.project.id)).toEqual([])
    expect(projectIdeaCandidates().map((i) => i.title)).not.toContain('Szabad')
    // A projekt-szuro az archivumban is mukodik.
    expect(titles(await call('GET', `/api/ideas?archived=1&project=${r.project.id}`))).toEqual(['Szokokut'])
  })
})

describe('ures kategoria (#422)', () => {
  it('ures kategoriaval felvett otlet az alap kategoriat kapja; a PUT nem uriti ki', async () => {
    const a = await call('POST', '/api/ideas', { title: 'X', category: '  ' })
    const row = () => getDb().prepare('SELECT category FROM idea_box WHERE id = ?').get(a.body.id) as { category: string }
    expect(row().category).toBe('Egyéb')
    await call('PUT', `/api/ideas/${a.body.id}`, { category: '' })
    expect(row().category).toBe('Egyéb')
  })
})

describe('felulet (#422)', () => {
  const root = join(__dirname, '..', '..')
  const app = readFileSync(join(root, 'web/app.js'), 'utf-8')
  const hu = readFileSync(join(root, 'web/lang/hu.js'), 'utf-8')
  const en = readFileSync(join(root, 'web/lang/en.js'), 'utf-8')

  it('az otlet-kartyan nincs kozvetlen torles, helyette Archival; vegleges torles csak archivaltnal', () => {
    expect(app).not.toMatch(/deleteIdeaItem\(/)
    expect(app).toMatch(/archiveIdeaItem\('/)
    expect(app).toMatch(/idea\.archived_at \? `[^`]*purgeIdeaItem/)
  })

  it('az athelyezo legordulo sajat feliratot es magyarazatot kap, a szuro mast', () => {
    const row = app.slice(app.indexOf('function _prjAssignRowHtml'), app.indexOf('function _prjAssignRowHtml') + 900)
    expect(row).toContain("t('projects.assign.label')")
    expect(row).toContain("t('projects.assign.hint')")
    expect(hu).toContain('"projects.scope.label": "Szűrés projekt szerint:"')
    expect(en).toContain('"projects.scope.label": "Filter by project:"')
  })

  it('minden uj szoveg mindket nyelven megvan', () => {
    for (const k of ['ideas.filter.status_archived', 'ideas.btn.archive', 'ideas.btn.unarchive', 'ideas.btn.purge',
      'ideas.archive.hint', 'ideas.archive.empty', 'ideas.archive.purge_confirm', 'ideas.empty_in_project',
      'projects.assign.label', 'projects.assign.hint', 'research.empty_in_project', 'debate.empty_in_project']) {
      expect(hu, k).toMatch(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]\\s*:`))
      expect(en, k).toMatch(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]\\s*:`))
    }
  })
})
