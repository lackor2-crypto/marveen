import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PROMPT_MAX_CHARS } from '../web/code-bridge-store.js'

// Boss TG 5799: a project chat message of a few ten thousand characters (a small novel) must go through; the old
// 12 000 limit answered "prompt too long (12916 > 12000)".
const root = path.resolve(__dirname, '..', '..')
const app = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8')

describe('chat message length limit is 100 000 characters (#892)', () => {
  it('the bridge accepts at least 100 000 characters', () => {
    expect(PROMPT_MAX_CHARS).toBe(100_000)
  })
  it('the dashboard conversation box uses the same number, not a hard-coded 12000', () => {
    expect(app).toMatch(/const CONV_SEND_MAX_CHARS = 100000/)
    expect(app).not.toMatch(/text\.length > 12000/)
  })
})
