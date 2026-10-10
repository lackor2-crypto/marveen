// #530, phase 1: a document of the Life tree is an annex WITHOUT a copy. The owner's
// condition (TG 8500): the same pension certificate must be attachable to several
// submissions, for several authorities, from its one place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { addAnnex, annexCheck, listAnnexes, removeAnnex, setAnnexPath } from '../workbench-docannex.js'
import { resolveProjectFile } from '../workbench-docmodel-world.js'
import { documentIdFor, hashDocument, moveDocumentsPrefix } from '../life-doc-ids.js'
import { linkLifeFileAsAnnex, linkedUsesUnder, tendLinkedAnnexes } from '../workbench-doc-links.js'

const CERT = 'Család/Anna/Hatóságok/Nyugdíj/nyugdijigazolas.pdf'

describe('a linked annex', () => {
  let depot = ''
  let projects: ProjectRow[] = []
  let items: string[] = []
  const abs = (rel: string) => join(depot, ...rel.split('/'))
  const resolveIn = (i: number) => (p: string) => resolveProjectFile(projects[i]!, p)

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-doclinks-'))
    process.env['MARVEEN_DEPOT'] = depot
    mkdirSync(join(abs(CERT), '..'), { recursive: true })
    writeFileSync(abs(CERT), 'PENSION-CERTIFICATE')
    projects = []; items = []
    for (const name of ['Jobcenter ügy', 'Sozialamt ügy']) {
      mkdirSync(abs(`Projektek/${name}`), { recursive: true })
      const p = createProject({ name })
      if (!p.ok) throw new Error('project')
      updateProject(p.project.id, { folder_path: `Projektek/${name}` })
      projects.push(getProject(p.project.id) as ProjectRow)
      const w = createWorkItem({ project_id: p.project.id, title: `Beadvány (${name})`, type: 'document' })
      if (!w.ok) throw new Error('item')
      items.push(w.item.id)
    }
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const allFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]))

  it('one certificate, two submissions in two projects, ONE file on the disk -- each list has its own number for it', async () => {
    writeFileSync(abs('Projektek/Sozialamt ügy/level.pdf'), 'x')
    const first = addAnnex(items[1]!, { path: 'level.pdf', title: 'Levél' }, resolveIn(1), 'teszt')
    expect(first.ok).toBe(true)
    const a = await linkLifeFileAsAnnex(items[0]!, CERT, { title: 'Nyugdíjigazolás' }, resolveIn(0), 'teszt')
    const b = await linkLifeFileAsAnnex(items[1]!, CERT, {}, resolveIn(1), 'teszt')
    if (!a.ok || !b.ok) throw new Error('link')
    expect([a.annex.label, a.annex.linked, a.annex.exists, a.annex.name]).toEqual(['K1', true, true, 'nyugdijigazolas.pdf'])
    expect([b.annex.label, b.annex.title]).toEqual(['K2', 'nyugdijigazolas'])
    expect(a.annex.path).toBe(b.annex.path)
    // No copy anywhere: the certificate is on the disk exactly once.
    expect(allFiles(depot).filter((f) => f.endsWith('nyugdijigazolas.pdf')).length).toBe(1)
    expect(readdirSync(abs('Projektek/Jobcenter ügy'))).toEqual([])
  })

  it('the same document only once in one list; a folder or a path outside the tree is refused', async () => {
    expect((await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')).ok).toBe(true)
    const again = await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    expect(again.ok === false && again.code).toBe('duplicate')
    const dir = await linkLifeFileAsAnnex(items[0]!, 'Család/Anna', {}, resolveIn(0), 't')
    expect(dir.ok === false && dir.code).toBe('bad_input')
    const out = await linkLifeFileAsAnnex(items[0]!, '../../etc/passwd', {}, resolveIn(0), 't')
    expect(out.ok).toBe(false)
    const none = await linkLifeFileAsAnnex(items[0]!, 'Család/Anna/nincs.pdf', {}, resolveIn(0), 't')
    expect(none.ok === false && none.code).toBe('file_missing')
  })

  it('a linked document cannot be named by typing its id as a project path', async () => {
    const a = await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    if (!a.ok) throw new Error('link')
    const typed = addAnnex(items[1]!, { path: a.annex.path }, resolveIn(1), 't')
    expect(typed.ok === false && typed.code).toBe('bad_input')
    writeFileSync(abs('Projektek/Sozialamt ügy/level.pdf'), 'x')
    const plain = addAnnex(items[1]!, { path: 'level.pdf' }, resolveIn(1), 't')
    if (!plain.ok) throw new Error('plain')
    expect(setAnnexPath(items[1]!, plain.annex.id, a.annex.path, resolveIn(1)).ok).toBe(false)
  })

  it('a rename or a move in the Explorer does not lose it (the id follows); both lists find the file at its new place', async () => {
    await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    await linkLifeFileAsAnnex(items[1]!, CERT, {}, resolveIn(1), 't')
    const to = 'Család/Anna/Hatóságok/Archív/Nyugdíj_igazolás_2026.pdf'
    mkdirSync(join(abs(to), '..'), { recursive: true })
    renameSync(abs(CERT), abs(to))
    moveDocumentsPrefix(CERT, to) // what the Explorer's rename / move calls (life-follow.ts)
    for (const i of [0, 1]) {
      const v = listAnnexes(items[i]!, resolveIn(i))[0]!
      expect([v.exists, v.name]).toEqual([true, 'Nyugdíj_igazolás_2026.pdf'])
      expect(tendLinkedAnnexes(items[i]!, resolveIn(i))).toBe(0)
      expect(listAnnexes(items[i]!)[0]!.life_rel).toBe(to)
    }
  })

  it('moved OUTSIDE Marveen: reported missing (never "deleted"), then found again by its content', async () => {
    const a = await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    if (!a.ok) throw new Error('link')
    await hashDocument(documentIdFor(CERT)!)
    const to = 'Család/Anna/Egyéb/atnevezve.pdf'
    mkdirSync(join(abs(to), '..'), { recursive: true })
    renameSync(abs(CERT), abs(to)) // the Windows Explorer did it: nobody told the registry
    const gone = listAnnexes(items[0]!, resolveIn(0))[0]!
    expect([gone.exists, gone.name]).toEqual([false, 'nyugdijigazolas.pdf'])
    expect(annexCheck(items[0]!, resolveIn(0)).missing_files).toEqual(['K1'])
    expect(tendLinkedAnnexes(items[0]!, resolveIn(0))).toBe(1) // being looked for, in the background
    await expect.poll(() => listAnnexes(items[0]!, resolveIn(0))[0]!.exists, { timeout: 5000 }).toBe(true)
    expect(listAnnexes(items[0]!, resolveIn(0))[0]!.name).toBe('atnevezve.pdf')
  })

  it('removing it from one project deletes no file and leaves the other project\'s annex alone', async () => {
    const a = await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    await linkLifeFileAsAnnex(items[1]!, CERT, {}, resolveIn(1), 't')
    if (!a.ok) throw new Error('link')
    expect(removeAnnex(items[0]!, a.annex.id).ok).toBe(true)
    expect(listAnnexes(items[0]!, resolveIn(0))).toEqual([])
    expect(listAnnexes(items[1]!, resolveIn(1))[0]!.exists).toBe(true)
    expect(allFiles(depot).filter((f) => f.endsWith('nyugdijigazolas.pdf')).length).toBe(1)
  })

  it('"where is this file used?" -- by the file, and by a folder above it; an unused file answers nothing', async () => {
    await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    await linkLifeFileAsAnnex(items[1]!, CERT, {}, resolveIn(1), 't')
    const uses = linkedUsesUnder(CERT)
    expect(uses.map((u) => [u.project, u.item, u.label]).sort()).toEqual([
      ['Jobcenter ügy', 'Beadvány (Jobcenter ügy)', 'K1'], ['Sozialamt ügy', 'Beadvány (Sozialamt ügy)', 'K1'],
    ])
    expect(linkedUsesUnder('Család/Anna/Hatóságok').length).toBe(2)
    expect(linkedUsesUnder('Család/Anna/Hatóságok/Nyugd').length).toBe(0) // a name prefix is not a folder
    expect(linkedUsesUnder('Projektek')).toEqual([])
    expect(linkedUsesUnder('')).toEqual([])
  })

  it('the check before finalising counts a linked annex like any other (by its real file name)', async () => {
    const a = await linkLifeFileAsAnnex(items[0]!, CERT, {}, resolveIn(0), 't')
    if (!a.ok) throw new Error('link')
    const s = addSection(items[0]!, '1. Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('section')
    addBlock(items[0]!, s.section.id, { text: 'A nyugdíjigazolást K1 alatt csatolom.', author: 'owner' })
    const c = annexCheck(items[0]!, resolveIn(0))
    expect([c.total, c.ok, c.unsupported, c.missing_files, c.unreferenced]).toEqual([1, 1, [], [], []])
  })
})
