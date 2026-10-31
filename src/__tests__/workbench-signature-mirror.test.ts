// #794 (Boss TG 4119, reverses TG 3975): the signature picture of a language version is placed on its own. Moving, adding or
// deleting it on the original must NOT touch the version and the other way round (the German page breaks lines elsewhere,
// so one place cannot fit both). It still never turns the translation "stale".
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, updateBlock, listBlocks, listSections } from '../workbench-docmodel.js'
import { createVariant, translateSection, variantInfo } from '../workbench-doclang.js'

const SIG = 'Személyes/Aláírás.png#w=30&a=l&x=60&y=0&o=1'
let src: WorkItemRow
let ver: WorkItemRow
let srcSec: string
let verSec: string

function sigs(itemId: string, sec: string) { return listBlocks(itemId).filter((b) => b.section_id === sec && b.kind === 'image').map((b) => b.text) }

beforeEach(() => {
  initDatabase(':memory:')
  const p = createProject({ name: 'Iroda' })
  if (!p.ok) throw new Error('project')
  const w = createWorkItem({ project_id: p.project.id, title: 'Levél', type: 'document' })
  if (!w.ok) throw new Error('item')
  src = w.item
  const s = addSection(src.id, 'Levél', {})
  if (!s.ok) throw new Error('section')
  srcSec = s.section.id
  addBlock(src.id, srcSec, { kind: 'paragraph', text: 'Tisztelt Hivatal!', author: 'owner' })
  const v = createVariant(src, 'de', null)
  if (!v.ok) throw new Error('variant')
  ver = v.item
  expect(translateSection(ver.id, { source_section: srcSec, title: 'Brief', blocks: [{ kind: 'paragraph', text: 'Sehr geehrte Damen und Herren!' }] }, null).ok).toBe(true)
  verSec = listSections(ver.id)[0]!.id
})

describe('signature pictures are independent per language version', () => {
  it('a signature added to the original does not appear in the version, and the version stays current', () => {
    addBlock(src.id, srcSec, { kind: 'image', text: SIG, author: 'owner' })
    expect(sigs(ver.id, verSec)).toEqual([])
    expect(variantInfo(ver.id)!.sections.map((x) => x.state)).toEqual(['current'])
  })
  it('moving the picture on one side leaves the other side exactly where it was', () => {
    const a = addBlock(src.id, srcSec, { kind: 'image', text: SIG, author: 'owner' })
    const b = addBlock(ver.id, verSec, { kind: 'image', text: SIG, author: 'owner' })
    if (!a.ok || !b.ok) throw new Error('add')
    updateBlock(src.id, a.block.id, { text: 'Személyes/Aláírás.png#w=30&a=l&x=60&y=9&o=1' })
    expect(sigs(ver.id, verSec)).toEqual([SIG])
    updateBlock(ver.id, b.block.id, { text: 'Személyes/Aláírás.png#w=30&a=l&x=10&y=3&o=1' })
    expect(sigs(src.id, srcSec)).toEqual(['Személyes/Aláírás.png#w=30&a=l&x=60&y=9&o=1'])
  })
  it('no code path mirrors a signature any more (source contract)', () => {
    const route = readFileSync(new URL('../web/routes/workbench.ts', import.meta.url), 'utf8')
    expect(route).not.toMatch(/mirrorSignaturesFrom|workbench-sigmirror/)
  })
})
