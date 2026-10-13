import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', 'web')
const js = readFileSync(join(root, 'workbench.js'), 'utf8')
const css = readFileSync(join(root, 'workbench.css'), 'utf8')

describe('chat fold box (TG 3158)', () => {
  it('wraps the opened rows in a tinted box', () => {
    expect(js).toContain('wb-chat-fold-box')
    expect(css).toMatch(/\.wb-chat-fold-box \{ background:/)
  })
})
