/**
 * GIT-SZINKRON: a fában lévő ÖSSZES repó magától friss marad.
 *
 * Boss, 2026-08-21: "es tegyel erre egy olyat hogy automatikausan
 * szinkronizalja magat mindig." + "meg az osszes git ahol van a
 * mapparendszerben. mind szinkronizaljon automatan"
 *
 * A VEZERELV: a szinkron SOHA nem semmisit meg helyi munkat.
 *
 * Ezert nem `git pull`-t futtatunk vakon, hanem harom lepesben dolgozunk:
 *   1. `fetch` -- ez mindig biztonsagos, csak letolt, semmit nem ir at,
 *   2. megnezzuk, tiszta-e a munkapeldany es van-e fel nem toltott commit,
 *   3. es CSAK akkor lepunk elore, ha a lepes `--ff-only`, vagyis a helyi
 *      allapot a tavoli ELOZMENYE. Ha nem az, kihagyjuk, es megmondjuk, miert.
 *
 * Egy piszkos vagy elorefutott repot inkabb hagyunk elavultan, mint hogy
 * barmit is elveszitsunk belole. A `fetch` viszont olyankor is lefut, tehat a
 * `repo-status` mondata ("N commit nincs feltolva") IGAZAT mond -- nem regi
 * adatbol beszel.
 */

import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join, sep } from 'node:path'
import { STORE_DIR } from './config.js'
import { explorerRoot, toLifeRel } from './life-explorer.js'
import { DEPOT_PROJECTS } from './depot.js'
import { gitEnvFor } from './git-accounts.js'
import { SCHEDULED_TASKS_DIR } from './web/scheduled-tasks-io.js'
import { logger } from './logger.js'
import { onWake } from './wake-detect.js'

/** Ide irjuk, mikor futott utoljara -- ezt mutatja a felulet. */
const STATE_FILE = join(STORE_DIR, 'git-sync.json')

/** Ezekbe sose nezunk bele: nincs bennuk repo, viszont tizezer fajl van. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '$RECYCLE.BIN', 'System Volume Information'])

/** Meddig keresunk lefele. A repok a fa aljan vannak, de nem a foldalatt. */
const MAX_DEPTH = 8

/**
 * Halozati eredetu-e a git hibauzenete?
 *
 * SZANDEKOSAN ugyanazok a mintak, mint a `system-health.ts` `hibaOka()`
 * fuggvenyeben. Ha a ketto szetcsuszik, a szinkron ``halozat``-nak konyvel valamit,
 * amit az onellenorzes ``ismeretlen ok``-kent ir ki -- ket igazsag ugyanarrol,
 * ami pont a talalgatas, amit a szabaly tilt.
 *
 * Amit NEM tekintunk halozatnak: a hitelesitesi hiba. Egy lejart kulcs nem
 * javul meg attol, hogy varunk -- azt hangosan kell mondani.
 */
export function halozatiHiba(uzenet: string): boolean {
  const sz = String(uzenet || '').toLowerCase()
  const kulcs = /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled|invalid username or (token|password)|http 40[13]/.test(sz)
  if (kulcs) return false
  return /could not resolve host|connection timed out|connection refused|network is unreachable|operation timed out|temporary failure in name resolution|failed to connect|ssl connect error/.test(sz)
}

export interface SyncResult {
  rel: string
  /** 'frissitve' | 'naprakesz' | 'kihagyva' | 'halozat nelkul' | 'hiba'
   *
   *  Az 'offline' KULON ag, nem az 'error' egyik fajtaja. Boss, 2026-08-26:
   *  ``minden rendben van de o szol hogy nincs.`` Merve ugyanaznap: a reggeli
   *  het hiba mind ez volt -- `Could not resolve host: github.com` --, mert a
   *  lehuzas ebredes utan azonnal futott, mielott a WSL-ben feljott volna a
   *  nevfeloldas. Egy oraval kesobb minden mukodott. Az ``elertem a tarolot es
   *  romlott`` es a ``most nem lattam oda`` ket kulonbozo allitas; ha egy
   *  mezobe kerulnek, a masodik minden reggel riaszt. */
  state: 'updated' | 'current' | 'skipped' | 'offline' | 'error'
  /** Emberi mondat arrol, mi tortent -- ezt olvassa a felhasznalo. */
  message: string
}

export interface SyncRun {
  startedAt: string
  finishedAt: string
  /** Masodpercben, hogy a felulet ne szamoljon. */
  durationSec: number
  results: SyncResult[]
  updated: number
  skipped: number
  /** Hany tarolot nem lehetett elerni HALOZAT hianyaban. Ez nem hiba. */
  offline: number
  /**
   * Mikor kezdodott a jelenlegi halozat-hianyos idoszak (ISO), vagy null,
   * ha az utolso menetben minden elerheto volt.
   *
   * Ez a mezo dont arrol, mikor valik a csendbol hangos szo. Egy reggeli ket
   * perc nem er egy riasztast; hat ora folyamatos halozat-hiany viszont mar
   * azt jelenti, hogy a tarolok tenylegesen elavulnak -- es akkor szolni
   * KELL. A belyeg athuzodik a futasok kozott, kulonben minden ujraprobalas
   * nullarol inditana az orat, es soha nem erne el a hat orat.
   */
  offlineSince: string | null
  errors: number
  /**
   * A depo GYOKERE nem volt bejarhato -- ilyenkor a `results` ures, de ez NEM
   * azt jelenti, hogy nincs repo. Boss, 2026-08-23: "remelem akik ujonnan
   * telepitik a marveent azoknak ez nem fog elojonni. azoknak sem."
   *
   * Pontosan ez a nemasagi csapda: ha a depo egy Windows-meghajton ul es a
   * csatolas elall (`Input/output error`), a bejaras nulla repot talal, az
   * onellenorzes pedig "nincs bekotve git"-nek latja -- es HALLGAT. Minden
   * repo elavul, es semmi nem szol. Ezert a gyoker hibajat KULON jelezzuk.
   */
  rootError?: string
}

/**
 * Melyik fiok kulcsaval dolgozunk ennel a repnal.
 *
 * A repok FIZIKAILAG a `Rendszer/Tárolók/Git/<fiok>/<repo>` alatt allnak: a
 * fiok neve maga a mappa. A FAN viszont mashol is latszanak -- egy ceg
 * `Fejlesztés/GIT_REPOS` aga ala BE VANNAK KOTVE --, es a `toLifeRel()`
 * szandekosan ezt a bekotott utat adja vissza (azt latja a felhasznalo).
 *
 * 2026-08-22: pontosan ezen bukott el a szinkron. A fiokot a bekotott utbol
 * probaltuk kiolvasni, amiben a fiok neve NEM szerepel, tehat kulcs nelkul
 * probalkozott -- a hat ceges repobol ot elhasalt azzal, hogy „could not read
 * Password". Ezert a FIZIKAI utat nezzuk, nem a bekotottet.
 */
export function accountFromRepoPath(root: string, abs: string): string {
  if (!root || !abs) return ''
  if (!abs.startsWith(root + sep)) return ''
  const rel = abs.slice(root.length + 1).split(sep).join('/')
  if (!rel.startsWith(DEPOT_PROJECTS + '/')) return ''
  return rel.slice(DEPOT_PROJECTS.length + 1).split('/')[0] || ''
}

/** Ugyanez a mostani fahoz. Kulon, hogy a fenti tisztan tesztelheto maradjon. */
function accountOfPath(abs: string): string {
  let root = explorerRoot()
  if (!root) return ''
  try { root = realpathSync(root) } catch { /* marad a beallitott */ }
  return accountFromRepoPath(root, abs)
}

/**
 * Vegso mentsvar: a fiok a TAVOLI CIMBOL.
 *
 * Egy kezzel klonozott repo barhol allhat a faban, tehat az utvonal nem mond
 * semmit. A `https://<fiok>@github.com/...` cimben viszont ott a
 * felhasznalonev -- ami NEM titok (a kulcs sosem kerul a `.git/config`-ba).
 */
async function accountFromRemote(abs: string): Promise<string> {
  const r = await git(abs, ['remote', 'get-url', 'origin'], 15000)
  const m = r.out.match(/^https:\/\/([A-Za-z0-9._-]+)@/)
  return m ? m[1] : ''
}

function git(cwd: string, args: string[], timeout = 120000, account = ''): Promise<{ ok: boolean; out: string; err: string }> {
  const env = gitEnvFor(account)
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ ok: !e, out: String(stdout || '').trim(), err: String(stderr || '').trim() })
    })
  })
}

/**
 * Minden repo a fában.
 *
 * Egy repon BELUL nem keresunk tovabb: a `.git` megtalalasa lezarja az agat.
 * Egy 800 MB-os repo belsejeben tovabb bogaraszni ertelmetlen (a submodule-t
 * ugyis a sajat repoja kezeli), es percekig tartana.
 */
export async function findRepos(): Promise<string[]> {
  const root = explorerRoot()
  if (!root) return []
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length > 200) return
    try { await fsp.access(join(dir, '.git')); found.push(dir); return } catch { /* nem repo */ }
    let names: Dirent[]
    try { names = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of names) {
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue
      const full = join(dir, d.name)
      let konyvtar = d.isDirectory()
      // A bekotott mappak lehetnek jelzofajlok is -- azokon AT kell latni,
      // kulonben a fan lathato repok fele kimaradna a lehuzasbol.
      if (!konyvtar && d.isSymbolicLink()) {
        try { konyvtar = (await fsp.stat(full)).isDirectory() } catch { continue }
      }
      if (!konyvtar) continue
      await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

/**
 * Egy repo biztonsagos frissitese.
 *
 * Ami itt SOHA nem tortenik: `reset`, `checkout --force`, `pull --rebase`,
 * `stash`. Mind a negy el tudna tuntetni olyan munkat, amirol a felhasznalo
 * azt hiszi, megvan.
 */
export async function syncRepo(abs: string): Promise<SyncResult> {
  const rel = toLifeRel(abs)
  const account = accountOfPath(abs) || await accountFromRemote(abs)

  // 1. FETCH -- mindig biztonsagos: csak letolt.
  const fetched = await git(abs, ['fetch', '--all', '--prune', '--quiet'], 300000, account)
  if (!fetched.ok) {
    const elsoSor = (fetched.err.split('\n')[0] || '').slice(0, 160)
    // A halozat hianya nem a tarolo baja: ugyanez a tarolo tiz perc mulva
    // hibatlanul lejon. Ezert nem 'error', hanem 'offline' -- es a hivo fel
    // ilyenkor UJRAPROBALJA, nem pedig riaszt.
    if (halozatiHiba(fetched.err)) {
      return { rel, state: 'offline', message: 'Most nincs hálózat a távoli tárolóhoz — újrapróbálom, amint van. ' + elsoSor }
    }
    return {
      rel, state: 'error',
      message: 'Nem sikerült elérni a távoli tárolót. ' + elsoSor,
    }
  }

  const up = await git(abs, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!up.ok || !up.out) {
    return { rel, state: 'skipped', message: 'Nincs távoli ága, amihez igazodhatna — csak helyben létezik.' }
  }

  // 2. Van-e barmi, amit elveszithetnenk?
  const st = await git(abs, ['status', '--porcelain'])
  const dirty = st.out ? st.out.split('\n').filter((l) => l.trim()).length : 0
  if (dirty) {
    return { rel, state: 'skipped', message: `${dirty} fájl módosítva van itt — nem nyúlok hozzá, amíg nincs elmentve (commit + push).` }
  }
  const ahead = await git(abs, ['rev-list', '--count', '@{upstream}..HEAD'])
  const aheadN = Number(ahead.out) || 0
  if (aheadN) {
    return { rel, state: 'skipped', message: `${aheadN} commit van itt, ami nincs feltöltve — előbb küldd fel (push), utána frissítek.` }
  }
  const behind = await git(abs, ['rev-list', '--count', 'HEAD..@{upstream}'])
  const behindN = Number(behind.out) || 0
  if (!behindN) return { rel, state: 'current', message: 'Naprakész.' }

  // 3. Csak ELORELEPES. Ha nem az, a `--ff-only` maga tagadja meg.
  const pulled = await git(abs, ['merge', '--ff-only', '@{upstream}'])
  if (!pulled.ok) {
    return { rel, state: 'skipped', message: 'A helyi és a távoli ág szétvált — ezt kézzel kell rendezni, magamtól nem írom felül.' }
  }
  return { rel, state: 'updated', message: `Frissítve: ${behindN} új commit jött le.` }
}

/** Az utolso futas allapota, vagy `null`, ha meg sose futott. */
export function lastSyncRun(): SyncRun | null {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SyncRun } catch { return null }
}

let running = false

/**
 * Minden repo egy menetben.
 *
 * Egyszerre csak egy futas lehet: ket parhuzamos `git merge` ugyanabban a
 * repoban egymas labara lepne (`index.lock`), es a masodik hibara futna --
 * amit a felhasznalo valodi bajnak latna.
 */
export async function syncAllRepos(): Promise<SyncRun> {
  const prev = lastSyncRun()
  if (running && prev) return prev
  running = true
  const started = Date.now()
  const results: SyncResult[] = []
  // A gyokeret KULON kerdezzuk meg, mielott bejarnank. A `findRepos()` egy
  // olvashatatlan konyvtarra ures listaval ter vissza -- ami pontosan ugy
  // nez ki, mint egy friss telepites, ahol meg nincs egyetlen repo sem.
  // A ketto kozott csak itt lehet kulonbseget tenni.
  let rootError = ''
  const gyoker = explorerRoot()
  if (gyoker) {
    try { await fsp.readdir(gyoker) } catch (err: any) {
      rootError = String(err?.message || err).slice(0, 160)
    }
  }
  try {
    // Bejarhatatlan gyokernel nincs mit bejarni -- es a `results` uressege
    // ilyenkor NEM azt jelenti, hogy nincs repo. Azt a `rootError` mondja meg.
    if (!rootError) for (const abs of await findRepos()) {
      try {
        results.push(await syncRepo(abs))
      } catch (err: any) {
        results.push({ rel: toLifeRel(abs), state: 'error', message: String(err?.message || err).slice(0, 160) })
      }
    }
  } finally {
    running = false
  }
  // HALOZAT-HIANY: nem hiba, de nem is felejtheto el.
  //
  // Az idoszak kezdetet az ELOZO futasbol vesszuk at. Enelkul minden
  // ujraprobalas nullarol inditana az orat, es a hat oras hangos hatart
  // soha nem ernenk el -- vagyis egy tenylegesen elszakadt halozat orokre
  // csendben maradna. Pontosan az a nemasagi csapda, amit el akarunk kerulni.
  const offlineDb = results.filter((r) => r.state === 'offline').length
  const elozo = lastSyncRun()
  const offlineSince = offlineDb > 0
    ? (elozo && elozo.offlineSince ? elozo.offlineSince : new Date(started).toISOString())
    : null

  const run: SyncRun = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000),
    results,
    updated: results.filter((r) => r.state === 'updated').length,
    skipped: results.filter((r) => r.state === 'skipped').length,
    offline: offlineDb,
    offlineSince,
    errors: results.filter((r) => r.state === 'error').length,
    ...(rootError ? { rootError } : {}),
  }
  try { writeFileSync(STATE_FILE, JSON.stringify(run, null, 2), 'utf8') } catch { /* a futas ettol meg ervenyes */ }
  logger.info({ repos: results.length, updated: run.updated, skipped: run.skipped, offline: run.offline, errors: run.errors }, '[git-sync] kesz')
  utemezzUjraprobat(run)
  return run
}

/** Hat oranként. Elegge suru ahhoz, hogy friss legyen, es nem terheli a halot. */
export const GIT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

/** A napi kartya neve az Utemezesek lapon. */
export const GIT_PULL_TASK = 'git-pull'

/**
 * Van-e mar kartyaja a lehuzasnak az Utemezesek alatt?
 *
 * Boss, 2026-08-22: „megjobb az utemezesek ala tenni egy kartyat." Ha ott van,
 * akkor AZ az utemezes -- a felhasznalo latja, atallithatja, kikapcsolhatja.
 * Egy emellett futo rejtett hat-oras idozito hazudna: a kartya „naponta
 * egyszer"-t mutatna, kozben napi negyszer futna, es a kikapcsolt kartya sem
 * allitana meg semmit.
 */
function vanNapiKartya(): boolean {
  return existsSync(join(SCHEDULED_TASKS_DIR, GIT_PULL_TASK, 'task-config.json'))
}

/**
 * Az idozites INDULASKOR nem azonnal fut: a start amugy is a legterheltebb
 * pillanat, es egy 800 MB-os repo `fetch`-e nem sietos. Ot perc mulva viszont
 * mar minden a helyen van.
 *
 * Ha van napi kartya, ez a fuggveny NEM idozit semmit -- csak megmondja a
 * naploban, ki a gazda. A regi hat-oras menet igy is megmarad azoknak a
 * telepiteseknek, amelyek a kartya elott keszultek es meg nem frissitettek.
 */
/**
 * Ujraprobalas halozat-hiany utan.
 *
 * Boss, 2026-08-26: ``ne csak most vedd le azonnal. hanem holnap reggel se
 * jojjon elo!`` Ez az a fuggveny, ami ezt megteszi: ha a menet vegen volt
 * olyan tarolo, amit HALOZAT hianyaban nem ertunk el, ot perc mulva magatol
 * ujraprobalja -- addig, amig sikerul. Reggel ez azt jelenti, hogy a DNS
 * feljovetele utani elso koron minden lejon, es a felulet magatol zoldul.
 *
 * Miert nem vegtelen ez a ciklus? Mert amint egy menet 0 offline-nal er
 * veget, nem idozit ujat. Es ha tartosan nincs halozat, a probalkozas
 * olcso (egy sikertelen DNS-feloldas), az onellenorzes pedig hat ora utan
 * ugyis hangosan szol.
 */
const OFFLINE_RETRY_MS = 5 * 60 * 1000
let offlineRetry: NodeJS.Timeout | null = null

function utemezzUjraprobat(run: SyncRun): void {
  if (offlineRetry) { clearTimeout(offlineRetry); offlineRetry = null }
  if (!run.offline) return
  offlineRetry = setTimeout(() => {
    offlineRetry = null
    syncAllRepos().catch((err) => logger.warn({ err }, '[git-sync] az ujraprobalas nem sikerult'))
  }, OFFLINE_RETRY_MS)
  if (typeof offlineRetry.unref === 'function') offlineRetry.unref()
  logger.info({ offline: run.offline, ujraPerc: OFFLINE_RETRY_MS / 60000 }, '[git-sync] halozat nelkul maradt tarolo -- ujraprobalas idozitve')
}

export function startGitSync(): NodeJS.Timeout | null {
  // EBREDES: alvas utan a halozat meg nem biztos, hogy fent van, ezert nem
  // azonnal inditunk. Egy perc boven eleg ahhoz, hogy a WSL nevfeloldasa
  // helyrealljon -- es ha megsem, az ujraproba-lanc ugyis viszi tovabb.
  onWake(() => {
    setTimeout(() => {
      syncAllRepos().catch((err) => logger.warn({ err }, '[git-sync] az ebredes utani kor nem sikerult'))
    }, 60 * 1000)
  })
  if (vanNapiKartya()) {
    logger.info({ task: GIT_PULL_TASK }, '[git-sync] az utemezett kartya viszi -- rejtett idozito nincs')
    return null
  }
  setTimeout(() => {
    syncAllRepos().catch((err) => logger.warn({ err }, '[git-sync] az elso futas nem sikerult'))
  }, 5 * 60 * 1000)
  const timer = setInterval(() => {
    syncAllRepos().catch((err) => logger.warn({ err }, '[git-sync] futas nem sikerult'))
  }, GIT_SYNC_INTERVAL_MS)
  logger.info({ everyHours: GIT_SYNC_INTERVAL_MS / 3600000 }, '[git-sync] automatikus szinkron beallitva')
  return timer
}
