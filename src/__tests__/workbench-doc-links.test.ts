// #530, phase 1: a document of the Life tree is an annex WITHOUT a copy. The owner's
// condition (TG 8500): the same pension certificate must be attachable to several
// submissions, for several authorities, from its one place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { executeTool } from '../workbench-agent/execute.js'
import { buildContext } from '../workbench-agent/context.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { addAnnex, annexCheck, listAnnexes, removeAnnex, setAnnexPath } from '../workbench-docannex.js'
import { resolveProjectFile } from '../workbench-docmodel-world.js'
import { documentIdFor, hashDocument, moveDocumentsPrefix } from '../life-doc-ids.js'
import { aiDocsForProject, aiMayReadLinked, addProjectDoc, getProjectAiAccess, linkLifeFileAsAnnex, linkedUsesUnder, listProjectDocs, removeProjectDoc, setProjectAiAccess, tendLinkedAnnexes, updateProjectDoc } from '../workbench-doc-links.js'

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
  // PHASE 2: the document's role in a project.
  it('a project holds a document in a role without a copy; the same document can be in two projects in different roles', async () => {
    const a = await addProjectDoc(projects[0]!.id, CERT, { role: 'source', note: 'ebből dolgozunk' }, 't')
    const b = await addProjectDoc(projects[1]!.id, CERT, { role: 'reference' }, 't')
    expect(a.ok && b.ok).toBe(true)
    const one = listProjectDocs(projects[0]!.id)
    expect(one.docs.map((d) => [d.role, d.name, d.exists, d.note])).toEqual([['source', 'nyugdijigazolas.pdf', true, 'ebből dolgozunk']])
    expect(listProjectDocs(projects[1]!.id).docs[0]!.role).toBe('reference')
    expect(allFiles(depot).filter((f) => f.endsWith('nyugdijigazolas.pdf')).length).toBe(1)
    expect(readdirSync(abs('Projektek/Jobcenter ügy'))).toEqual([])
  })

  it('once per project; a wrong role, a folder, a missing file and a path outside the tree are refused', async () => {
    expect((await addProjectDoc(projects[0]!.id, CERT, {}, 't')).ok).toBe(true) // no role given = source
    expect(listProjectDocs(projects[0]!.id).docs[0]!.role).toBe('source')
    const again = await addProjectDoc(projects[0]!.id, CERT, { role: 'related' }, 't')
    expect(again.ok === false && again.code).toBe('duplicate')
    const role = await addProjectDoc(projects[1]!.id, CERT, { role: 'attachment' }, 't')
    expect(role.ok === false && role.code).toBe('bad_role')
    const dir = await addProjectDoc(projects[1]!.id, 'Család/Anna', {}, 't')
    expect(dir.ok === false && dir.code).toBe('bad_input')
    const none = await addProjectDoc(projects[1]!.id, 'Család/nincs.pdf', {}, 't')
    expect(none.ok === false && none.code).toBe('file_missing')
    expect((await addProjectDoc(projects[1]!.id, '../../etc/passwd', {}, 't')).ok).toBe(false)
  })

  it('the role can be changed; removing it from the project deletes no file and leaves the other project alone', async () => {
    const a = await addProjectDoc(projects[0]!.id, CERT, { role: 'source' }, 't')
    await addProjectDoc(projects[1]!.id, CERT, { role: 'source' }, 't')
    if (!a.ok) throw new Error('add')
    expect(updateProjectDoc(projects[0]!.id, a.id, { role: 'related' }).ok).toBe(true)
    expect(listProjectDocs(projects[0]!.id).docs[0]!.role).toBe('related')
    const bad = updateProjectDoc(projects[0]!.id, a.id, { role: 'x' })
    expect(bad.ok === false && bad.code).toBe('bad_role')
    // Another project cannot touch it by knowing its id.
    expect(updateProjectDoc(projects[1]!.id, a.id, { role: 'source' }).ok).toBe(false)
    expect(removeProjectDoc(projects[1]!.id, a.id).ok).toBe(false)
    expect(removeProjectDoc(projects[0]!.id, a.id).ok).toBe(true)
    expect(listProjectDocs(projects[0]!.id).docs).toEqual([])
    expect(listProjectDocs(projects[1]!.id).docs.length).toBe(1)
    expect(allFiles(depot).filter((f) => f.endsWith('nyugdijigazolas.pdf')).length).toBe(1)
  })

  it('follows a rename in the Explorer; moved outside it is "not at its place" and then found by content', async () => {
    await addProjectDoc(projects[0]!.id, CERT, {}, 't')
    const to = 'Család/Anna/Hatóságok/Nyugdíj/uj-nev.pdf'
    renameSync(abs(CERT), abs(to))
    moveDocumentsPrefix(CERT, to)
    expect(listProjectDocs(projects[0]!.id).docs.map((d) => [d.name, d.exists, d.life_rel])).toEqual([['uj-nev.pdf', true, to]])
    await hashDocument(documentIdFor(to)!)
    const out = 'Család/Anna/Egyéb/kint.pdf'
    mkdirSync(join(abs(out), '..'), { recursive: true })
    renameSync(abs(to), abs(out))
    const gone = listProjectDocs(projects[0]!.id)
    expect([gone.docs[0]!.exists, gone.docs[0]!.name, gone.searching]).toEqual([false, 'uj-nev.pdf', 1])
    await expect.poll(() => listProjectDocs(projects[0]!.id).docs[0]!.exists, { timeout: 5000 }).toBe(true)
    expect(listProjectDocs(projects[0]!.id).docs[0]!.name).toBe('kint.pdf')
  })

  it('the project view also shows what its submissions attach, and "where is it used" names the role', async () => {
    await linkLifeFileAsAnnex(items[0]!, CERT, { title: 'Nyugdíjigazolás' }, resolveIn(0), 't')
    await addProjectDoc(projects[1]!.id, CERT, { role: 'reference' }, 't')
    const v = listProjectDocs(projects[0]!.id)
    expect(v.docs).toEqual([])
    expect(v.attachments.map((a) => [a.item, a.label, a.title, a.name, a.exists])).toEqual([['Beadvány (Jobcenter ügy)', 'K1', 'Nyugdíjigazolás', 'nyugdijigazolas.pdf', true]])
    const uses = linkedUsesUnder(CERT).map((u) => [u.project, u.item, u.label]).sort()
    expect(uses).toEqual([['Jobcenter ügy', 'Beadvány (Jobcenter ügy)', 'K1'], ['Sozialamt ügy', '', 'reference']])
  })
  // PHASE 4: which documents the AI works from.
  it('the AI gets the project documents the owner left on and the attached annexes; what is switched off is counted, not hidden', async () => {
    const other = 'Család/Anna/Hatóságok/Nyugdíj/hatarozat.pdf'
    writeFileSync(abs(other), 'DECISION')
    const a = await addProjectDoc(projects[0]!.id, CERT, { role: 'source', note: 'igazolás' }, 't')
    const b = await addProjectDoc(projects[0]!.id, other, { role: 'reference' }, 't')
    if (!a.ok || !b.ok) throw new Error('add')
    let ai = aiDocsForProject(projects[0]!.id)
    expect(ai.docs.map((d) => [d.role, d.name, d.note])).toEqual([['reference', 'hatarozat.pdf', ''], ['source', 'nyugdijigazolas.pdf', 'igazolás']])
    expect([ai.withheld, ai.missing]).toEqual([0, 0])
    expect(listProjectDocs(projects[0]!.id).docs.every((d) => d.ai)).toBe(true)

    expect(updateProjectDoc(projects[0]!.id, b.id, { ai: false }).ok).toBe(true)
    const bad = updateProjectDoc(projects[0]!.id, b.id, { ai: 'no' })
    expect(bad.ok === false && bad.code).toBe('bad_input')
    ai = aiDocsForProject(projects[0]!.id)
    expect(ai.docs.map((d) => d.name)).toEqual(['nyugdijigazolas.pdf'])
    expect(ai.withheld).toBe(1)
    const off = listProjectDocs(projects[0]!.id).docs.find((d) => d.id === b.id)!
    expect(off.ai).toBe(false)
    // Changing the role does not switch it back on behind the owner's back.
    updateProjectDoc(projects[0]!.id, b.id, { role: 'related' })
    expect(aiDocsForProject(projects[0]!.id).withheld).toBe(1)

    expect(aiMayReadLinked(projects[0]!.id, ai.docs[0]!.path)).toBe(true)
    // Another project's agent may not read it by knowing its path.
    expect(aiMayReadLinked(projects[1]!.id, ai.docs[0]!.path)).toBe(false)
    expect(aiMayReadLinked(projects[0]!.id, 'doc:DOC-NINCSILY')).toBe(false)
  })

  it('an annex linked to a submission is readable by that project\'s AI; switched off as a project document it stays off', async () => {
    const l = await linkLifeFileAsAnnex(items[0]!, CERT, { title: 'Nyugdíjigazolás' }, resolveIn(0), 't')
    if (!l.ok) throw new Error('link')
    let ai = aiDocsForProject(projects[0]!.id)
    expect(ai.docs.map((d) => [d.role, d.note])).toEqual([['attachment', 'K1 – Nyugdíjigazolás']])
    expect(aiMayReadLinked(projects[0]!.id, l.annex.path)).toBe(true)
    const p = await addProjectDoc(projects[0]!.id, CERT, { role: 'source' }, 't')
    if (!p.ok) throw new Error('add')
    expect(aiDocsForProject(projects[0]!.id).docs.length).toBe(1) // listed once
    updateProjectDoc(projects[0]!.id, p.id, { ai: false })
    ai = aiDocsForProject(projects[0]!.id)
    expect([ai.docs.length, ai.withheld]).toEqual([0, 1])
    expect(aiMayReadLinked(projects[0]!.id, l.annex.path)).toBe(false)
  })

  it('a document that is not at its place is counted as missing, not offered and not called deleted', async () => {
    await addProjectDoc(projects[0]!.id, CERT, {}, 't')
    rmSync(abs(CERT))
    const ai = aiDocsForProject(projects[0]!.id)
    expect([ai.docs.length, ai.withheld, ai.missing]).toEqual([0, 0, 1])
  })
  it('the agent\'s read tool gives out a linked document only when the owner selected it for this project', async () => {
    writeFileSync(abs('Család/Anna/Hatóságok/Nyugdíj/jegyzet.txt'), 'A nyugdíj összege 1234 euró.')
    const a = await addProjectDoc(projects[0]!.id, 'Család/Anna/Hatóságok/Nyugdíj/jegyzet.txt', {}, 't')
    if (!a.ok) throw new Error('add')
    const path = aiDocsForProject(projects[0]!.id).docs[0]!.path
    const ctx0 = { projectId: projects[0]!.id, workItemId: items[0]!, actor: 'workbench-agent' } as never
    const ctx1 = { projectId: projects[1]!.id, workItemId: items[1]!, actor: 'workbench-agent' } as never
    const read = executeTool('file.read', { path }, ctx0)
    expect(read.ok && JSON.stringify(read.data)).toContain('1234 euró')
    // Another project's agent: refused, with a reason it can pass on.
    const other = executeTool('file.read', { path }, ctx1)
    expect(other.ok === false && other.code).toBe('not_selected')
    // Switched off: the same agent no longer gets it.
    updateProjectDoc(projects[0]!.id, a.id, { ai: false })
    const off = executeTool('file.read', { path }, ctx0)
    expect(off.ok === false && off.code).toBe('not_selected')
    // A linked path is for reading only: it cannot be written or deleted through.
    updateProjectDoc(projects[0]!.id, a.id, { ai: true })
    for (const tool of ['file.write', 'file.delete', 'file.move', 'file.rename']) {
      const w = executeTool(tool, { path, content: 'x', to: 'y.txt', name: 'y.txt' }, ctx0)
      expect([tool, w.ok, w.ok ? JSON.stringify(w.data).slice(0, 200) : w.code]).toEqual([tool, false, 'linked_read_only'])
    }
    expect(readFileSync(abs('Család/Anna/Hatóságok/Nyugdíj/jegyzet.txt'), 'utf8')).toBe('A nyugdíj összege 1234 euró.')
  })

  it('the agent\'s context lists the selected documents with the path to read them, and says how many it was not given', async () => {
    const a = await addProjectDoc(projects[0]!.id, CERT, { role: 'source', note: 'ebből dolgozz' }, 't')
    writeFileSync(abs('Család/Anna/Hatóságok/Nyugdíj/titok.pdf'), 'x')
    const b = await addProjectDoc(projects[0]!.id, 'Család/Anna/Hatóságok/Nyugdíj/titok.pdf', {}, 't')
    if (!a.ok || !b.ok) throw new Error('add')
    updateProjectDoc(projects[0]!.id, b.id, { ai: false })
    const c = await buildContext(projects[0]!, null, 'hu')
    expect(c.contextText).toMatch(/Linked documents the owner selected for you \(1\)/)
    expect(c.contextText).toMatch(/- doc:DOC-[A-Z0-9]{8}  \(source\) nyugdijigazolas\.pdf -- ebből dolgozz/)
    expect(c.contextText).toMatch(/1 more document\(s\) are linked to this project but the owner did NOT select them for you/)
    expect(c.contextText).not.toContain('titok.pdf')
    // A project with no linked document spends no context on it.
    const none = await buildContext(projects[1]!, null, 'hu')
    expect(none.contextText).not.toContain('Linked documents')
  })

  // #530 (Boss TG 8535): "korlatok nelkul" -- one switch per project, reading limits only, off by default.
  describe('the project\'s "no limits" (reading) switch', () => {
    const NOTE = 'Család/Anna/Hatóságok/Nyugdíj/jegyzet.txt'
    const MINE_OFF = 'Család/Anna/Hatóságok/Nyugdíj/kikapcsolt.txt'
    async function setup() {
      writeFileSync(abs(NOTE), 'A másik projekt irata: 1234 euró.')
      writeFileSync(abs(MINE_OFF), 'Kikapcsolt irat: 99 euró.')
      const theirs = await addProjectDoc(projects[1]!.id, NOTE, { role: 'source' }, 't')
      const mine = await addProjectDoc(projects[0]!.id, MINE_OFF, { role: 'source' }, 't')
      if (!theirs.ok || !mine.ok) throw new Error('add')
      updateProjectDoc(projects[0]!.id, mine.id, { ai: false })
      const otherPath = aiDocsForProject(projects[1]!.id).docs[0]!.path
      const minePath = 'doc:' + documentIdFor(MINE_OFF)
      return { otherPath, minePath, mine }
    }
    const ctx0 = () => ({ projectId: projects[0]!.id, workItemId: items[0]!, actor: 'workbench-agent' } as never)

    it('is off by default -- also on a fresh database -- and the current behaviour is unchanged', async () => {
      const { otherPath, minePath } = await setup()
      expect(getProjectAiAccess(projects[0]!.id)).toBe('normal')
      const ai = aiDocsForProject(projects[0]!.id)
      expect([ai.access, ai.docs.length, ai.withheld, ai.others.length]).toEqual(['normal', 0, 1, 0])
      expect(aiMayReadLinked(projects[0]!.id, otherPath)).toBe(false)
      expect(aiMayReadLinked(projects[0]!.id, minePath)).toBe(false)
      const r = executeTool('file.read', { path: otherPath }, ctx0())
      expect(r.ok === false && r.code).toBe('not_selected')
      const c = await buildContext(projects[0]!, null, 'hu')
      expect(c.contextText).toMatch(/1 more document\(s\) are linked to this project but the owner did NOT select them/)
      expect(c.contextText).not.toContain('no limits')
    })

    it('a gone document of ANOTHER project does not make THIS project look as if it lacked a document', async () => {
      const { minePath } = await setup()
      void minePath
      setProjectAiAccess(projects[0]!.id, 'read_all')
      rmSync(abs(NOTE))
      const ai = aiDocsForProject(projects[0]!.id)
      expect([ai.missing, ai.othersMissing]).toEqual([0, 1])
    })

    it('on: a document with its tick off and another project\'s document are readable; the ticks keep their value', async () => {
      const { otherPath, minePath, mine } = await setup()
      const set = setProjectAiAccess(projects[0]!.id, 'read_all', 't')
      expect(set.ok).toBe(true)
      expect(getProjectAiAccess(projects[0]!.id)).toBe('read_all')
      // Only THIS project is lifted: the other one stays as it was.
      expect(getProjectAiAccess(projects[1]!.id)).toBe('normal')
      const ai = aiDocsForProject(projects[0]!.id)
      expect([ai.access, ai.withheld]).toEqual(['read_all', 0])
      expect(ai.docs.map((d) => d.name)).toEqual(['kikapcsolt.txt'])
      expect(ai.others.map((d) => [d.name, d.project])).toEqual([['jegyzet.txt', projects[1]!.name]])
      expect(aiMayReadLinked(projects[0]!.id, otherPath)).toBe(true)
      expect(aiMayReadLinked(projects[0]!.id, minePath)).toBe(true)
      // A path that nobody links is still not readable.
      expect(aiMayReadLinked(projects[0]!.id, 'doc:DOC-NINCSILY')).toBe(false)
      const other = executeTool('file.read', { path: otherPath }, ctx0())
      expect(other.ok && JSON.stringify(other.data)).toContain('1234 euró')
      const own = executeTool('file.read', { path: minePath }, ctx0())
      expect(own.ok && JSON.stringify(own.data)).toContain('99 euró')
      // The per-document tick still holds its value, and counts again when the switch goes off.
      expect(listProjectDocs(projects[0]!.id).docs.find((d) => d.id === mine.id)!.ai).toBe(false)
      // The context says so, and the "there is a document you were not given" line does not go out.
      const c = await buildContext(projects[0]!, null, 'hu')
      expect(c.contextText).toMatch(/switched this project to "no limits" \(reading\)/)
      expect(c.contextText).toContain(`- ${otherPath}  (${projects[1]!.name}) jegyzet.txt`)
      expect(c.contextText).not.toMatch(/did NOT select them/)
      // Back off: the earlier behaviour returns exactly.
      setProjectAiAccess(projects[0]!.id, 'normal', 't')
      expect(aiMayReadLinked(projects[0]!.id, otherPath)).toBe(false)
      expect(aiMayReadLinked(projects[0]!.id, minePath)).toBe(false)
      expect(aiDocsForProject(projects[0]!.id).withheld).toBe(1)
    })

    it('lifts READING only: a linked path still cannot be written, moved, renamed or deleted', async () => {
      const { otherPath } = await setup()
      setProjectAiAccess(projects[0]!.id, 'read_all', 't')
      for (const tool of ['file.write', 'file.delete', 'file.move', 'file.rename']) {
        const w = executeTool(tool, { path: otherPath, content: 'x', to: 'y.txt', name: 'y.txt' }, ctx0())
        expect([tool, w.ok, w.ok ? '' : w.code]).toEqual([tool, false, 'linked_read_only'])
      }
      expect(readFileSync(abs(NOTE), 'utf8')).toBe('A másik projekt irata: 1234 euró.')
    })

    it('the mode is a value, not a boolean: only the known ones are accepted', () => {
      const bad = setProjectAiAccess(projects[0]!.id, 'write_all', 't')
      expect(bad.ok === false && bad.code).toBe('bad_input')
      expect(getProjectAiAccess(projects[0]!.id)).toBe('normal')
      expect(setProjectAiAccess(projects[0]!.id, true as never, 't').ok).toBe(false)
    })
  })
})
