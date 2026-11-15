// #906 follow-up (Boss TG 6255/6257): the Technical details are compact (no long scroll), and with them open a rail tab pressed
// a second time folds the folder column away again (before: shTechWide stayed true, so the column could not be closed).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('technical details: compact layout and closing the column', () => {
  it('closing the rail tab while the details are open collapses the folder column (not wide)', () => {
    const line = js.split('\n').find((l) => l.includes("a === 'fr-tab'")) ?? ''
    expect(line).toContain('WB.shTechWide = !(closing && WB.shMore)')
    expect(line).not.toMatch(/WB\.shTechWide = true;/)
  })
  it('one press of the Projects button closes a column that is open only because the details are (frTab is empty then)', () => {
    const line = js.split('\n').find((l) => l.includes("a === 'fr-tab'")) ?? ''
    expect(line).toContain("(!WB.frTab && !!WB.shMore && tb === 'projects' && !frPanelCollapsed())")
  })
  it('the project/work item context blocks flow into columns inside the details', () => {
    expect(css).toMatch(/\.wb-fr-center-tech \.wb-panel-context \{[^}]*display: block[^}]*column-width/)
  })
  it('the details block is a compact multi-column grid with small tool buttons', () => {
    expect(css).toMatch(/\.wb-fr-center-tech \.wb-sh-tech \{[^}]*display: grid[^}]*repeat\(auto-fit/)
    expect(css).toMatch(/\.wb-fr-center-tech \.wb-sh-tech-actions \.btn-secondary \{[^}]*font-size: 12px/)
  })
})
