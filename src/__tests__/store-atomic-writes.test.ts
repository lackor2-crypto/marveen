// #798: the stores whose loss is felt (GitHub keys, mail rules, the Life tree's persons and companies, the Google token, the
// autonomy settings, the Life-tree ledger, the mail accounts' config) are written atomically. A direct write torn by a stop
// mid-write (power cut, a frozen VM, an OOM kill) left a half file; several readers then fall back to "empty" / the default,
// and the next save overwrote the owner's real data with it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/** The body of the function `name` in `file` (from its declaration to the next top-level declaration). */
function body(file: string, name: string): string {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const at = src.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'))
  if (at < 0) throw new Error(`${name} not found in ${file}`)
  const rest = src.slice(at + 1)
  const next = rest.search(/^(export |async |function |const |let |\/\*\*)/m)
  return src.slice(at, next < 0 ? undefined : at + 1 + next)
}

const DIRECT = /(?<!atomic)writeFileSync\(/

describe('#798 the important stores are written atomically', () => {
  const cases: [string, string, boolean][] = [
    ['src/git-accounts.ts', 'writeTokens', true],
    ['src/git-accounts.ts', 'setReadOnlyException', false],
    ['src/email-rules.ts', 'saveRules', false],
    ['src/life-tree.ts', 'saveLifeConfig', false],
    ['src/google-api.ts', 'saveTokens', true],
    ['src/autonomy.ts', 'saveAutonomyConfig', false],
    ['src/life-tree-ledger.ts', 'rememberLifeCreated', false],
    ['src/life-tree-ledger.ts', 'moveLifeLedgerPrefix', false],
  ]
  for (const [file, fn, secret] of cases) {
    it(`${file} ${fn}: atomic${secret ? ', 0600 from the first byte' : ''}`, () => {
      const b = body(file, fn)
      expect(b).toContain('atomicWriteFileSync(')
      expect(DIRECT.test(b)).toBe(false)
      if (secret) expect(b).toMatch(/atomicWriteFileSync\([^\n]*mode: 0o600/)
    })
  }

  it('the mail accounts\' config.toml is replaced atomically, 0600', () => {
    const src = readFileSync(join(ROOT, 'src/web/routes/email.ts'), 'utf8')
    expect(src).toContain('atomicWriteFileSync(HIMALAYA_CONFIG, toml, { mode: 0o600 })')
    expect(src).not.toMatch(/(?<!atomic)writeFileSync\(HIMALAYA_CONFIG,/)
  })
})
