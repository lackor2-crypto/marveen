import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Upstream 66d38ee45 (#932): macOS system python3 is 3.9 and cannot evaluate PEP 604
// unions (`str | None`) at def time. The hook must stay importable there, so it
// has to use lazy annotations, and the future import has to be the first statement
// after the module docstring (a later one is a SyntaxError).
describe('skill-usage-capture.py stays importable on Python 3.9', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'skill-usage-capture.py'), 'utf-8')

  it('declares lazy annotations', () => {
    expect(src).toMatch(/^from __future__ import annotations$/m)
  })

  it('has the future import before any other import', () => {
    const lines = src.split('\n')
    const fut = lines.findIndex((l) => l.trim() === 'from __future__ import annotations')
    const firstOther = lines.findIndex((l) => /^(import|from)\s+(?!__future__)/.test(l))
    expect(fut).toBeGreaterThanOrEqual(0)
    expect(fut).toBeLessThan(firstOther)
  })
})
