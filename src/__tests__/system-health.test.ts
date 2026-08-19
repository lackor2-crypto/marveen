/**
 * A rendszer-ellenorzesek tesztje.
 *
 * Mind egy MERT hibat orz (2026-08-19, ezen a gepen):
 *  - a 6 oras automata mentes hetekig sikeresen futott, es a valodi
 *    archivumban (claudeclaw-20260819-125659.tar.gz) az adatbazison es a
 *    dashboard-tokenen kivul SEMMI nem volt a store/-bol: a tiz Google-fiok, a
 *    GitHub-tokenek, az OAuth-kliens es a szef kulcsa mind kimaradt;
 *  - a dashboard a sajat bearer tokenjet a stderr-re irta, amit a systemd egy
 *    0664-es naplofajlba iranyit -> 365 sorban ott allt a titok.
 *
 * A lenyeg mindkettonel ugyanaz: a muvelet SIKERESNEK latszott. Ezert nem a
 * kilepokodot nezzuk, hanem a TARTALMAT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveMissing, secretsInLogs, worstHealthStatus, MUST_BACKUP } from '../web/system-health.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'health-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** Olyan tar.gz-t gyartunk, amilyet a backup.sh: repo/store/... utakkal. */
function makeArchive(files: string[]): string {
  const stage = join(dir, 'stage', 'repo', 'store')
  mkdirSync(stage, { recursive: true })
  for (const f of files) writeFileSync(join(stage, f), 'DUMMY-NEM-TITOK')
  const archive = join(dir, 'claudeclaw-teszt.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'stage'), '.'])
  return archive
}

describe('a mentes TARTALMA', () => {
  it('eszreveszi, ha a hozzaferesek kimaradtak -- ez volt a valodi hiba', () => {
    // Pontosan az, amit a 2026-08-19-i archivum tartalmazott.
    const a = makeArchive(['claudeclaw.db', '.dashboard-token', 'config-overrides.json'])
    const missing = archiveMissing(a)
    expect(missing).not.toBeNull()
    expect(missing).toEqual([...MUST_BACKUP])
  })

  it('a teljes mentesre nem panaszkodik', () => {
    expect(archiveMissing(makeArchive([...MUST_BACKUP, 'claudeclaw.db']))).toEqual([])
  })

  it('reszleges hianyt is megnevez, nem csak "valami hianyzik"-ot mond', () => {
    const a = makeArchive(['google-tokens.json', 'vault.json', 'claudeclaw.db'])
    expect(archiveMissing(a)).toEqual(['google-oauth-client.json', '.github-tokens.json', '.vault-key'])
  })

  it('serult archivum eseten NEM mond zoldet, hanem "nem tudom"-ot', () => {
    const rossz = join(dir, 'romlott.tar.gz')
    writeFileSync(rossz, 'ez nem egy tar')
    // null = nem eldontheto. A [] (=minden rendben) itt hazugsag lenne.
    expect(archiveMissing(rossz)).toBeNull()
  })

  it('a nev-egyezes vegen horgonyzik: a "google-tokens.json.bak" nem szamit mentesnek', () => {
    const a = makeArchive(['google-tokens.json.bak'])
    expect(archiveMissing(a)).toContain('google-tokens.json')
  })
})

describe('a gyorsitotar nem hazudik', () => {
  // A tar-listazas 200 ms volt MINDEN Attekintes-betoltesnel (merve), ezert
  // memoizalva van. Egy rosszul kulcsolt gyorsitotar viszont pont a friss
  // mentesrol mondana a REGI valaszt -- ezert az archivum azonossagara
  // (utvonal + mtime + meret) kulcsolunk, nem csak az utvonalra.
  it('az ujrairt archivumot ujra megnezi, nem a regi valaszt adja', () => {
    const stage = join(dir, 'stage', 'repo', 'store')
    mkdirSync(stage, { recursive: true })
    for (const f of MUST_BACKUP) writeFileSync(join(stage, f), 'X')
    const a = join(dir, 'ugyanaz.tar.gz')
    execFileSync('tar', ['-czf', a, '-C', join(dir, 'stage'), '.'])
    expect(archiveMissing(a)).toEqual([])

    // Ugyanaz a NEV, mas tartalom -- ez a csapda.
    rmSync(join(stage, 'google-tokens.json'))
    const kesobb = new Date(Date.now() + 2000)
    execFileSync('tar', ['-czf', a, '-C', join(dir, 'stage'), '.'])
    utimesSync(a, kesobb, kesobb)
    expect(archiveMissing(a)).toEqual(['google-tokens.json'])
  })
})

describe('titok a naplokban', () => {
  it('eszreveszi a naploba irt hozzaferesi tokent', () => {
    writeFileSync(join(dir, 'dashboard.error.log'),
      'Dashboard access URL:\n  http://127.0.0.1:3420/?token=' + 'a'.repeat(64) + '\n')
    expect(secretsInLogs(dir)).toEqual(['dashboard.error.log'])
  })

  it('a szokasos naplosorokra nem riogat', () => {
    writeFileSync(join(dir, 'nyugodt.log'),
      'GET /api/connections/summary 200\nbackup: wrote claudeclaw-20260819.tar.gz\ntoken=rovid\n')
    expect(secretsInLogs(dir)).toEqual([])
  })

  it('csak a naplokat nezi -- a token-tarat nem jelenti sajat magara', () => {
    writeFileSync(join(dir, 'google-tokens.json'), '{"a":{"refresh_token":"NEM-TITOK-CSAK-TESZT"}}')
    expect(secretsInLogs(dir)).toEqual([])
  })
})

describe('a legrosszabb allapot', () => {
  it('a rossz uti a figyelmeztetot, a figyelmezteto a rendbent', () => {
    expect(worstHealthStatus([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warn' }])).toBe('warn')
    expect(worstHealthStatus([{ id: 'a', status: 'warn' }, { id: 'b', status: 'bad' }])).toBe('bad')
    expect(worstHealthStatus([])).toBe('ok')
  })
})

describe('a mento scriptek ES a lista egyutt mozognak', () => {
  // Ez a teszt a DRIFTET fogja meg: a listat a kod ismeri, a mentest egy shell
  // script vegzi. Ket kulon helyen leirt igazsag -- pontosan igy allt elo, hogy
  // a mentes evekig "mukodott" a rossz fajllal.
  it('scripts/backup.sh minden kotelezo hozzaferest ment', () => {
    const sh = readFileSync(join(REPO, 'scripts', 'backup.sh'), 'utf8')
    for (const f of MUST_BACKUP) expect(sh, `hianyzik: ${f}`).toContain(`store/${f}`)
  })

  it('a kezi personal-backup/backup.sh is', () => {
    const sh = readFileSync(join(REPO, 'personal-backup', 'backup.sh'), 'utf8')
    for (const f of MUST_BACKUP) expect(sh, `hianyzik: ${f}`).toContain(`store/${f}`)
  })

  it('a dashboard tokenjet csak IGAZI terminalra irjuk ki', () => {
    // A regi kod feltetelezte, hogy a stderr = terminal. A systemd alatt az egy
    // 0664-es fajl volt. A feltetelt tehat MEG kell kerdezni, nem feltenni.
    const web = readFileSync(join(REPO, 'src', 'web.ts'), 'utf8')
    const blokk = web.slice(web.indexOf('bootstrapUrl') - 900, web.indexOf('bootstrapUrl') + 900)
    expect(blokk).toContain('process.stderr.isTTY')
    // es a token-es valtozat a felteteles agon belul all
    const ttyIdx = web.indexOf('process.stderr.isTTY')
    const tokenIdx = web.indexOf('?token=${DASHBOARD_TOKEN}')
    expect(ttyIdx).toBeGreaterThan(0)
    expect(tokenIdx).toBeGreaterThan(ttyIdx)
  })
})
