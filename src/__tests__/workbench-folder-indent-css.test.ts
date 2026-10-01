// Nested Workbench folders must render indented. A `margin` shorthand on
// .wb-folder-row placed after the .wb-depth-N rules wipes their margin-left
// (same specificity, later wins), so every folder row sat flush left.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')

describe('workbench folder indentation css', () => {
  it('does not reset margin-left on folder rows with a margin shorthand', () => {
    const rule = css.match(/^\.wb-folder-row \{[^}]*\}/m)
    expect(rule).not.toBeNull()
    expect(rule![0]).not.toMatch(/(^|[\s;{])margin\s*:/)
  })

  it('indents deeper levels further', () => {
    const px = (n: number) => Number(css.match(new RegExp('\\.wb-depth-' + n + ' \\{ margin-left: (\\d+)px'))![1])
    expect(px(2)).toBeGreaterThan(px(1))
    expect(px(1)).toBeGreaterThan(0)
  })
})
