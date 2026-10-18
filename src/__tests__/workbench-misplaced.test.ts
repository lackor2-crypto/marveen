// #698: the tree MARKS a file that is probably in the wrong place (by the role of its folder and what its name looks
// like) and never moves or deletes it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, listWorkFolders } from '../workbench-assets.js'
import { misplacedFor, fileKindGuess, roleOfFolderName } from '../workbench-misplaced.js'

describe('the verdict by folder role and file name', () => {
  it('knows the standard folders by either language and by the old names', () => {
    expect(roleOfFolderName('Elkészített anyagok')).toBe('finished')
    expect(roleOfFolderName('Elkészített iratok')).toBe('finished')
    expect(roleOfFolderName('Attachments')).toBe('attachments')
    expect(roleOfFolderName('Agentnek')).toBe('agent')
    expect(roleOfFolderName('Vitáztatás jelentés')).toBe('debate')
    expect(roleOfFolderName('Valami más')).toBeNull()
  })
  it('an attachment in the Finished materials is flagged, a normal finished file is not', () => {
    expect(misplacedFor('finished', 'K7_Mietvertrag.pdf')).toEqual({ code: 'attachment_in_finished' })
    expect(misplacedFor('finished', 'Melléklet 3.pdf')).toEqual({ code: 'attachment_in_finished' })
    expect(misplacedFor('finished', 'Wohngeld kérelem.pdf')).toBeNull()
    // the annex PDFs that finalising writes there on purpose are not attachments in the wrong place
    expect(misplacedFor('finished', 'K1 \u2013 Mietvertrag.pdf')).toBeNull()
    expect(misplacedFor('finished', 'K13 \u2013 Bescheid (2).pdf')).toBeNull()
  })
  it('a final material among the Attachments is flagged, a normal attachment is not', () => {
    expect(misplacedFor('attachments', 'Wohngeld_végleges.pdf')).toEqual({ code: 'finished_in_attachments' })
    expect(misplacedFor('attachments', 'final_export.docx')).toEqual({ code: 'finished_in_attachments' })
    expect(misplacedFor('attachments', 'K1_Bescheid.pdf')).toBeNull()
  })
  it('a file beside the work items is flagged; a file in the Agent folder only gets a soft note', () => {
    expect(misplacedFor('box', 'x.pdf')).toEqual({ code: 'loose_beside_item' })
    expect(misplacedFor('agent', 'minta.png')).toEqual({ code: 'in_agent_folder', soft: true })
  })
  it('debate: a report belongs there, anything else is flagged, an outside opinion only softly; a report elsewhere is flagged', () => {
    expect(misplacedFor('debate', 'Vitáztatás jelentés: X.pdf')).toBeNull()
    expect(misplacedFor('debate', 'K3.pdf')).toEqual({ code: 'not_report_in_debate' })
    expect(misplacedFor('debate', 'GPT_wohngeld_valasz_attekintes.md')).toEqual({ code: 'not_report_in_debate', soft: true })
    expect(misplacedFor('attachments', 'Vitáztatás jelentés Wohngeld.pdf')).toEqual({ code: 'report_elsewhere' })
    expect(misplacedFor('uploads', 'Debate report X.docx')).toEqual({ code: 'report_elsewhere' })
  })
  it('the name guess puts the report before the opinion and the attachment', () => {
    expect(fileKindGuess('Vitáztatás jelentés GPT.pdf')).toBe('debate_report')
    expect(fileKindGuess('GPT áttekintés K3.md')).toBe('external_opinion')
    expect(fileKindGuess('jegyzet.txt')).toBeNull()
  })
  it('judges nothing without a known role', () => {
    expect(misplacedFor(null, 'K1.pdf')).toBeNull()
  })
})

describe('the Workbench tree listing carries the mark and moves nothing', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-misplaced-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('folder')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('flags the cases and leaves every file where it is', () => {
    const w = createWorkItem({ project_id: pid, title: 'Wohngeld 2026', type: 'document' })
    if (!w.ok) throw new Error('item')
    const f = ensureWorkItemFolder(w.item)
    if (!f.ok) throw new Error('folder')
    const item = join(projDir(), f.folder)
    const put = (rel: string, name: string): string => { const p = join(item, rel, name); mkdirSync(join(item, rel), { recursive: true }); writeFileSync(p, 'x'); return p }
    const files = [
      put('Elkészített anyagok', 'K1_Bescheid.pdf'),
      put('Elkészített anyagok', 'Kérelem.pdf'),
      put('Mellékletek', 'Kérelem_végleges.pdf'),
      put('Agent', 'minta.png'),
      put('Vitáztatás', 'GPT_wohngeld_valasz_attekintes.md'),
      put('Vitáztatás', 'Vitáztatás jelentés Wohngeld.pdf'),
    ]
    const loose = join(projDir(), f.folder.split('/').slice(0, -1).join('/'), 'elarvult.pdf')
    writeFileSync(loose, 'x')
    const p = getProject(pid)!
    const wf = listWorkFolders(p, { outside: false })
    const mark = (folder: string, name: string) => wf.files[folder]?.find((x) => x.name === name)?.misplaced
    expect(mark(`${f.folder}/Elkészített anyagok`, 'K1_Bescheid.pdf')).toEqual({ code: 'attachment_in_finished' })
    expect(mark(`${f.folder}/Elkészített anyagok`, 'Kérelem.pdf')).toBeUndefined()
    expect(mark(`${f.folder}/Mellékletek`, 'Kérelem_végleges.pdf')).toEqual({ code: 'finished_in_attachments' })
    expect(mark(`${f.folder}/Agent`, 'minta.png')).toEqual({ code: 'in_agent_folder', soft: true })
    expect(mark(`${f.folder}/Vitáztatás`, 'GPT_wohngeld_valasz_attekintes.md')).toEqual({ code: 'not_report_in_debate', soft: true })
    expect(mark(`${f.folder}/Vitáztatás`, 'Vitáztatás jelentés Wohngeld.pdf')).toBeUndefined()
    const boxFolder = f.folder.split('/').slice(0, -1).join('/')
    expect(mark(boxFolder, 'elarvult.pdf')).toEqual({ code: 'loose_beside_item' })
    for (const x of [...files, loose]) expect(existsSync(x), x).toBe(true)
  })
})
