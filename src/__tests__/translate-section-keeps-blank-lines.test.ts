// Boss, 2026-11-06 (the fourth time it happened): the agent saves a language version with doc.translateSection. Plain newlines of its
// text are trimmed away, so the recipient window and the gaps around the subject / salutation disappeared and the recipient
// sat next to the sender. Now every translated paragraph gets the blank lines of its original back, and the sender label is
// the language's own word.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, listBlocks } from '../workbench-docmodel.js'
import { createVariant, translateSection } from '../workbench-doclang.js'

const Z = '​'

describe('translateSection keeps the blank lines of the original', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-doclang-blank-'))
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
  })
  afterEach(() => { rmSync(depot, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

  it('the recipient window, the gaps and the sender label survive a translation written with plain newlines', () => {
    const p = createProject({ name: 'Iroda' }); if (!p.ok) throw new Error('p')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Level', type: 'document' }); if (!w.ok) throw new Error('w')
    const s = addSection(w.item.id, 'Meghatalmazás', { status: 'done' }); if (!s.ok) throw new Error('s')
    const mk = (text: string, kind: 'table' | 'paragraph') => { const r = addBlock(w.item.id, s.section.id, { text, kind, author: 'agent' }); if (!r.ok) throw new Error('b') }
    mk('Feladó:\nBakos Éva\n#w=45&a=l&x=55&y=0&o=1', 'table')
    mk(`${Z}\n${Z}\n${Z}\n${Z}\nCímzett:\nStadt Chemnitz\n${Z}\n${Z}`, 'paragraph')
    mk(`Tárgy: Meghatalmazás\n${Z}`, 'paragraph')
    mk(`Tisztelt Hölgyem/Uram!\n${Z}`, 'paragraph')
    const v = createVariant(w.item, 'de', 'test'); if (!v.ok) throw new Error('v')
    const r = translateSection(v.item.id, {
      source_section: s.section.id, title: 'Vollmacht',
      blocks: [
        { kind: 'table', text: 'Absenderin:\nBakos Éva\n#w=45&a=l&x=55&y=0&o=1' },
        { kind: 'paragraph', text: 'Empfänger:\nStadt Chemnitz' },
        { kind: 'paragraph', text: 'Betreff: Vollmacht' },
        { kind: 'paragraph', text: 'Sehr geehrte Damen und Herren,' },
      ],
    }, 'test')
    expect(r.ok).toBe(true)
    const out = listBlocks(v.item.id).map((b) => b.text)
    expect(out[0]!.split('\n')[0]).toBe('Absender:')
    expect(out[1]).toBe(`${Z}\n${Z}\n${Z}\n${Z}\nEmpfänger:\nStadt Chemnitz\n${Z}\n${Z}`)
    expect(out[2]).toBe(`Betreff: Vollmacht\n${Z}`)
    expect(out[3]).toBe(`Sehr geehrte Damen und Herren,\n${Z}`)
  })
})
