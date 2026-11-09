import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Request handlers must not run child processes synchronously: execSync of
// `claude mcp add` (15-30 s), unzip, cp or `sleep` freezes the whole dashboard.
describe('route handlers do not use execSync', () => {
  for (const f of ['connectors.ts', 'skills.ts', 'agents-skills.ts', 'agents.ts']) {
    it(`${f}: no execSync`, () => {
      const src = readFileSync(join(__dirname, '..', 'web', 'routes', f), 'utf-8')
      expect(src).not.toMatch(/\bexecSync\(/)
    })
  }
})
