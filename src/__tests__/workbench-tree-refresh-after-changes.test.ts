// Boss TG 4486: the left tree follows a move to the Life tree, an annex link and a link into a folder at once (no F5).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const fnBody = (name: string): string => {
  const i = src.indexOf('function ' + name + '(')
  expect(i).toBeGreaterThan(-1)
  return src.slice(i, i + 20000)
}

describe('tree refresh after file changes', () => {
  it('the move to the Life tree refreshes the tree after the move', () => {
    const body = fnBody('lifeMoveOpen')
    expect(body).toMatch(/refreshTree\(\)/)
  })
  it('an annex linked from the project documents panel refreshes the tree', () => {
    expect(src).toMatch(/loadProjectDocs\(\)\s*\n\s*refreshTree\(\)/)
  })
  it('a link into an item folder reloads the open item', () => {
    expect(src).toMatch(/r\.data\.item && WB\.selectedId === r\.data\.item\) loadDetail/)
  })
})
