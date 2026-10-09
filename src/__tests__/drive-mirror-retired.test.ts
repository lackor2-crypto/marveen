/**
 * A LEFELE TUKOR MEGSZUNT, HELYETTE HELYREALLITAS A FELHOBOL (#513).
 *
 * Boss, 2026-10-08: egy peldany elve -- az Eletfa az elsodleges, a Drive csak
 * felfele masolat. "k3 A" (a Rendszer alatti Drive-tukor megszunik, lefele
 * tukrot nem lehet tobbe beallitani) + "ha a marveent ujratelepitem valahol,
 * akkor a felhobol le tudjon hozni mindent. helyreallitani az eletfat."
 *
 * Amit ez a fajl orzi:
 *   1. Uj lefele tukor nem veheto fel: se gomb, se valaszto, a vegpont 410.
 *   2. A regi tukor-parok nem futnak, csak levalaszthatok.
 *   3. A helyreallitas a mentes-mappa sajat jelzesebol tudja, hova kell vissza,
 *      es CSAK a hianyzo fajlokat hozza le, meglevot nem ir felul.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { restoreWalk, restoreNameOk, backupFolderLocalPath, mentesMappaNev, BACKUP_PATH_PROP, type RestoreEntry } from '../web/routes/drive-sync.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const server = readFileSync(join(ROOT, 'src', 'web', 'routes', 'drive-sync.ts'), 'utf8')
const nyelvek = ['hu', 'en'].map((n) => readFileSync(join(ROOT, 'web', 'lang', `${n}.js`), 'utf8'))

/** Egy fuggveny torzse az app.js-bol, zarojel-parositassal. */
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  const i = src.indexOf('{', start.index)
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

describe('lefele tukrot nem lehet tobbe felvenni', () => {
  it('nincs Drive-mappa valaszto es "teljes Drive lehozasa" gomb', () => {
    for (const id of ['drivePickModal', 'depoSyncWholeBtn', 'depoSyncPickBtn', 'depoSyncAddBtn', 'depoSyncFolderId']) {
      expect(html, id).not.toContain(`id="${id}"`)
    }
    for (const fn of ['openDrivePicker', '_depoAddWholeDrive', '_depoPickDriveFolder', '_depoAddSync']) {
      expect(app, fn).not.toMatch(new RegExp(`function ${fn}\\s*\\(`))
    }
  })

  it('a felvevo vegpont 410-et ad, emberi mondattal', () => {
    const i = server.indexOf("'/api/drive/sync/add'")
    expect(i).toBeGreaterThan(-1)
    const blokk = server.slice(i, i + 800)
    expect(blokk).toContain('410')
    expect(blokk).toContain("code: 'mirror_retired'")
  })

  it('a futtatas csak a mentes-parokat viszi', () => {
    expect(server).toMatch(/cfg\.pairs\)\.filter\(\(p\) => p\.backup\)/)
  })

  it('a regi tukor-par a listaban csak levalaszthato', () => {
    const f = extractFn(app, '_depoRefresh')
    expect(f).toContain("t('dsync.retired_note')")
    expect(f).toContain('data-depo-unsync')
    expect(server).toContain('retired: !p.backup')
  })
})

describe('a fioklegordulo fuggetlen a depo allapotatol', () => {
  // Ez VALODI hiba volt: a fioklista feltoltese a _depoRefresh legvegen allt,
  // a `/api/depot/status` lekerdezese UTAN -- amelynek a hibaaga `return`-nel
  // kilep. Ha tehat a depo-allapot barmiert nem jott meg, a legordulo URESEN
  // maradt, a "Drive-mappa kiválasztása" gomb meg annyit mondott, hogy "Előbb
  // válaszd ki, melyik fiókból nézzük" -- pedig nem volt mit valasztani.
  it('a fioklistat kulon fuggveny tolti, nem a _depoRefresh vege', () => {
    expect(app).toContain('async function _depoLoadSyncAccounts()')
    expect(extractFn(app, '_depoLoadSyncAccounts')).toContain("_depoGet('/api/drive/accounts')")
  })

  it('a fioklista a depo-allapot ELOTT indul (nem az utan)', () => {
    const f = extractFn(app, '_depoRefresh')
    const fiok = f.indexOf('_depoLoadSyncAccounts()')
    const allapot = f.indexOf("_depoGet('/api/depot/status')")
    expect(fiok, 'nem hivja a fioklista-toltot').toBeGreaterThan(-1)
    expect(fiok, 'a fioklista megint a depo-allapot utan tolt').toBeLessThan(allapot)
  })

  it('a _depoRefresh mar NEM tolti maga a legordulot', () => {
    // Kulonben ket helyen allna ugyanaz, es a regi (rossz) helyen levo elavulna.
    const f = extractFn(app, '_depoRefresh')
    expect(f).not.toContain("_depoGet('/api/drive/accounts')")
  })

  it('ha nem sikerul a fioklista, azt KIIRJA (nem nyeli le nemAn hibat)', () => {
    const f = extractFn(app, '_depoLoadSyncAccounts')
    expect(f).toContain("t('dsync.accounts_failed'")
    expect(f).toContain("t('dsync.no_accounts')")
  })

  it('ket egyszerre futo toltes nem rajzolja ujra a legordulot', () => {
    // A _depoRefresh tobb helyrol is jon (gomb, munka-figyelo, mentes utan). Egy
    // masodik ujrarajzolas VISSZAALLITANA a kivalasztott fiokot az elsore.
    const f = extractFn(app, '_depoLoadSyncAccounts')
    expect(f).toContain('_depoAccountsLoading')
    expect(f).toMatch(/finally \{[\s\S]*_depoAccountsLoading = false/)
    expect(app).toContain('var _depoAccountsLoading')
    expect(app).not.toContain('let _depoAccountsLoading')
  })
})

describe('helyreallitas a felhobol: a kepernyo', () => {
  it('a doboz ott van, es elmondja mire valo (markupos kulcs)', () => {
    expect(html).toContain('id="depoRestoreBox"')
    expect(html).toContain('data-i18n-html="drestore.what_html"')
    expect(html).toMatch(/<label for="depoRestoreAccount"[^>]*data-i18n="drestore\.step1"/)
    expect(app).toContain("bind('depoRestoreFindBtn', () => _depoRestoreFind())")
  })

  it('a nulla ket dolgot jelent: nincs mentes-mappa vs ures', () => {
    const f = extractFn(app, '_depoRestoreFind')
    expect(f).toContain("t('drestore.root_empty'")
    expect(f).toContain("t('drestore.none'")
    expect(f).toContain('d.backupRootFound')
  })

  it('a nevbol kitalalt helyet jelzi, es a cel szerkesztheto', () => {
    const f = extractFn(app, '_depoRestoreFind')
    expect(f).toContain("t('drestore.from_name')")
    expect(f).toContain("id=\"depoRestorePath-' + i + '\"")
  })

  it('elonezet nelkul nem ir, a valodi futas elott megkerdezi', () => {
    const f = extractFn(app, '_depoRestoreStart')
    expect(f).toContain("if (!dryRun && !confirm(t('drestore.run_confirm'")
    expect(f).toContain("_depoPost('/api/drive/sync/restore'")
    expect(f).toContain('_depoStartPoll()')
  })

  it('minden uj kulcs mindket nyelven megvan', () => {
    const kulcsok = new Set<string>()
    for (const m of (app + html).matchAll(/(?:t\('|data-i18n(?:-html)?=")(drestore\.[a-z0-9_]+|dsync\.(?:retired_note|col_[a-z]+|unlink[a-z_]*))/g)) kulcsok.add(m[1])
    expect(kulcsok.size).toBeGreaterThan(20)
    for (const k of kulcsok) for (const l of nyelvek) expect(l, k).toContain(`'${k}'`)
  })
})

describe('honnan tudja, hova kell visszahozni', () => {
  it('a mappa sajat jelzese dont, ha van', () => {
    expect(backupFolderLocalPath('akarmi', { [BACKUP_PATH_PROP]: 'Család/Korpás - László' })).toEqual({ localPath: 'Család/Korpás - László', fromName: false })
  })
  it('a gyoker-mentes a gyokerbe megy vissza', () => {
    expect(backupFolderLocalPath(mentesMappaNev(''), null)).toEqual({ localPath: '', fromName: false })
  })
  it('jelzes nelkul a nevbol rakja ossze, es megjeloli', () => {
    expect(backupFolderLocalPath(mentesMappaNev('Család/Fotók'), {})).toEqual({ localPath: 'Család/Fotók', fromName: true })
  })
  it('felvetelkor a mappara felirja az utat', () => {
    expect(server).toContain('await markBackupFolder(folderId, rel, token)')
  })
})

describe('restoreWalk: csak a hianyzot hozza le, meglevot nem ir felul', () => {
  const F = 'application/vnd.google-apps.folder'
  const fa: Record<string, RestoreEntry[]> = {
    root: [
      { id: 'd1', name: 'Fotók', mimeType: F },
      { id: 'f1', name: 'meglevo.txt', size: 5, modifiedTime: '2024-01-02T03:04:05.000Z' },
      { id: 'f2', name: 'uj.txt', size: 3, modifiedTime: '2024-01-02T03:04:05.000Z' },
      { id: 'g1', name: 'Doksi', mimeType: 'application/vnd.google-apps.document' },
      { id: 'bad', name: '..', size: 1 },
    ],
    d1: [{ id: 'f3', name: 'Kép: 1 - a.jpg', size: 4, modifiedTime: '2023-05-06T07:08:09.000Z' }],
  }
  const list = async (id: string) => fa[id] || []
  const letoltott: string[] = []
  const download = async (f: RestoreEntry, dest: string) => { letoltott.push(f.id); writeFileSync(dest, 'x'.repeat(Number(f.size))); return Number(f.size) }

  function friss(): string {
    const d = mkdtempSync(join(tmpdir(), 'restore-'))
    writeFileSync(join(d, 'meglevo.txt'), 'SAJAT')
    return d
  }

  it('az elonezet semmit nem ir, csak szamol', async () => {
    const d = friss()
    try {
      letoltott.length = 0
      const r = await restoreWalk({ rootId: 'root', base: d, list, download, dryRun: true })
      expect(r.downloaded).toBe(2)
      expect(r.present).toBe(1)
      expect(letoltott).toEqual([])
      expect(existsSync(join(d, 'uj.txt'))).toBe(false)
      expect(existsSync(join(d, 'Fotók'))).toBe(false)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('a valodi futas a hianyzot hozza, a meglevohoz nem nyul, a nyers nev marad', async () => {
    const d = friss()
    try {
      letoltott.length = 0
      const r = await restoreWalk({ rootId: 'root', base: d, list, download, dryRun: false })
      expect(readFileSync(join(d, 'meglevo.txt'), 'utf8')).toBe('SAJAT')
      expect(letoltott.sort()).toEqual(['f2', 'f3'])
      expect(existsSync(join(d, 'Fotók', 'Kép: 1 - a.jpg'))).toBe(true)
      // the Drive date comes back as the file date
      expect(statSync(join(d, 'uj.txt')).mtime.toISOString()).toBe('2024-01-02T03:04:05.000Z')
      // state is written, so the next backup run does not upload it again
      expect(r.state.f2.path).toBe('uj.txt')
      expect(r.state.f3.path).toBe('Fotók/Kép: 1 - a.jpg')
      expect(r.skipped.map((x) => x.path).sort()).toEqual(['..', 'Doksi'])
      expect(r.failed).toEqual([])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('a masodik futas mar semmit nem hoz le', async () => {
    const d = friss()
    try {
      await restoreWalk({ rootId: 'root', base: d, list, download, dryRun: false })
      letoltott.length = 0
      const r = await restoreWalk({ rootId: 'root', base: d, list, download, dryRun: false })
      expect(r.downloaded).toBe(0)
      expect(letoltott).toEqual([])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('a listazasi hiba csonka eredmenyt ad, nem "kesz"-t', async () => {
    const d = friss()
    try {
      const r = await restoreWalk({ rootId: 'root', base: d, list: async () => { throw new Error('403') }, download, dryRun: true })
      expect(r.partial.length).toBe(1)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('a tiltott nevek', () => {
    for (const n of ['', '.', '..', 'a/b', 'a\u0000b']) expect(restoreNameOk(n), JSON.stringify(n)).toBe(false)
    for (const n of ['Kép: 1.jpg', 'a - b', '...x']) expect(restoreNameOk(n), n).toBe(true)
  })
})
