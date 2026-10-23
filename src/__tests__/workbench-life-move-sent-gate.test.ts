// Boss TG 4059-4068: "Move to the Life tree" only moves a document that was SENT; of its generated files only the sent
// version goes to the Life tree (the older ones to the Trash, restorable); the place is read from where the document lives.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, renameSync, utimesSync } from 'node:fs'
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
const { addMount } = await import('../life-mounts.js')
const { ensureAssetTables } = await import('../workbench-assets.js')

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

  // #742 (Boss TG 4159): the recorded sent PDF was deleted by hand; the one generated file left is the letter now.
  it('a rögzített elküldött PDF kitörölve: a megmaradt végleges PDF megy az Életfába, NEM a Kukába', () => {
    const { project, b } = setup()
    markSentManually(b, null)
    const fin = join(root, 'Projektek', 'Nemet', CONT, FIN)
    rmSync(join(fin, 'Sozialamt v1.pdf'))
    writeFileSync(join(fin, 'Sozialamt végleges (2).pdf'), 'sent')
    ensureAssetTables()
    getDb().prepare('INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('as1', b, `Projektek/Nemet/${CONT}/${FIN}/Sozialamt végleges (2).pdf`, 'Sozialamt végleges (2).pdf', 'final', '', 0, 1)
    const item = getWorkItem(b) as any
    const plan = lifeMovePlan(project, item, 'include')
    if (!plan.ok) throw new Error('terv')
    const f = plan.files.find((x) => x.name === 'Sozialamt végleges (2).pdf')
    expect(f?.action).toBe('move')
    expect(f?.sent_final).toBe(true)
    const r = moveItemFilesToLife(project, item, [{ rel: f!.rel, target: 'Bakos Éva/Hatóságok/Németország/Sozialamt' }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(r.results.some((x) => x.trashed)).toBe(false)
    expect(existsSync(join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'Sozialamt', 'Sozialamt végleges (2).pdf'))).toBe(true)
  })

  it('az elküldött PDF már az Életfában (link maradt a helyén): a régebbi változat mehet a Kukába', () => {
    const { project, b } = setup()
    markSentManually(b, null)
    const fin = join(root, 'Projektek', 'Nemet', CONT, FIN)
    const target = join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'Sozialamt')
    renameSync(join(fin, 'Sozialamt v1.pdf'), join(target, 'Sozialamt v1.pdf'))
    addMount({ rel: `Projektek/Nemet/${CONT}/${FIN}/Sozialamt v1.pdf`, target: 'Bakos Éva/Hatóságok/Németország/Sozialamt/Sozialamt v1.pdf', kind: 'local', file: true })
    writeFileSync(join(fin, 'Sozialamt piszkozat.pdf'), 'old')
    ensureAssetTables()
    getDb().prepare('INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('as2', b, `Projektek/Nemet/${CONT}/${FIN}/Sozialamt piszkozat.pdf`, 'Sozialamt piszkozat.pdf', 'final', '', 0, 1)
    const plan = lifeMovePlan(project, getWorkItem(b) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.find((x) => x.name === 'Sozialamt piszkozat.pdf')?.action).toBe('trash')
  })

  // #742: a link whose file is gone proves nothing -- the remaining final must not go to the Trash.
  it('az Életfába vitt elküldött PDF azóta eltűnt (törött link): a megmaradt végleges PDF megy, NEM a Kukába', () => {
    const { project, b } = setup()
    markSentManually(b, null)
    const fin = join(root, 'Projektek', 'Nemet', CONT, FIN)
    const target = join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'Sozialamt')
    renameSync(join(fin, 'Sozialamt v1.pdf'), join(target, 'Sozialamt v1.pdf'))
    addMount({ rel: `Projektek/Nemet/${CONT}/${FIN}/Sozialamt v1.pdf`, target: 'Bakos Éva/Hatóságok/Németország/Sozialamt/Sozialamt v1.pdf', kind: 'local', file: true })
    rmSync(join(target, 'Sozialamt v1.pdf'))
    writeFileSync(join(fin, 'Sozialamt végleges.pdf'), 'sent')
    ensureAssetTables()
    getDb().prepare('INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('as3', b, `Projektek/Nemet/${CONT}/${FIN}/Sozialamt végleges.pdf`, 'Sozialamt végleges.pdf', 'final', '', 0, 1)
    const plan = lifeMovePlan(project, getWorkItem(b) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.find((x) => x.name === 'Sozialamt végleges.pdf')?.action).toBe('move')
  })

  // #742: of the files left, a final PDF is the document -- a newer non-final generated file is not.
  it('a rögzített elküldött PDF kitörölve: a végleges PDF megy, nem az újabb nem-végleges fájl', () => {
    const { project, b } = setup()
    markSentManually(b, null)
    const fin = join(root, 'Projektek', 'Nemet', CONT, FIN)
    rmSync(join(fin, 'Sozialamt v1.pdf'))
    writeFileSync(join(fin, 'Sozialamt végleges.pdf'), 'sent')
    writeFileSync(join(fin, 'Sozialamt előnézet.pdf'), 'preview')
    utimesSync(join(fin, 'Sozialamt végleges.pdf'), 1000, 1000)
    ensureAssetTables()
    const ins = getDb().prepare('INSERT INTO work_item_assets (id, work_item_id, path, name, support, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    ins.run('as4', b, `Projektek/Nemet/${CONT}/${FIN}/Sozialamt végleges.pdf`, 'Sozialamt végleges.pdf', 'final', '', 0, 1)
    ins.run('as5', b, `Projektek/Nemet/${CONT}/${FIN}/Sozialamt előnézet.pdf`, 'Sozialamt előnézet.pdf', 'preview', '', 0, 2)
    const plan = lifeMovePlan(project, getWorkItem(b) as any, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.files.find((x) => x.name === 'Sozialamt végleges.pdf')?.action).toBe('move')
    expect(plan.files.find((x) => x.name === 'Sozialamt előnézet.pdf')?.action).toBe('trash')
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

  // #747: a document sent more than once: EVERY version that went out is a sent version; only the never-sent ones go to the Trash.
  it('több rögzített küldés: minden elküldött változat költözik, a Kukába csak a soha el nem küldött kerül', () => {
    const { project, a, a1 } = setup()
    ensureDocSentTables()
    const v2 = `v-${a}-2`
    const ins = getDb().prepare('INSERT INTO wb_doc_sent (id, work_item_id, version_id, sent_date, recipient, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('s1', a, a1, '2026-10-16', 'Sozialamt', 'email', 1)
    ins.run('s2', a, v2, '2026-10-20', 'Sozialamt', 'email', 2)
    const item = getWorkItem(a) as any
    const plan = lifeMovePlan(project, item, 'include')
    if (!plan.ok) throw new Error('terv')
    const by = Object.fromEntries(plan.files.map((f) => [f.name, f]))
    expect(by['Antrag v1.pdf']).toMatchObject({ action: 'move', sent_final: true })
    expect(by['Antrag v2.pdf']).toMatchObject({ action: 'move', sent_final: true })
    const target = 'Bakos Éva/Hatóságok/Németország/AOK'
    const r = moveItemFilesToLife(project, item, [{ rel: by['Antrag v1.pdf'].rel, target }, { rel: by['Antrag v2.pdf'].rel, target }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(r.results.every((x) => x.ok && !x.trashed)).toBe(true)
    expect(existsSync(join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'AOK', 'Antrag v1.pdf'))).toBe(true)
    expect(existsSync(join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'AOK', 'Antrag v2.pdf'))).toBe(true)
  })

  // #736: the other document of the folder has its own gate; marking IT as sent (the open document stays unsent) frees its files.
  it('a másik irat saját kapuja: külön jelölhető elküldöttnek, utána a fájlja költözik és link marad, a nyitott irat blokkolt marad', () => {
    // an earlier test's link at the same place would make the file look moved already
    rmSync(join(store, 'life-mounts.json'), { force: true })
    const { project, a, b } = setup()
    const item = getWorkItem(a) as any
    const before = lifeMovePlan(project, item, 'include')
    if (!before.ok) throw new Error('terv')
    expect(before.gates.find((g) => g.item_id === a)?.sent).toBe(false)
    expect(before.gates.find((g) => g.item_id === b)?.sent).toBe(false)
    expect(before.files.find((f) => f.name === 'Sozialamt v1.pdf')).toMatchObject({ group: 'other', item_id: b, action: 'blocked', note: 'not_sent' })

    markSentManually(b, null)
    const plan = lifeMovePlan(project, item, 'include')
    if (!plan.ok) throw new Error('terv')
    expect(plan.gates.find((g) => g.item_id === a)?.sent).toBe(false)
    expect(plan.gates.find((g) => g.item_id === b)?.sent).toBe(true)
    const other = plan.files.find((f) => f.name === 'Sozialamt v1.pdf')
    expect(other).toMatchObject({ group: 'other', item_id: b, action: 'move', sent_final: true })
    expect(plan.files.find((f) => f.name === 'Antrag v2.pdf')?.action).toBe('blocked')

    const r = moveItemFilesToLife(project, item, [{ rel: other!.rel, target: 'Bakos Éva/Hatóságok/Németország/Sozialamt' }], 'hu', 'include')
    if (!r.ok) throw new Error('mozgatas')
    expect(r.results.find((x) => !x.trashed)?.ok).toBe(true)
    expect(existsSync(join(root, 'Bakos Éva', 'Hatóságok', 'Németország', 'Sozialamt', 'Sozialamt v1.pdf'))).toBe(true)
    // the unmarked document's file stays where it was
    expect(existsSync(join(root, 'Projektek', 'Nemet', CONT, FIN, 'Antrag v2.pdf'))).toBe(true)
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
