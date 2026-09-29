import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The sidebar "working" counter must count each VS Code card (one per project) separately.
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
const m = /const workingCount = (entries\.reduce\([\s\S]*?\}, 0\))\n/.exec(app)

function count(entries: unknown[]): number {
  return new Function('entries', `return ${m![1]}`)(entries) as number
}

describe('sidebar working counter counts VS Code cards separately', () => {
  it('finds the counting code', () => { expect(m).not.toBeNull() })
  it('two working code-bridge projects + two agents = 4', () => {
    expect(count([
      { name: 'a', state: 'working' }, { name: 'b', state: 'working' }, { name: 'c', state: 'idle' },
      { kind: 'code-bridge', state: 'working', projects: { p1: { state: 'working' }, p2: { state: 'working' }, p3: { state: 'idle' } } },
    ])).toBe(4)
  })
  it('an old server without the projects map counts the bridge once', () => {
    expect(count([{ kind: 'code-bridge', state: 'working' }])).toBe(1)
  })
  it('an idle bridge counts nothing', () => {
    expect(count([{ kind: 'code-bridge', state: 'idle', projects: {} }])).toBe(0)
  })
})
