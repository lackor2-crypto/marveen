import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findHimalayaBin, type HimalayaBinDeps } from '../web/himalaya-bin.js'

const HOME = '/home/u'
const LOCAL = join(HOME, '.local', 'bin', 'himalaya')

function deps(over: Partial<HimalayaBinDeps> & { files?: string[] }): HimalayaBinDeps {
  const files = new Set(over.files || [])
  return {
    env: over.env || {},
    exists: over.exists || ((p) => files.has(p)),
    resolve: over.resolve || (() => null),
    home: HOME,
  }
}

describe('findHimalayaBin (#358: macOS brew-telepites)', () => {
  it('a telepito sajat helyet (~/.local/bin) hasznalja, ha ott van', () => {
    expect(findHimalayaBin(deps({ files: [LOCAL], resolve: () => '/opt/homebrew/bin/himalaya' })))
      .toEqual({ path: LOCAL, found: true })
  })

  it('macOS: ha ~/.local/bin-ben nincs, a brew-os utat talalja meg a PATH-on', () => {
    expect(findHimalayaBin(deps({ resolve: (n) => (n === 'himalaya' ? '/opt/homebrew/bin/himalaya' : null) })))
      .toEqual({ path: '/opt/homebrew/bin/himalaya', found: true })
  })

  it('MARVEEN_HIMALAYA felulir mindent', () => {
    expect(findHimalayaBin(deps({ env: { MARVEEN_HIMALAYA: '/x/himalaya' }, files: ['/x/himalaya', LOCAL] })))
      .toEqual({ path: '/x/himalaya', found: true })
  })

  it('ha sehol nincs: found=false, es a telepito helyet adja (valodi ENOENT a hivonak)', () => {
    expect(findHimalayaBin(deps({}))).toEqual({ path: LOCAL, found: false })
  })

  it('az email route nem hasznal tobbe fix ~/.local/bin utat', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf8')
    expect(src).not.toMatch(/\.local\/bin\/himalaya/)
    expect(src).toMatch(/himalayaBin\(\)/)
  })
})
