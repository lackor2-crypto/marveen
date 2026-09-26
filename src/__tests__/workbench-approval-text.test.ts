// #404 H3: the workbench approval description says, in human words, WHAT the
// owner approves -- project name, tool, target, content start, card #N, actor.
import { describe, it, expect } from 'vitest'
import { describeToolApproval, toolLabel, PREVIEW_CHARS } from '../workbench-agent/approval-text.js'

const base = { projectName: 'Kovács-ház felújítás', projectId: 'p1', workItemTitle: null, actor: 'boss' }

describe('describeToolApproval', () => {
  it('HU: projekt neve, eszkoz emberi nyelven, fajlnev, tartalom eleje, kero', () => {
    const d = describeToolApproval({ ...base, tool: 'file.write', lang: 'hu', input: { path: 'ajanlat/level.md', text: 'Tisztelt\n\nÜgyfél!  Mellékelten' } })
    expect(d).toContain('„Kovács-ház felújítás”')
    expect(d).toContain('fájl írása a projekt mappájába')
    expect(d).toContain('cél: ajanlat/level.md')
    expect(d).toContain('tartalom eleje: „Tisztelt Ügyfél! Mellékelten”')
    expect(d).toContain('kérte: boss')
    expect(d).not.toContain('file.write')
  })

  it('EN ugyanez angolul', () => {
    const d = describeToolApproval({ ...base, tool: 'file.move', lang: 'en', input: { path: 'a.txt', to: 'b/a.txt' } })
    expect(d).toContain('Workbench: move a file')
    expect(d).toContain('target: a.txt')
    expect(d).toContain('to: b/a.txt')
    expect(d).toContain('requested by: boss')
  })

  it('a tartalmat ~200 karakternel levagja', () => {
    const d = describeToolApproval({ ...base, tool: 'file.write', lang: 'hu', input: { path: 'x', text: 'a'.repeat(1000) } })
    expect(d).toContain('a'.repeat(PREVIEW_CHARS) + '…')
    expect(d).not.toContain('a'.repeat(PREVIEW_CHARS + 1))
  })

  it('kartya-hivatkozas #N sorszammal, belso azonosito csak zarojelben', () => {
    const d = describeToolApproval({ ...base, tool: 'kanban.create', lang: 'hu', input: { title: 'Új kártya', related: ['cd19e75c', '#12', 'ismeretlen'] }, seqOf: (id) => (id === 'cd19e75c' ? 404 : null) })
    expect(d).toContain('kártya: #404 (cd19e75c), #12, ismeretlen')
  })

  it('projekt neve nelkul az azonosito marad, ismeretlen eszkoz gepi neven', () => {
    expect(describeToolApproval({ ...base, projectName: null, tool: 'x.y', lang: 'hu', input: {} })).toBe('Munkapad: x.y — projekt p1 · kérte: boss')
    expect(toolLabel('file.delete', 'en')).toBe('delete a file (to the Trash)')
  })
})
