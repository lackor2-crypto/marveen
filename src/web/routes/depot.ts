// A depo vegpontjai: hol allnak a fajljaid.
//
// Amit csinal, es semmi mast:
//   - GET  /api/depot/status    -- hol van a depo, el-e, mi van mar benne
//   - GET  /api/depot/browse    -- lemezek/mappak a valasztohoz (nem kell gepelni)
//   - POST /api/depot/root      -- a kivalasztott mappa lesz a depo
//   - POST /api/depot/remount   -- onjavitas: ujracsatolja a leszakadt depot
//                                  (csak ha a DEPOT_AUTO_REMOUNT be van kapcsolva)
//
// NINCS "atkoltoztetes a depoba" gomb, es nincs mit koltoztetni. Boss,
// 2026-08-27: "eleve a depoba menjen a letoltes". A Google Fotok letoltes
// azota meg sem indul depo nelkul (lasd photos-picker.ts, POST
// /api/photos/session), ezert a regi helyen SOHA nem keletkezik kep -- a
// koltoztetesnek nem maradt dolga, es a kodja is elment.
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  depotHealth, depotRoot, ensureDepotSkeleton, depotAccountDir,
  DEPOT_PHOTOS, DEPOT_DRIVE,
} from '../../depot.js'
import { loadIndex, photoFileOwner, depotPhotoDir } from './photos-picker.js'
import { browseFolders, fromDisplayPath, toDisplayPath, humanBytes, diskSpace } from '../../depot-browse.js'
import { googleAccountNames } from './accounts.js'
import { setOverride } from '../../settings-store.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { remountArgv, remountSudoersLine } from '../../depot-remount.js'
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import type { RouteContext } from './types.js'

/**
 * Mely fiokoknak vannak kepei a depoban, es mennyi?
 *
 * Ez LELTAR, nem koltoztetes: csak megmutatja, mi all a depoban. NEM eleg a
 * bekotott fiokok listaja -- egy levalasztott fiok kepei is ott allnak a
 * lemezen, es ha kihagynank oket, a felhasznalo azt hinne, nincsenek. Ezert a
 * bekotott fiokok ES az indexben szereplo tulajdonosok unioja.
 */
export function depotPhotoCounts(): Array<{ account: string; count: number; bytes: number }> {
  const names = new Set<string>(googleAccountNames().accounts)
  try { for (const p of loadIndex()) names.add(photoFileOwner(p)) } catch { /* serult index: a bekotottek maradnak */ }
  return [...names].filter((a) => a).map((account) => {
    const d = depotPhotoDir(account)
    return { account, ...(d ? countPlain(d) : { count: 0, bytes: 0 }) }
  })
}

/**
 * Hany (nem rejtett) fajl van egy mappaban?
 *
 * A ponttal kezdodo bejegyzesek kimaradnak: a `.thumbs` bolyegkepek nem kepek,
 * hanem gyorsitotar -- ha beleszamitanank, a leltar tobbet mutatna a
 * valosagnal.
 */
function countPlain(dir: string): { count: number; bytes: number } {
  const r = { count: 0, bytes: 0 }
  try {
    if (!existsSync(dir)) return r
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.')) continue
      try {
        const st = statSync(join(dir, f))
        if (!st.isFile()) continue
        r.count++
        r.bytes += st.size
      } catch { /* eppen most tunt el */ }
    }
  } catch { /* elerhetetlen mappa: 0, nem hiba */ }
  return r
}

export async function tryHandleDepot(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // ONJAVITAS. Alapbol KI, es kikapcsolva a Marveen SOHA nem futtat sudo-t.
  //
  // Miert kell egyaltalan kapcsolo: a javitashoz root kell, es egy dashboardnak
  // nem jar automatikusan root. A kapcsolo bekapcsolasa maga nem ad jogot --
  // a jelszo nelkuli engedelyt egyetlen, szuk hatokoru sorral A FELHASZNALO
  // veszi fel a /etc/sudoers.d/ ala. Amig nincs meg, ez a vegpont NEM kerdez
  // jelszot (a `sudo -n` sosem varakozik), hanem visszaadja a pontos teendot.
  //
  // A HIBA OKAT A VALODI KIMENETBOL olvassuk ki. Egy tippelt ok rosszabb a
  // semminel: rossz iranyba kuldi a felhasznalot.
  if (path === '/api/depot/remount' && method === 'POST') {
    const health = depotHealth()
    const terv = health.repair
    if (!terv) {
      json(res, {
        error: 'A raktár nem Windows-meghajtón van, itt az újracsatolás nem a megoldás.',
        code: 'not_applicable',
      }, 409)
      return true
    }
    const user = userInfo().username
    const sudoers = remountSudoersLine(terv, user)
    if (String(getEffectiveSettingValue('DEPOT_AUTO_REMOUNT')) !== '1') {
      json(res, {
        error: 'Az önjavítás ki van kapcsolva.',
        code: 'disabled',
        command: terv.command,
        sudoers,
      }, 409)
      return true
    }

    // A ket lepes KULON fut. Az `umount` bukasa nem hiba: ha nincs mit
    // lecsatolni, eppen az a kiindulasi allapot -- csak a `mount` szamit.
    const futtat = (argv: string[]): Promise<{ code: number; out: string }> =>
      new Promise((resolve) => {
        execFile('sudo', ['-n', ...argv], { timeout: 20_000 }, (err, stdout, stderr) => {
          const out = String(stderr || '') + String(stdout || '')
          const kod = err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err ? 1 : 0
          resolve({ code: kod, out: out.trim() })
        })
      })

    const [le, fel] = remountArgv(terv)
    const r1 = await futtat(le!)
    const r2 = await futtat(fel!)

    // A bizonyitek nem a kilepesi kod, hanem hogy a depo MOST irhato-e.
    // "Sikeresen lefutott" onmagaban nem bizonyitek semmire.
    const utana = depotHealth()
    if (utana.writable) {
      logger.info({ mountpoint: terv.mountpoint }, 'depot remount succeeded')
      json(res, { ok: true, writable: true, output: [r1.out, r2.out].filter(Boolean).join('\n') })
      return true
    }

    const kimenet = [r1.out, r2.out].filter(Boolean).join('\n')
    // A `sudo -n` pontosan ezt irja ki, ha nincs jelszo nelkuli engedely.
    // Ezt FELISMERJUK -- de csak ezt az egyet; barmi mast szo szerint adunk
    // tovabb, sajat magyarazat nelkul.
    const jogHianyzik = /password is required|a jelszó szükséges|not allowed to execute/i.test(kimenet)
    logger.warn({ mountpoint: terv.mountpoint, kimenet }, 'depot remount failed')
    json(res, {
      error: utana.message,
      code: jogHianyzik ? 'needs_sudoers' : 'failed',
      output: kimenet,
      command: terv.command,
      sudoers,
      sudoersFile: '/etc/sudoers.d/marveen-depot',
    }, 409)
    return true
  }

  if (path === '/api/depot/status' && method === 'GET') {
    // A vazszerkezet ITT keszul el.
    //
    // Kulonben a depo sosem tudna elindulni: minden ir-o ag megtagadja magat,
    // ha a depo nem irhato -- es nem irhato, mert meg nem letezik. Egy frissen
    // beallitott depo igy orokre "nem erheto el" maradt volna. Ez egyben az,
    // amit a Boss kert: a Marveen maga hozza letre a sajat mappajat.
    // Elerhetetlen lemeznel nem csinal semmit (lasd ensureDepotSkeleton).
    const health = ensureDepotSkeleton().health
    const root = depotRoot()
    let folders: string[] = []
    if (root && health.exists) {
      try { folders = readdirSync(root).filter((f) => !f.startsWith('.')) } catch { folders = [] }
    }
    json(res, {
      ...health,
      // Emberi alak a feluletnek: `/mnt/d/Marveen` helyett `D:\Marveen`.
      rootDisplay: root ? toDisplayPath(root) : null,
      // Fajta felul, fiok alatta: `<depo>/fotok/lackor2`, `<depo>/drive/lackor2`.
      photosDir: root ? join(root, DEPOT_PHOTOS) : null,
      driveDir: root ? join(root, DEPOT_DRIVE) : null,
      folders,
      // Leltar: mennyi kep all a depoban fiokonkent. Csak megmutatja.
      photos: depotPhotoCounts(),
      // Az onjavitas allasa. A felulet KULON kezeli a "ki van kapcsolva" es a
      // "be van kapcsolva, de meg nincs joga" allapotot: a ketto mas teendo.
      autoRemount: String(getEffectiveSettingValue('DEPOT_AUTO_REMOUNT')) === '1',
      sudoers: health.repair ? remountSudoersLine(health.repair, userInfo().username) : null,
      sudoersFile: '/etc/sudoers.d/marveen-depot',
    })
    return true
  }

  // A valaszto: lemezek es mappak. `path` nelkul a lemezlista jon.
  // Csak MAPPAKAT ad vissza, es semmit nem modosit -- ettol nem valik
  // altalanos fajlbongeszove.
  if (path === '/api/depot/browse' && method === 'GET') {
    const wanted = ctx.url.searchParams.get('path')
    const r = browseFolders(wanted)
    json(res, {
      ...r,
      drives: r.drives.map((d) => ({ ...d, freeHuman: humanBytes(d.freeBytes), totalHuman: humanBytes(d.totalBytes) })),
      current: depotRoot(),
      currentDisplay: depotRoot() ? toDisplayPath(depotRoot()!) : null,
    })
    return true
  }

  // A kivalasztott mappa lesz a depo.
  //
  // Ket alakot fogadunk el: `{ parent, name }` (a valaszto igy kuldi: "ebbe a
  // mappaba, ilyen nevu almappat"), vagy `{ path }` (ha valaki maga irja be).
  // Windows-alak (`D:\Marveen`) es linuxos alak is jo -- a felhasznalonak nem
  // kell tudnia, melyik a "helyes".
  if (path === '/api/depot/root' && method === 'POST') {
    let body: any = {}
    try { body = JSON.parse((await readBody(req)).toString() || '{}') } catch { body = {} }

    let target = ''
    if (typeof body.parent === 'string' && body.parent.trim()) {
      const parent = fromDisplayPath(body.parent)
      const name = String(body.name ?? '').trim()
      // A mappaneve NEM utvonal: aki `..`-ot vagy per-jelet ir be, az nem uj
      // mappat keszit, hanem mashova mutat -- ezt kimondjuk, nem javitgatjuk.
      if (!name) { json(res, { error: 'Add meg a mappa nevét.', code: 'no_name' }, 400); return true }
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        json(res, { error: 'A mappa neve nem tartalmazhat per-jelet. Csak a nevét írd be, pl. Marveen.', code: 'bad_name' }, 400)
        return true
      }
      target = join(parent, name)
    } else if (typeof body.path === 'string' && body.path.trim()) {
      target = fromDisplayPath(body.path)
    } else {
      json(res, { error: 'Nem érkezett mappa.', code: 'no_path' }, 400)
      return true
    }

    // A SZULOmappanak mar ott kell lennie. Ha nincs, akkor vagy elgepeles
    // tortent, vagy a lemez nincs csatolva -- egyik esetben sem szabad
    // vaktaban mappakat gyartani (egy lecsatolt D: eseten a `/mnt/d/...`
    // letrehozasa a linux gyokerre irna a kepeket, nem a lemezre).
    const parentDir = join(target, '..')
    let parentOk = false
    try { parentOk = existsSync(parentDir) && statSync(parentDir).isDirectory() } catch { parentOk = false }
    if (!parentOk) {
      json(res, {
        error: `Ez a hely nem érhető el: ${toDisplayPath(parentDir)}. Ha külső lemezről van szó, csatlakoztasd, és próbáld újra.`,
        code: 'parent_missing',
      }, 400)
      return true
    }

    // Nem elhisszuk, hogy irhato: MEGPROBALJUK. Egy olvashato, de nem irhato
    // hely (jogosultsag, tele lemez, csak-olvashato csatolas) itt derul ki, es
    // nem majd akkor, amikor 8 GB kepet akarunk atmozgatni.
    try {
      mkdirSync(target, { recursive: true })
      const probe = join(target, '.marveen-iras-proba')
      writeFileSync(probe, 'x')
      rmSync(probe, { force: true })
    } catch (err: any) {
      json(res, {
        error: `Ide nem tudok írni: ${toDisplayPath(target)} (${String(err?.code || err?.message || err)}). Válassz másik helyet.`,
        code: 'not_writable',
      }, 400)
      return true
    }

    // Figyelmeztetes, nem tiltas: egy mar hasznalt mappa is lehet szandekos.
    let existingEntries = 0
    try { existingEntries = readdirSync(target).filter((f) => !f.startsWith('.')).length } catch { existingEntries = 0 }

    const saved = setOverride('MARVEEN_DEPOT', target)
    if (!saved.ok) { json(res, { error: saved.error, code: 'save_failed' }, 400); return true }

    const space = diskSpace(target)
    logger.info({ target }, '[depo] uj depo-hely mentve')
    json(res, {
      ok: true,
      path: target,
      display: toDisplayPath(target),
      freeHuman: humanBytes(space.freeBytes),
      existingEntries,
      // A futo folyamat mar beolvasta a regi erteket -- ezert kell ujraindulnia.
      requiresRestart: true,
    })
    return true
  }

  return false
}
