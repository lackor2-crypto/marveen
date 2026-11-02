// #817: a project Research/Debate request goes to whichever agent is available,
// so no debate-related setting text may name the main agent as the one who runs it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

function line(src: string, key: string): string {
  const l = src.split('\n').find((x) => x.includes(`'${key}'`) || x.includes(`"${key}"`))
  expect(l, key).toBeTruthy()
  return l as string
}

describe('debate setting descriptions do not name the main agent (#817)', () => {
  const keys = ['settings.desc.DEBATE_MODELS', 'settings.desc.DEBATE_MAX_ROUNDS']
  it.each(['web/lang/hu.js', 'web/lang/en.js'])('%s', (file) => {
    const src = read(file)
    for (const k of keys) expect(line(src, k)).not.toMatch(/fő[ -]agens|main agent/i)
  })
  it('config-registry DEBATE_MODELS description', () => {
    const src = read('src/config-registry.ts')
    const i = src.indexOf("key: 'DEBATE_MODELS'")
    expect(i).toBeGreaterThan(-1)
    const block = src.slice(i, src.indexOf('module:', i))
    expect(block).not.toMatch(/fő[ -]agens|main agent/i)
  })
})
