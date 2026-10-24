// #748: on an item with a folder of its own, the item's OWN files (marveen-item.json, the content file the item points
// to, a drawing/deck JSON) are never candidates of the "move to the Life tree" list -- above all never 'trash': the
// Finished-materials branch used to send every owned-but-not-sent file there, and a content file that sits in that
// folder went to the Trash with it (data loss).
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lifemove-ownguard-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-lifemove-ownguard-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => ({ ...(await vi.importActual<typeof import('../config.js')>('../config.js')), STORE_DIR: store }))

const { explorerRoot } = await import('../life-explorer.js')
const { initDatabase, getDb } = await import('../db.js')
const { createProject, updateProject, getProject } = await import('../projects.js')
const { createWorkItem, getWorkItem } = await import('../workbench.js')
const { lifeMovePlan } = await import('../workbench-life-move.js')
const { markSentManually } = await import('../workbench-docsent.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temporary depot')

const FOLDER = 'Munkadarabok/Level'
const FIN = 'Elkészített anyagok'

function setup() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('projekt')
  const base = join(root, 'Projektek', 'Iroda')
  mkdirSync(join(base, FOLDER, FIN), { recursive: true })
  updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
  // the content file sits in Finished materials (a table's workbook / a copy kept there)
  const own = `${FOLDER}/${FIN}/Level.xlsx`
  writeFileSync(join(base, own), 'own')
  writeFileSync(join(base, FOLDER, 'marveen-item.json'), '{"id":"x"}')
  writeFileSync(join(base, FOLDER, 'Level.canvas.json'), '{}')
  writeFileSync(join(base, FOLDER, FIN, 'Level v1.pdf'), 'v1')
  writeFileSync(join(base, FOLDER, FIN, 'Level v2.pdf'), 'v2')
  const w = createWorkItem({ project_id: p.project.id, title: 'Level', type: 'document', source_path: own } as any)
  if (!w.ok) throw new Error('munkadarab')
  const id = w.item.id
  getDb().prepare('UPDATE work_items SET folder = ? WHERE id = ?').run(FOLDER, id)
  const fin = (n: number, file: string) => getDb().prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
    .run(`v-${n}`, id, 10 + n, 1000 + n, JSON.stringify({ final: true, label: 'F', content_hash: 'h' + n, pdf_path: `${FOLDER}/${FIN}/${file}`, pdf_name: file }))
  fin(1, 'Level v1.pdf'); fin(2, 'Level v2.pdf')
  // the source xlsx is also recorded as a generated twin of the item (owned by it)
  getDb().prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
    .run('v-x', id, 9, 900, JSON.stringify({ final: true, label: 'F', content_hash: 'hx', pdf_path: own, pdf_name: 'Level.xlsx' }))
  markSentManually(id, null)
  return { project: getProject(p.project.id) as any, id }
}

describe('#748: a munkadarab saját fájlja nem költöztetési jelölt', () => {
  it('sem a tartalmi fájl, sem a marveen-item.json, sem a rajz-JSON nem kerül a tervbe, kukába sem', () => {
    const { project, id } = setup()
    const plan = lifeMovePlan(project, getWorkItem(id) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    const names = plan.files.map((f) => f.name)
    expect(names).not.toContain('Level.xlsx')
    expect(names).not.toContain('marveen-item.json')
    expect(names).not.toContain('Level.canvas.json')
    expect(plan.files.filter((f) => f.action === 'trash').map((f) => f.name)).toEqual(['Level v1.pdf'])
  })

  it('ugyanez, ha a source_path Eletfa-relativ (megnyitas utan ezt tarolja a munkadarab)', () => {
    const { project, id } = setup()
    const lifeRel = `Projektek/Iroda/${FOLDER}/${FIN}/Level.xlsx`
    getDb().prepare('UPDATE work_items SET source_path = ? WHERE id = ?').run(lifeRel, id)
    getDb().prepare('UPDATE work_item_versions SET source_path = ? WHERE work_item_id = ? AND source_path IS NOT NULL').run(lifeRel, id)
    const plan = lifeMovePlan(project, getWorkItem(id) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.map((f) => f.name)).not.toContain('Level.xlsx')
    expect(plan.files.filter((f) => f.action === 'trash').map((f) => f.name)).toEqual(['Level v1.pdf'])
  })
})

// #748 (follow-up): in a shared folder of work items the guard must cover the SIBLINGS' own files too -- the plan of one
// document also lists (and trashes) the generated files of the other documents of the folder.
describe('#748: a közös mappa testvér-munkadarabjának saját fájlja sem költöztetési jelölt', () => {
  const CONT = 'Munkadarabok/Kozos'
  it('a testvér tartalmi fájlja (Elkészített anyagok mappában) nem kerül a tervbe, kukába sem', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda2' })
    if (!p.ok) throw new Error('projekt')
    const base = join(root, 'Projektek', 'Iroda2')
    mkdirSync(join(base, CONT, FIN), { recursive: true })
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda2' })
    const mk = (title: string, src: string) => {
      const w = createWorkItem({ project_id: p.project.id, title, type: 'document', source_path: src, container_folder: CONT } as any)
      if (!w.ok) throw new Error('munkadarab')
      return w.item.id
    }
    const sibSrc = `${CONT}/${FIN}/Testver.xlsx`
    writeFileSync(join(base, sibSrc), 'own')
    writeFileSync(join(base, CONT, 'Sajat.docx'), 'x')
    writeFileSync(join(base, CONT, 'Testver.docx'), 'x')
    const a = mk('Sajat', `${CONT}/Sajat.docx`)
    const b = mk('Testver', sibSrc)
    const fin = (item: string, n: number, file: string, path: string) => {
      getDb().prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
        .run(`v-${item}-${n}`, item, 10 + n, 1000 + n, JSON.stringify({ final: true, label: 'F', content_hash: 'h' + item + n, pdf_path: path, pdf_name: file }))
    }
    writeFileSync(join(base, CONT, FIN, 'Testver v1.pdf'), 'v1')
    writeFileSync(join(base, CONT, FIN, 'Testver v2.pdf'), 'v2')
    fin(b, 1, 'Testver v1.pdf', `${CONT}/${FIN}/Testver v1.pdf`)
    fin(b, 2, 'Testver v2.pdf', `${CONT}/${FIN}/Testver v2.pdf`)
    fin(b, 3, 'Testver.xlsx', sibSrc)
    markSentManually(b, null)
    const plan = lifeMovePlan(getProject(p.project.id) as any, getWorkItem(a) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.map((f) => f.name)).not.toContain('Testver.xlsx')
    // exactly one older generated PDF goes to the Trash (which one depends on the mtimes), never the content file
    const trashed = plan.files.filter((f) => f.action === 'trash').map((f) => f.name)
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(/^Testver v\d\.pdf$/)
  })
})
