// Boss (2026-11-03): "az üres sor ne tűnjön el": an empty line that was NOT made with Enter in the editor (the assistant's block,
// an import) is drawn on the work item page as a real empty line (<br>), exactly like an Enter-made one, not as a collapsed element.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('a stored empty line is drawn as a line on the page', () => {
  it('the block row passes a <br> for a blank paragraph', () => {
    expect(JS).toContain('function dpBlankParagraph(b)')
    expect(JS).toContain("dpBlankParagraph(b) ? '<br>' : dpBlockRich(b)")
  })
})
