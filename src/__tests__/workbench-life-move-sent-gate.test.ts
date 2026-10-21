// Boss TG 4059-4068: "Move to the Life tree" only moves a document that was SENT; of its generated files only the sent
// version goes to the Life tree (the older ones to the Trash, restorable); the place is read from where the document lives.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lifemove-gate-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-lifemove-gate-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { explorerRoot } = await import('../life-explorer.js')
const { loadLifeConfig, saveLifeConfig } = await import('../life-tree.js')
const { initDatabase, getDb } = await import('../db.js')
const { createProject, updateProject, getProject } = await import('../projects.js')
const { createWorkItem, getWorkItem } = await import('../workbench.js')
const { lifeMovePlan, moveItemFilesToLife, suggestForPlan } = await import('../workbench-life-move.js')
const { markSentManually, sentStatus, ensureDocSentTables } = await import('../workbench-docsent.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) throw new Error('not on the temporary depot')

const CONT = 'Munkadarabok/Szochivatal Bakos Eva/Szocialis hivatalnak email AOK elutasitas ugyben'
const FIN = 'Elkészített anyagok'

function setup() {
  initDatabase(':memory:')
  for (const o of ['Sozialamt', 'Szocialis hivatal', 'AOK']) mkdirSync(join(root, 'Bakos Éva', 'Hatóságok', 'Németország', o), { recursive: true })
  saveLifeConfig({ ...loadLifeConfig(), persons: [{ id: 'p1', name: 'Bakos Éva', role: 'person', countries: [], mediaGroups: [] }] } as any)
  const p = createProject({ name: 'Nemet hivatalok dolgai' })
  if (!p.ok) throw new Error('projekt')
  const base = join(root, 'Projektek', 'Nemet')
  mkdirSync(join(base, CONT, FIN), { recursive: true })
  mkdirSync(join(base, CONT, 'Feltöltések'), { recursive: true })
  updateProject(p.project.id, { folder_path: 'Projektek/Nemet' })
  const mk = (title: string, src: string) => {
    writeFileSync(join(base, CONT, src), 'x')
    const w = createWorkItem({ project_id: p.project.id, title, type: 'document', source_path: `${CONT}/${src}`, container_folder: CONT } as any)
    if (!w.ok) throw new Error('munkadarab')
    return w.item.id
  }
  const a = mk('Antrag auf Pflegegeld nach SGB XII - Bakos Éva', 'Antrag.docx')
  const b = mk('Sozialamt Chemnitz Pflegesituation Bakos Éva', 'Sozialamt.docx')
  const fin = (item: string, n: number, file: string) => {
    writeFileSync(join(base, CONT, FIN, file), 'pdf' + file)
    const id = `v-${item}-${n}`
    getDb().prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
      .run(id, item, 10 + n, 1000 + n, JSON.stringify({ final: true, label: 'Végleges', content_hash: 'h' + n, pdf_path: `${CONT}/${FIN}/${file}`, pdf_name: file }))
    return id
  }
  const a1 = fin(a, 1, 'Antrag v1.pdf')
  fin(a, 2, 'Antrag v2.pdf')
  fin(b, 1, 'Sozialamt v1.pdf')
  writeFileSync(join(base, CONT, 'Feltöltések', 'AOK PLUS elutasito level.pdf'), 'up')
  return { project: getProject(p.project.id) as any, a, b, a1 }
}

describe('Költöztetés: csak az elküldött irat, csak az elküldött verzió', () => {
  it('küldés nélkül minden blokkolt, és a POST nem mozgat semmit', () => {
    const { project, a } = setup()
    const item = getWorkItem(a) as any
    const plan = lifeMovePlan(project, item, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.length).toBeGreaterThan(0)
    expect(plan.files.filter((f) => f.item_id === a).every((f) => f.action === 'blocked' && f.note === 'not_sent')).toBe(true)
    expect(plan.gates.find((g) => g.item_id === a)?.sent).toBe(false)
    const r = moveItemFilesToLife(project, item, [{ rel: plan.files[0].rel, target: 'Bakos Éva' }], 'hu', 'include')
    expect(r.ok && r.results.every((x) => !x.ok)).toBe(true)
    expect(existsSync(join(root, 'Projektek', 'Nemet', CONT, FIN, 'Antrag v2.pdf'))).toBe(true)
  })

  it('a munkadarab saját dokumentuma nem kerül a listára; a másik munkadarab fájlja külön csoport', () => {
    const { project, a } = setup()
    const plan = lifeMovePlan(project, getWorkItem(a) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.map((f) => f.name)).not.toContain('Antrag.docx')
    expect(plan.files.map((f) => f.name)).not.toContain('Sozialamt.docx')
    const other = plan.files.find((f) => f.name === 'Sozialamt v1.pdf')
    expect(other?.group).toBe('other')
    expect(plan.files.find((f) => f.name === 'Antrag v1.pdf')?.group).toBe('this')
  })

  it('kézi jelölés (5A): a legutolsó végleges megy, a régebbi a Kukába; a másik irat nem érintett', () => {
    const { project, a, b } = setup()
    markSentManually(a, null)
    const item = getWorkItem(a) as any
    const plan = lifeMovePlan(project, item, 'include')
    if (!plan.ok) throw new Error('terv')
    const by = Object.fromEntries(plan.files.map((f) => [f.name, f]))
    expect(by['Antrag v2.pdf'].action).toBe('move')
    expect(by['Antrag v2.pdf'].sent_final).toBe(true)
    expect(by['Antrag v1.pdf'].action).toBe('trash')
    expect(by['AOK PLUS elutasito level.pdf'].action).toBe('move')
    expect(by['Sozialamt v1.pdf'].action).toBe('blocked')
    const r = moveItemFilesToLife(project, item, [{ rel: by['Antrag v2.pdf'].rel, target: 'Bakos Éva/Hatóságok/Németország/Sozialamt' }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(r.results.find((x) => !x.trashed)?.ok).toBe(true)
    expect(existsSync(join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'Sozialamt', 'Antrag v2.pdf'))).toBe(true)
    const fin = join(root, 'Projektek', 'Nemet', CONT, FIN)
    expect(readdirSync(fin)).toEqual(['Sozialamt v1.pdf'])
    expect(readdirSync(join(root, 'Kuka')).length).toBeGreaterThan(0)
    expect(sentStatus(b).sent).toBe(false)
  })

  it('rögzített küldés: AZ megy, amelyik tényleg elment, még ha nem a legújabb', () => {
    const { project, a, a1 } = setup()
    ensureDocSentTables()
    getDb().prepare('INSERT INTO wb_doc_sent (id, work_item_id, version_id, sent_date, recipient, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('s1', a, a1, '2026-10-16', 'Sozialamt', 'email', 1)
    const plan = lifeMovePlan(project, getWorkItem(a) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    const by = Object.fromEntries(plan.files.map((f) => [f.name, f]))
    expect(by['Antrag v1.pdf'].action).toBe('move')
    expect(by['Antrag v2.pdf'].action).toBe('trash')
  })

  it('javaslat: a mappa nevéből Bakos Éva / Hatóságok / Németország, bizonytalan hivatalnál pirosra jelölve', async () => {
    const { project, a } = setup()
    markSentManually(a, null)
    const item = getWorkItem(a) as any
    const plan = lifeMovePlan(project, item, 'include')
    if (!plan.ok) throw new Error('terv')
    const sug = await suggestForPlan(project, item, plan.files, 'hu')
    const s = sug.get(plan.files.find((f) => f.name === 'Antrag v2.pdf')!.rel)
    expect(s?.suggested_target.startsWith('Bakos Éva/Hatóságok/Németország/')).toBe(true)
    expect(s?.suggested_target.toLowerCase()).not.toContain('korpás')
  })
})
