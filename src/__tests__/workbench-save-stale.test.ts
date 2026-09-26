// #406 bugkereses 6+7: ket ful EGYSZERRE ment ugyanarra a verziora.
// A route elejen betoltott munkadarab az `await readJson/readBody` ELOTTI
// pillanatkep volt, ezert a masodik mentes a regi verzioszammal is atment, es
// az elso modositasa csendben kiesett a mostani verziobol. Most az await UTAN
// a DB-bol olvassuk ujra: a masodik 409-et kap, emberi mondattal.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let depot = ''
let pid = ''

beforeEach(() => {
  initDatabase(':memory:')
  depot = mkdtempSync(join(tmpdir(), 'marveen-wb-stale-'))
  mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
  process.env['MARVEEN_DEPOT'] = depot
  const p = createProject({ name: 'Kovács ház' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
  if (!up.ok) throw new Error('mappa')
})

afterEach(() => {
  rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

function textItem(name: string, body: string): string {
  writeFileSync(join(depot, 'Projektek', 'teszt', name), body)
  const w = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'note', source_path: `Projektek/teszt/${name}` })
  if (!w.ok) throw new Error('munkadarab')
  return w.item.id
}

function currentVersion(id: string): string {
  return getWorkItem(id)!.current_version_id || ''
}

function statuses(rs: { status: number }[]): number[] {
  return rs.map((r) => r.status).sort()
}

describe('ket egyszerre mento ful: a masodik nem irhatja felul csendben az elsot', () => {
  it('tablazat: ket parhuzamos mentes ugyanarrol a verziorol -> egy 201, egy 409 table_stale', async () => {
    const c = await callWorkbench('/api/workbench/items/new-table', 'POST', { project_id: pid, title: 'Lista' })
    const itemId = c.body.item.id
    const g = await callWorkbench(`/api/workbench/items/${itemId}/table`, 'GET')
    const save = (cell: string) => callWorkbench(`/api/workbench/items/${itemId}/table`, 'POST', {
      base_version: g.body.version_id, sheets: [{ name: 'Munka1', rows: [[cell]] }],
    })
    const rs = await Promise.all([save('A ful'), save('B ful')])
    expect(statuses(rs)).toEqual([201, 409])
    expect(rs.find((r) => r.status === 409)!.body.error).toBe('table_stale')
  })

  it('szoveg: base_version-nel ket parhuzamos mentes -> egy 201, egy 409 version_stale emberi mondattal', async () => {
    const id = textItem('terv.md', 'eredeti')
    const base = currentVersion(id)
    const save = (text: string) => callWorkbench(`/api/workbench/items/${id}/text`, 'POST', { text, base_version: base })
    const rs = await Promise.all([save('A ful'), save('B ful')])
    expect(statuses(rs)).toEqual([201, 409])
    const lost = rs.find((r) => r.status === 409)!
    expect(lost.body.error).toBe('version_stale')
    expect(lost.body.message).toMatch(/Közben új verzió készült/)
  })

  it('szoveg: elavult base_version -> 409, nem keletkezik uj verzio; base_version NELKUL a korabbi viselkedes marad', async () => {
    const id = textItem('b.md', 'eredeti')
    const base = currentVersion(id)
    expect((await callWorkbench(`/api/workbench/items/${id}/text`, 'POST', { text: 'elso', base_version: base })).status).toBe(201)
    const afterFirst = currentVersion(id)
    const stale = await callWorkbench(`/api/workbench/items/${id}/text`, 'POST', { text: 'masodik', base_version: base })
    expect(stale.status).toBe(409)
    expect(currentVersion(id)).toBe(afterFirst)
    expect((await callWorkbench(`/api/workbench/items/${id}/text?lang=en`, 'POST', { text: 'x', base_version: base })).body.message)
      .toMatch(/newer version/)
    expect((await callWorkbench(`/api/workbench/items/${id}/text`, 'POST', { text: 'regi felulet' })).status).toBe(201)
  })

  it('dokumentum visszatoltese: elavult base_version -> 409 version_stale; a mostanival 201', async () => {
    const id = textItem('level.docx', 'docx-v1')
    const base = currentVersion(id)
    const up = (b: string) => callWorkbench(
      `/api/workbench/items/${id}/document?name=level.docx&base_version=${encodeURIComponent(b)}`, 'POST',
      Buffer.from('docx-v2'), { 'content-type': 'application/octet-stream' },
    )
    expect((await up(base)).status).toBe(201)
    const stale = await up(base)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toBe('version_stale')
  })
})
