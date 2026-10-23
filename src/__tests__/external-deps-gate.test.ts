// #766: a Vault id the code reads must have a setup-wizard row (vaultIds) or a reasoned exception.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractVaultIds, scanVaultIds } from '../external-deps-scan.js'
import { SETUP_ITEMS } from '../web/setup-wizard-registry.js'

const ROOT = resolve(__dirname, '..', '..')
const exceptions: Array<{ vaultId: string; reason: string }> = JSON.parse(readFileSync(resolve(ROOT, 'governance/external-deps-exceptions.json'), 'utf8')).exceptions
const covered = new Set(SETUP_ITEMS.flatMap(i => i.vaultIds ?? []))
const excepted = new Set(exceptions.map(e => e.vaultId))
const used = scanVaultIds(resolve(ROOT, 'src'), ROOT)

describe('external dependency gate (#766)', () => {
  it('reads literal Vault ids and VAULT constants, not dynamic ones', () => {
    expect(extractVaultIds(`getSecret('a-key'); const X_VAULT_ID = "b-key"; getSecret(\`agent-\${n}-key\`); getSecret(name)`).sort()).toEqual(['a-key', 'b-key'])
  })
  it('every Vault id in the code has a wizard row or a reasoned exception', () => {
    const missing = [...used].filter(([id]) => !covered.has(id) && !excepted.has(id)).map(([id, f]) => `${id} (${f})`)
    expect(missing, `Add SetupItem.vaultIds in src/web/setup-wizard-registry.ts, or an entry with a reason in governance/external-deps-exceptions.json:\n${missing.join('\n')}`).toEqual([])
  })
  it('exceptions carry a reason and are not stale', () => {
    for (const e of exceptions) expect(e.reason.length, e.vaultId).toBeGreaterThanOrEqual(15)
    const stale = exceptions.filter(e => !used.has(e.vaultId) || covered.has(e.vaultId)).map(e => e.vaultId)
    expect(stale, 'remove from governance/external-deps-exceptions.json').toEqual([])
  })
})

describe('land-pr.sh warning (#766)', () => {
  it('warns loudly when the diff brings in a new Vault id', () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/land-pr.sh'), 'utf8')
    expect(sh).toContain('KULSO FUGGOSEG')
    expect(sh).toContain('external-deps-exceptions.json')
  })
})

describe('scheduled watch (#766)', () => {
  it('is silent when green and reports through notify.sh in Hungarian', () => {
    const sh = readFileSync(resolve(ROOT, 'scripts/external-deps-watch.sh'), 'utf8')
    expect(sh).toContain('notify.sh')
    expect(sh).toContain('log "OK"')
    expect(sh).toContain('--report-only')
  })
})
