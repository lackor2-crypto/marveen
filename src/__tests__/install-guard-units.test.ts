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

  it('a panel-menu orszem (modal-guard) is bent van, hordozhatoan (#358)', () => {
    expect(guards().map((g) => g.name)).toContain('modal-guard')
    const g = readFileSync(join(ROOT, 'scripts', 'modal-question-guard.sh'), 'utf8')
    // Korabban csak store/-ban elt, fix /home/boss uttal es "Marvin" nevvel.
    expect(g).not.toMatch(/\/home\/[a-z]/)
    expect(g).not.toMatch(/Marvin/)
    // md5sum nincs macOS-en.
    expect(g).not.toMatch(/\bmd5sum\b/)
    expect(g).toMatch(/INSTALL_DIR="\$\(cd "\$\(dirname/)
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
    writeFileSync(join(unitDir, `${sid}-dashboard-health.service`), 'KEZZEL HANGOLT\n')
    const out = execFileSync('bash', [SCRIPT, '--dry-run'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    expect(out).toMatch(/orszemek: \d+ uj, 1 mar megvolt/)
    expect(out).not.toMatch(/\[dry-run\] \S+-dashboard-health /)
    expect(readFileSync(join(unitDir, `${sid}-dashboard-health.service`), 'utf8')).toBe('KEZZEL HANGOLT\n')
    expect(existsSync(join(unitDir, `${sid}-ratelimit-alert.timer`))).toBe(false)
  })

  // #411 (owner, TG 6581/6593, 2026-09-26): the 6-hourly backup timer made
  // 4-5 backups a day while Settings -> Backup said "once a day".
  describe('a regi 6 oras mentes-idozito (#411)', () => {
    const sid = (() => {
      try {
        const env = readFileSync(join(ROOT, '.env'), 'utf8')
        const m = /^SERVICE_ID=(.*)$/m.exec(env) || /^MAIN_AGENT_ID=(.*)$/m.exec(env)
        return m ? m[1].replace(/["' ]/g, '').replace(/[^a-zA-Z0-9_-]/g, '') || 'marveen' : 'marveen'
      } catch { return 'marveen' }
    })()
    // A fake systemctl first on PATH: the test must never touch this
    // machine's real user units (the SERVICE_ID comes from the real .env).
    function sandbox() {
      const home = mkdtempSync(join(tmpdir(), 'marveen-retire-'))
      const unitDir = join(home, '.config', 'systemd', 'user')
      const bin = join(home, 'bin')
      mkdirSync(unitDir, { recursive: true })
      mkdirSync(bin)
      const log = join(home, 'systemctl.log')
      writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 })
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }
      return { unitDir, env, log }
    }

    it('az orszem-listaban nincs tobbe mentes (a dashboard sajat utemezoje ment naponta egyszer)', () => {
      expect(guards().map((g) => g.name)).not.toContain('backup')
    })

    it('a sajat regi egyseget --retire-only leveszi, mast nem ir', () => {
      if (process.platform !== 'linux') return
      const { unitDir, env, log } = sandbox()
      writeFileSync(join(unitDir, `${sid}-backup.service`), `[Service]\nExecStart=/usr/bin/bash ${ROOT}/scripts/backup.sh\n`)
      writeFileSync(join(unitDir, `${sid}-backup.timer`), '[Timer]\nOnUnitActiveSec=21600s\n')
      execFileSync('bash', [SCRIPT, '--retire-only'], { env, encoding: 'utf8' })
      expect(existsSync(join(unitDir, `${sid}-backup.service`))).toBe(false)
      expect(existsSync(join(unitDir, `${sid}-backup.timer`))).toBe(false)
      expect(readFileSync(log, 'utf8')).toContain(`--user disable --now ${sid}-backup.timer`)
      expect(existsSync(join(unitDir, `${sid}-ratelimit-alert.timer`))).toBe(false)
    })

    it('a kezzel hangolt (nem scripts/backup.sh-t futtato) azonos nevu egyseg marad', () => {
      if (process.platform !== 'linux') return
      const { unitDir, env } = sandbox()
      writeFileSync(join(unitDir, `${sid}-backup.service`), '[Service]\nExecStart=/opt/sajat/mentes.sh\n')
      const out = execFileSync('bash', [SCRIPT, '--retire-only'], { env, encoding: 'utf8' })
      expect(out).toContain('nem a regi mentes-idozito, marad')
      expect(readFileSync(join(unitDir, `${sid}-backup.service`), 'utf8')).toContain('/opt/sajat/mentes.sh')
    })

    it('szarazfutasban csak jelzi, nem torol', () => {
      if (process.platform !== 'linux') return
      const { unitDir, env } = sandbox()
      writeFileSync(join(unitDir, `${sid}-backup.service`), `[Service]\nExecStart=/usr/bin/bash ${ROOT}/scripts/backup.sh\n`)
      const out = execFileSync('bash', [SCRIPT, '--dry-run', '--retire-only'], { env, encoding: 'utf8' })
      expect(out).toContain(`[dry-run] retire ${sid}-backup`)
      expect(existsSync(join(unitDir, `${sid}-backup.service`))).toBe(true)
    })

    it('a frissites (update.sh) is leveszi a meglevo telepitesen', () => {
      const upd = readFileSync(join(ROOT, 'update.sh'), 'utf8')
      expect(upd).toMatch(/install-guard-units\.sh" --retire-only/)
      const maint = upd.slice(upd.indexOf('run_unit_maintenance() {'), upd.indexOf('}', upd.indexOf('run_unit_maintenance() {')))
      expect(maint).toContain('retire_legacy_backup_timer')
    })
  })
})
