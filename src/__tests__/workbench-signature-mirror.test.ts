// Boss TG 3975: a signature put on the original appears on the language version too, and the other way round;
// moving or deleting it follows; it never turns the translation "stale"; plain text edits leave the other side alone.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, updateBlock, removeBlock, listBlocks, listSections } from '../workbench-docmodel.js'
import { createVariant, translateSection, variantInfo } from '../workbench-doclang.js'
import { mirrorSignaturesFrom } from '../workbench-sigmirror.js'

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

describe('signature mirror', () => {
  it('a signature added to the original appears in the language version, and the version stays current', () => {
    addBlock(src.id, srcSec, { kind: 'image', text: SIG, author: 'owner' })
    mirrorSignaturesFrom(src.id)
    expect(sigs(ver.id, verSec)).toEqual([SIG])
    expect(variantInfo(ver.id)!.sections[0]!.state).toBe('current')
  })

  it('a signature added to the language version appears in the original', () => {
    addBlock(ver.id, verSec, { kind: 'image', text: SIG, author: 'owner' })
    mirrorSignaturesFrom(ver.id)
    expect(sigs(src.id, srcSec)).toEqual([SIG])
    expect(variantInfo(ver.id)!.sections[0]!.state).toBe('current')
  })

  it('moving / resizing and deleting follow, both ways', () => {
    const a = addBlock(src.id, srcSec, { kind: 'image', text: SIG, author: 'owner' })
    if (!a.ok) throw new Error('add')
    mirrorSignaturesFrom(src.id)
    const moved = 'Személyes/Aláírás.png#w=50&a=c&x=10&y=0.5&o=1'
    updateBlock(src.id, a.block.id, { text: moved, author: 'owner' })
    mirrorSignaturesFrom(src.id)
    expect(sigs(ver.id, verSec)).toEqual([moved])
    const vb = listBlocks(ver.id).find((b) => b.kind === 'image')!
    removeBlock(ver.id, vb.id)
    mirrorSignaturesFrom(ver.id)
    expect(sigs(src.id, srcSec)).toEqual([])
  })

  it('editing plain text does not touch the other side\'s signature', () => {
    addBlock(ver.id, verSec, { kind: 'image', text: SIG, author: 'owner' }) // exists on the version only, never mirrored
    const para = listBlocks(src.id).find((b) => b.kind === 'paragraph')!
    updateBlock(src.id, para.id, { text: 'Sehr geehrt!', author: 'owner' })
    mirrorSignaturesFrom(src.id)
    expect(sigs(ver.id, verSec)).toEqual([SIG])
  })

  it('a picture that is not a signature is not mirrored', () => {
    addBlock(src.id, srcSec, { kind: 'image', text: 'Fotok/kert.png#w=40&a=l', author: 'owner' })
    mirrorSignaturesFrom(src.id)
    expect(sigs(ver.id, verSec)).toEqual([])
  })
})

describe('the column does not call a mirrored signature a change of the original', () => {
  it('twSig leaves signature pictures out, like the server hash', () => {
    const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')
    const body = js.slice(js.indexOf('function twSig(sec)'), js.indexOf('function twKey('))
    expect(body).toContain('isSignatureImg')
  })
})
