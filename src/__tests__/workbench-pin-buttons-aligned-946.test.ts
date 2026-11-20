import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

// #946: the pinned "New work item" button carried an 8 px top margin from the generic button rule, so it stood lower than
// "Upload files" and the Trash toggle. The pinned box rule must zero that margin and give the button the same border box.
describe('Workbench pinned buttons share one line (#946)', () => {
  const rules = css.split('}').filter((r) => /\.wb-pin-acts \.wb-new-btn\s*\{[^}]*$/.test(r + '}') || /\.wb-pin-acts \.wb-new-btn\s*$/.test(r.split('{')[0].trim()))
  const last = rules[rules.length - 1] || ''
  it('the last .wb-pin-acts .wb-new-btn rule removes the margin and aligns to the top', () => {
    expect(last).toMatch(/margin:\s*0/)
    expect(last).toMatch(/align-self:\s*flex-start/)
  })
  it('the new button has the same 1px border box as the secondary buttons (equal height)', () => {
    expect(last).toMatch(/border:\s*1px solid transparent/)
  })
  it('the row aligns its items to the top', () => {
    expect(css).toMatch(/\.wb-pin-acts\s*\{\s*align-items:\s*flex-start/)
  })
})
