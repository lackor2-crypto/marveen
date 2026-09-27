import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #413, rebuilt from upstream f78bfe63 (the result half; the in-flight lock
// half is not needed here because our restartAgentProcess is synchronous, so
// no supervisor can run inside its stop window). A failed rescue restart must
// not be filed as a completed one.

const src = readFileSync(join(__dirname, '..', 'web', 'context-guard-runner.ts'), 'utf-8')

function between(from: string, to: string): string {
  const a = src.indexOf(from)
  expect(a, from).toBeGreaterThanOrEqual(0)
  const b = src.indexOf(to, a + from.length)
  expect(b, to).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('context-guard rescue restart failure', () => {
  it('performRestart throws when the sub-agent restart reports !ok', () => {
    const fn = between('function performRestart', 'async function checkAgent')
    expect(fn).toMatch(/const res = restartAgentProcess\(name, \{ fresh: true \}\)/)
    expect(fn).toMatch(/if \(!res\.ok\) throw new Error/)
  })

  it('the restart case rolls the state back and skips the restart notice on failure', () => {
    const body = between("case 'restart'", 'createAgentMessage(')
    const tryAt = body.indexOf('performRestart(name)')
    expect(tryAt).toBeGreaterThan(0)
    const tail = body.slice(tryAt)
    expect(tail).toMatch(/catch \(err\) \{[\s\S]*guardStates\.set\(name, INITIAL_GUARD_STATE\)[\s\S]*logger\.error\([\s\S]*break\s*\}/)
  })
})
