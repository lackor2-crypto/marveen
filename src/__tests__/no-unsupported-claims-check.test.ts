// #843 (Boss, TG 4511): "Igazolt forras nelkuli allitas" must not be checked: the owner's own statement is its own source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8')

describe('#843 no check for statements without a verified source', () => {
  it('documentCheck has no unsupported_claims item and the section problem counter ignores unverified claims', () => {
    const src = read('src/workbench-docmodel.ts')
    expect(src).not.toMatch(/key: 'unsupported_claims'/)
    expect(src).not.toMatch(/const problems = bs\.reduce\([^\n]*unverified/)
  })
  it('the Gaps tab does not list unverified statements, and the texts are gone from both languages', () => {
    expect(read('web/workbench.js')).not.toMatch(/c\.strength === 'unverified' \|\| c\.strength === 'owner_unconfirmed'/)
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) expect(read(f)).not.toContain('outline.check.unsupported_claims')
    expect(read('web/lang/hu.js')).not.toContain('⚠ nincs igazolt forrása"')
    expect(read('src/workbench-check-todos.ts')).not.toContain('unsupported_claims')
  })
})
