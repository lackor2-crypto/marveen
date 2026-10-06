// Kod-hid vegrehajto: a felderites nem allithatja meg a munkat (kanban #425).
//
// Mert eset 2026-09-27: a worker a claim ELOTT futtatta a ~7 perces
// beszelgetes-felderitest, ezert ket feladat kozott 7-8 percig allt, es kozben
// a dashboard offline-nak latta. Ez a teszt a szkript szerkezetet orzi.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ps = readFileSync(join(__dirname, '..', '..', 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf-8').replace(/\r\n/g, '\n')
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
const loop = ps.slice(ps.indexOf('function Start-WorkerLoop'), ps.indexOf('# ---- entry'))

describe('code worker #425', () => {
  it('a fo ciklus ELOBB kér munkat, a felderites csak ures korben fut', () => {
    const claimAt = loop.indexOf("'/api/code/tasks/claim'")
    const discoverAt = loop.indexOf('Publish-Sessions')
    expect(claimAt).toBeGreaterThan(-1)
    expect(discoverAt).toBeGreaterThan(claimAt)
    expect(loop).toMatch(/\(-not \$claim -or -not \$claim\.task\) -and/)
    expect(loop).toContain('$script:PendingTask')
  })

  it('-DiscoverOnly alatt a felderites NEM ker munkat (nem hagy lefoglalt, gazdatlan feladatot)', () => {
    const fn = ps.slice(ps.indexOf('function Test-WorkWaiting'), ps.indexOf('function Read-TranscriptInfo'))
    const guard = fn.indexOf('if ($DiscoverOnly) { return }')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fn.indexOf("'/api/code/tasks/claim'"))
    expect(guard).toBeLessThan(fn.indexOf('throw $script:DiscoveryInterrupted'))
  })

  it('a felderites kozben is ker munkat, feladat alatt pedig a feladat szivveret kuldi', () => {
    const fn = ps.slice(ps.indexOf('function Test-WorkWaiting'), ps.indexOf('function Read-TranscriptInfo'))
    expect(fn).toContain("/heartbeat'")
    expect(fn).toContain("'/api/code/tasks/claim'")
    expect(fn.indexOf('$script:InTaskId')).toBeLessThan(fn.indexOf("'/api/code/tasks/claim'"))
    const local = ps.slice(ps.indexOf('function Get-LocalSessions'), ps.indexOf('function Publish-Sessions'))
    expect(local).toContain('Test-WorkWaiting')
  })

  it('a mar elolvasott fajlt nem olvassa ujra (meret + mtime kulcs)', () => {
    expect(ps).toMatch(/Get-CachedFileValue \$f 'session'/)
    expect(ps).toMatch(/Get-CachedFileValue \$f 'info'/)
    expect(ps).toMatch(/Get-CachedFileValue \$f 'usage'/)
  })

  it('eletjel-fajl + a beragadt worker atvetele', () => {
    expect(ps).toContain('function Update-Alive')
    expect(ps).toMatch(/StallTakeoverSec/)
    expect(ps).toMatch(/CommandLine -match 'marvin-code-worker'/)
  })

  // Mert eset 2026-10-06: `Get-Content -Tail 60` 189 mp egy 2,1 MB-os
  // transcripten (ket 611 KB-os base64-kepes sor a farkaban); a felderites
  // ennyi ideig nem irt eletjelet, a kovetkezo utemezett inditas feladat
  // kozben leallitotta a workert, es minden feladat 3x futott, majd hibaval zarult.
  it('a usage-olvasas korlatos, a fajl vegere ugrik, nem Get-Content -Tail', () => {
    const fn = ps.slice(ps.indexOf('function Read-TranscriptUsage'), ps.indexOf('function Get-WslRunningPids'))
    const code = fn.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toMatch(/Get-Content[^\n]*-Tail/)
    expect(fn).toMatch(/\$tailBytes = \d+/)
    expect(fn).toContain("Seek(-$tailBytes, 'End')")
    expect(fn).toContain('$lines.RemoveAt(0)')
  })

  it('a felderites fajlonkent is frissiti az eletjelet, nem csak mappankent', () => {
    const local = ps.slice(ps.indexOf('function Get-LocalSessions'), ps.indexOf('function Publish-Sessions'))
    const perFile = local.slice(local.indexOf('foreach ($f in $files) {'))
    expect(perFile.indexOf('Test-WorkWaiting')).toBeGreaterThan(-1)
    expect(perFile.indexOf('Test-WorkWaiting')).toBeLessThan(perFile.indexOf("Read-TranscriptInfo -Path"))
  })

  it('az onfrissites a felderites ELOTT fut, igy egy beragado felderites nem akadalyozza', () => {
    expect(loop.indexOf('Invoke-SelfUpdate -Expected')).toBeGreaterThan(-1)
    expect(loop.indexOf('Invoke-SelfUpdate -Expected')).toBeLessThan(loop.indexOf('Publish-Sessions'))
  })

  it('a verzio emelve, hogy a futo worker magat frissitse', () => {
    expect(ps).not.toContain("$script:WorkerVersion = '2026-09-19.1'")
  })

  it('a Jovahagyasok oldal kimondja, ha a VS Code vegrehajto all', () => {
    expect(app).toContain('function _approvalsCodeWorkerNote')
    expect(app).toContain("t('approvals.verify.code_worker_stalled'")
  })
})
