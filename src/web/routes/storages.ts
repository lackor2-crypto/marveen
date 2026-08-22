// Tarolokezelo vegpontok -- a specifikacio 33. pontja.
//
//   GET  /api/storages            -- a teljes lista (drive, fotok, git)
//   POST /api/storages/rename     -- megjelenitett nev
//   POST /api/storages/active     -- ki/be kapcsolas (a fajlokhoz NEM nyul)
//   POST /api/storages/git-account-- uj git-fiok + a mappaja
//   POST /api/storages/check      -- ellenorzes: ott van-e, mi van benne
//   POST /api/storages/git-token  -- hozzaferesi kulcs egy git-fiokhoz
//   POST /api/storages/git-pull   -- a fiok repoinak lehuzasa
//   GET  /api/storages/git-sync   -- mikor futott az automatikus szinkron
//   POST /api/storages/git-sync   -- szinkron MOST
//
// A 33. pont "megnyitas" es "szinkronallapot" tetelet a mar meglevo felulet
// adja: a mappa megnyitasa az Intezo dolga (a sor `rel`-jere ugrunk), a
// szinkronallapot pedig a Depo oldal Drive-kartyaja. Ide nem masoljuk at,
// mert ket helyen ketfele igazsag lenne belole (27. pont szelleme).
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { depotRoot } from '../../depot.js'
import {
  listStorages, ensureStorageFolders, readStorageRegistry, writeStorageRegistry, addGitAccount,
  renameStorage, setStorageActive, storageKindRoot, STORAGE_KINDS,
  type StorageKind,
} from '../../storages.js'
import { googleAccountNames } from './accounts.js'
import { setGitToken, removeGitToken, gitTokenInfo, pullGitAccount, listRemoteRepos, deleteGitAccount } from '../../git-accounts.js'
import { syncAllRepos, lastSyncRun } from '../../git-sync.js'
import type { RouteContext } from './types.js'

async function readJson(req: RouteContext['req']): Promise<any> {
  try {
    const text = (await readBody(req)).toString('utf-8').trim()
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * A fiokok harom forrasa.
 *
 * A Drive es a Fotok UGYANABBOL a Google-tokentarbol jon: egy bekotott fiok
 * mindkettot tudja. Ezert nincs kulon "fotos fiok" fogalom -- ha valakinek
 * nincs Fotok-engedelye, az a sor `present:false`-kent latszik, nem tunik el.
 */
function accountSources(): { drive: string[]; photos: string[] } {
  const g = googleAccountNames()
  return { drive: g.accounts, photos: g.accounts }
}

/** A lista + a kiosztott azonositok lemezre irasa, ha uj sor keletkezett. */
function currentRows() {
  const src = accountSources()
  const r = listStorages({ driveAccounts: src.drive, photosAccounts: src.photos })
  // A kiosztas CSAK akkor kerul lemezre, ha tenyleg uj szam szuletett. Igy egy
  // sima oldalbetoltes nem ir a lemezre feleslegesen.
  if (r.changed) {
    try {
      writeStorageRegistry(r.registry)
    } catch (e) {
      // Nem allitjuk meg a listazast: a felhasznalo lassa a tarolokat. Az
      // azonositok viszont a kovetkezo betoltesnel ujra kiosztodnanak --
      // ezert ez naplot erdemel, nem csendet.
      logger.warn({ err: String(e) }, '[storages] a regiszter mentese nem sikerult')
    }
  }
  // A git-sornal a "be van kotve" NEM az, hogy felvettuk a nevet -- hanem hogy
  // van-e mogotte elo hozzaferesi kulcs. A nevfelvetel maga meg nem hoz le
  // semmit, es ha itt zoldet mutatnank, a felhasznalo azt hinne, kesz van.
  // A hianyzo fiok-mappak POTLASA. Itt es nem a szinkronban: a felhasznalo a
  // fat nezi, es ott a hely azelott kell lassek, hogy barmi lejonne ra.
  try {
    const ujak = ensureStorageFolders(r.rows)
    if (ujak.length) {
      logger.info({ ujak }, '[storages] hianyzo fiok-mappak potolva')
      for (const row of r.rows) if (ujak.includes(row.rel)) row.present = true
    }
  } catch (e) {
    logger.warn({ err: String(e) }, '[storages] a fiok-mappak potlasa nem sikerult')
  }
  return r.rows.map((row) => {
    if (row.kind !== 'git') return row
    const t = gitTokenInfo(row.account)
    return { ...row, connected: t.has, tokenSource: t.source, tokenLogin: t.login }
  })
}

function parseKind(v: unknown): StorageKind | null {
  return STORAGE_KINDS.includes(v as StorageKind) ? (v as StorageKind) : null
}

export async function tryHandleStorages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (!path.startsWith('/api/storages')) return false

  if (path === '/api/storages' && method === 'GET') {
    const root = depotRoot()
    json(res, {
      root,
      // Depo nelkul is valaszolunk, csak ures listaval + magyarazattal: a
      // felulet igy a "menj a Depo oldalra" uzenetet tudja kiirni ahelyett,
      // hogy egy ures tablazat mellett hallgatna.
      message: root ? null : 'Még nincs beállítva depó — a Depó oldalon válaszd ki, hova kerüljenek a fájlok.',
      rows: currentRows(),
    })
    return true
  }

  if (path === '/api/storages/rename' && method === 'POST') {
    const b = await readJson(req)
    const kind = parseKind(b?.kind)
    const account = String(b?.account || '').trim()
    if (!kind || !account) { json(res, { error: 'Hiányzik a tároló azonosítója.' }, 400); return true }
    const reg = renameStorage(readStorageRegistry(), kind, account, String(b?.name || ''))
    writeStorageRegistry(reg)
    json(res, { ok: true, rows: currentRows() })
    return true
  }

  if (path === '/api/storages/active' && method === 'POST') {
    const b = await readJson(req)
    const kind = parseKind(b?.kind)
    const account = String(b?.account || '').trim()
    if (!kind || !account) { json(res, { error: 'Hiányzik a tároló azonosítója.' }, 400); return true }
    const reg = setStorageActive(readStorageRegistry(), kind, account, b?.active !== false)
    writeStorageRegistry(reg)
    json(res, {
      ok: true,
      // A kikapcsolas nem torol: ezt ki is MONDJUK, kulonben a felhasznalo
      // nem meri megnyomni (vagy epp azt hiszi, takaritott vele).
      message: b?.active === false
        ? 'Kikapcsolva. A fájlok a helyükön maradnak, csak szinkron nem fut rá többé.'
        : 'Bekapcsolva.',
      rows: currentRows(),
    })
    return true
  }

  if (path === '/api/storages/git-account' && method === 'POST') {
    const b = await readJson(req)
    const r = addGitAccount(readStorageRegistry(), String(b?.account || ''))
    if (r.error) { json(res, { error: r.error }, 400); return true }
    writeStorageRegistry(r.reg)
    // A mappat AZONNAL letrehozzuk: a 7. alapszabaly szerint a repok a fiok
    // sajat mappajaba klonozodnak, es egy nem letezo celba a `git clone` sem
    // menne. Ha nincs depo, csak a bejegyzes szuletik meg -- a mappa akkor
    // jon letre, amikor a depo beall.
    const root = depotRoot()
    const account = String(b?.account || '').trim()
    let created: string | null = null
    if (root) {
      const abs = join(root, storageKindRoot('git'), account)
      try {
        if (!existsSync(abs)) { mkdirSync(abs, { recursive: true }); created = abs }
      } catch (e) {
        logger.warn({ err: String(e), abs }, '[storages] a git-fiok mappaja nem jott letre')
        json(res, { error: 'A fiók felkerült, de a mappáját nem sikerült létrehozni. Nézd meg, írható-e a depó.' }, 500)
        return true
      }
    }
    json(res, { ok: true, created, rows: currentRows() })
    return true
  }

  // A FIOKNEV ONMAGABAN FELKESZ MUNKA (Boss). Ezert a felvett git-fiokhoz itt
  // adhato meg a hozzaferesi kulcs, es innen huzhatok le a repoi -- vegig a
  // feluletrol, terminal nelkul.
  //
  // A kulcs SOSE megy vissza a bongeszonek: csak az, hogy van-e, es melyik
  // GitHub-felhasznalohoz tartozik.
  if (path === '/api/storages/git-token' && method === 'POST') {
    const b = await readJson(req)
    const account = String(b?.account || '').trim()
    if (!account) { json(res, { error: 'Hiányzik a fiók neve.' }, 400); return true }
    if (b?.remove === true) {
      removeGitToken(account)
      json(res, { ok: true, message: 'A kulcs törölve. A már lehúzott repók a helyükön maradnak, csak frissülni nem fognak.', rows: currentRows() })
      return true
    }
    const r = await setGitToken(account, String(b?.token || ''))
    json(res, { ...r, rows: currentRows() }, r.ok ? 200 : 400)
    return true
  }

  if (path === '/api/storages/git-token' && method === 'GET') {
    const account = String(ctx.url.searchParams.get('account') || '').trim()
    json(res, gitTokenInfo(account))
    return true
  }

  if (path === '/api/storages/git-repos' && method === 'POST') {
    const b = await readJson(req)
    const repos = await listRemoteRepos(String(b?.account || '').trim())
    json(res, { ok: true, repos: repos.map((r) => ({ name: r.name, private: r.private, archived: r.archived })) })
    return true
  }

  if (path === '/api/storages/git-pull' && method === 'POST') {
    const b = await readJson(req)
    const r = await pullGitAccount(String(b?.account || '').trim())
    json(res, { ...r, rows: currentRows() }, r.ok ? 200 : 400)
    return true
  }

  if (path === '/api/storages/git-sync' && method === 'GET') {
    json(res, { ok: true, last: lastSyncRun() })
    return true
  }

  if (path === '/api/storages/git-sync' && method === 'POST') {
    const run = await syncAllRepos()
    json(res, { ok: true, last: run, message: `${run.results.length} repót néztem át: ${run.updated} frissült, ${run.skipped} kimaradt, ${run.errors} hibázott.` })
    return true
  }

  // A fiok LEVETELE. Csak git: a Google-fiok a Fiokok oldalrol jon, azt nem
  // innen kell kikotni -- kulonben ket helyen lehetne ugyanazt elrontani.
  if (path === '/api/storages/git-delete' && method === 'POST') {
    const b = await readJson(req)
    const r = await deleteGitAccount(String(b?.account || '').trim(), { force: b?.force === true })
    json(res, { ...r, rows: currentRows() }, r.ok || r.needsConfirm ? 200 : 400)
    return true
  }

  if (path === '/api/storages/check' && method === 'POST') {
    const b = await readJson(req)
    const kind = parseKind(b?.kind)
    const account = String(b?.account || '').trim()
    const row = currentRows().find((r) => r.kind === kind && r.account === account)
    if (!row) { json(res, { error: 'Nincs ilyen tároló.' }, 404); return true }
    // EMBERI mondat, nem allapotkod: ez a sor arra valaszol, hogy "mukodik-e".
    const parts: string[] = []
    parts.push(row.present
      ? `A mappa megvan (${row.items} tétel közvetlenül benne).`
      : 'A mappa még nem jött létre — akkor születik meg, amikor először tölt le ide valamit.')
    if (!row.connected) {
      parts.push(kind === 'git'
        ? 'Ehhez a mappához nincs felvett fiók, ezért a Marveen nem kezeli.'
        : 'Ehhez a fiókhoz nincs élő Google-bejelentkezés — a Fiókok oldalon csatlakoztasd újra.')
    }
    if (!row.active) parts.push('A tároló ki van kapcsolva, szinkron nem fut rá.')
    json(res, { ok: true, row, message: parts.join(' ') })
    return true
  }

  return false
}
