// A FUGGETLEN ORSZEMEK FRISS TELEPITESEN IS (audit f97acc32).
//
// A referencia-telepitesen tizennegy idozito futott (mentes, dashboard-orszem,
// csatorna-orszem, keret-riasztas...), amit egyetlen telepito sem hozott letre.
// Ez a teszt azt kenyszeriti ki, hogy (1) minden orszem szkriptje a repoban
// legyen (ne a store/-ban), (2) mindket telepito meghivja a letrehozot, es
// (3) a letrehozo soha ne irjon felul egy meglevo unitot.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'install-guard-units.sh')
const src = readFileSync(SCRIPT, 'utf8')

function guards(): Array<{ name: string; cmd: string }> {
  const block = src.slice(src.indexOf('GUARDS=('), src.indexOf('\n)', src.indexOf('GUARDS=(')))
  return [...block.matchAll(/^\s*"([^|]+)\|([^|]+)\|/gm)].map((m) => ({ name: m[1], cmd: m[2] }))
}

describe('install-guard-units.sh', () => {
  it('minden orszem szkriptje a repoban van, nem a store/-ban', () => {
    const g = guards()
    expect(g.length).toBeGreaterThanOrEqual(10)
    for (const { name, cmd } of g) {
      const script = cmd.split(' ').find((w) => w.startsWith('scripts/'))
      expect(script, name).toBeTruthy()
      expect(existsSync(join(ROOT, script!)), `${name}: ${script}`).toBe(true)
    }
  })

  it('mindket telepito meghivja', () => {
    for (const f of ['install-linux.sh', 'install-macos.sh']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).toMatch(/scripts\/install-guard-units\.sh/)
    }
  })

  it('nincs beegetett gep-azonosito: a nev a SERVICE_ID-bol jon', () => {
    expect(src).toMatch(/SERVICE_ID="\$\{SERVICE_ID:-/)
    expect(src).not.toMatch(/\/home\/[a-z]/)
  })

  it('szarazfutasban unitot nem ir, es a meglevot nem irja felul', () => {
    if (process.platform !== 'linux') return
    const home = mkdtempSync(join(tmpdir(), 'marveen-guards-'))
    const unitDir = join(home, '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    // A SERVICE_ID a repo .env-jebol jon; ures .env eseten a "marveen" az alap.
    const sid = (() => {
      try {
        const env = readFileSync(join(ROOT, '.env'), 'utf8')
        const m = /^SERVICE_ID=(.*)$/m.exec(env) || /^MAIN_AGENT_ID=(.*)$/m.exec(env)
        return m ? m[1].replace(/["' ]/g, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'marveen' : 'marveen'
      } catch { return 'marveen' }
    })()
    writeFileSync(join(unitDir, `${sid}-backup.service`), 'KEZZEL HANGOLT\n')
    const out = execFileSync('bash', [SCRIPT, '--dry-run'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    expect(out).toMatch(/orszemek: \d+ uj, 1 mar megvolt/)
    expect(out).not.toMatch(/\[dry-run\] \S+-backup /)
    expect(readFileSync(join(unitDir, `${sid}-backup.service`), 'utf8')).toBe('KEZZEL HANGOLT\n')
    expect(existsSync(join(unitDir, `${sid}-ratelimit-alert.timer`))).toBe(false)
  })
})
