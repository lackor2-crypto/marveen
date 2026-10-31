// #794 (Boss TG 4067): a chapter the owner translated by hand counts as translated -- the Translate button is one way
// to get there, not the definition. An empty placeholder is still "untranslated", and a later change of the original
// still makes a hand-translated chapter outdated.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, updateBlock } from '../workbench-docmodel.js'
import { createVariant, variantInfo, variantCheckItems } from '../workbench-doclang.js'

describe('a hand-translated chapter', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-doclang-hand-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  function setup() {
    const p = createProject({ name: 'Iroda' }); if (!p.ok) throw new Error('p')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Level', type: 'document' }); if (!w.ok) throw new Error('w')
    const s = addSection(w.item.id, 'Tenyallas', { status: 'done' }); if (!s.ok) throw new Error('s')
    const b = addBlock(w.item.id, s.section.id, { text: 'Magyar szoveg.', kind: 'paragraph', author: 'agent' }); if (!b.ok) throw new Error('b')
    const v = createVariant(w.item, 'de', 'test'); if (!v.ok) throw new Error('v')
    return { src: w.item, s: s.section, b: b.block, variant: v.item }
  }

  it('an empty placeholder is untranslated and blocks the variant', () => {
    const { variant } = setup()
    const info = variantInfo(variant.id)!
    expect(info.sections.map((x) => x.state)).toEqual(['untranslated'])
    expect(variantCheckItems(variant.id)[0].ok).toBe(false)
  })

  it('text written by hand makes it current, without the Translate button', () => {
    const { variant } = setup()
    const info0 = variantInfo(variant.id)!
    const sec = info0.sections[0].section_id
    const a = addBlock(variant.id, sec, { text: 'Deutscher Text.', kind: 'paragraph', author: 'owner' }); if (!a.ok) throw new Error('a')
    expect(variantInfo(variant.id)!.sections.map((x) => x.state)).toEqual(['current'])
    expect(variantCheckItems(variant.id)[0].ok).toBe(true)
  })

  it('a later change of the original still makes the hand translation outdated', () => {
    const { src, b, variant } = setup()
    const sec = variantInfo(variant.id)!.sections[0].section_id
    addBlock(variant.id, sec, { text: 'Deutscher Text.', kind: 'paragraph', author: 'owner' })
    expect(variantInfo(variant.id)!.sections[0].state).toBe('current')
    updateBlock(src.id, b.id, { text: 'Megvaltozott magyar szoveg.' })
    expect(variantInfo(variant.id)!.sections[0].state).toBe('stale')
  })
})
