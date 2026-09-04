/**
 * GIT-FIOKOK: hitelesites es lehuzas -- vegig a FELULETROL.
 *
 * Boss, 2026-08-21: "git fiokot hozzaadtam a depo alatt. de mit kell tenni
 * utana? hogy le is legyen huzva meg a token vagy az auth erted. azal nincs
 * vege hogy egy nevet hozzaadok!!! az felkesz munka!" -- es: "ne te csinald
 * meg. manualisan is tudjam en mindent megcsinalni. tehat a beallitasokat".
 *
 * Ezert itt SEMMI nincs, ami terminalt kivanna: a felhasznalo beir egy
 * hozzaferesi kulcsot (PAT), a Marveen ellenorzi, megmondja, hany repot lat,
 * es egy gombra lehuzza oket a fiok sajat mappajaba.
 *
 * HOL LAKIK A TOKEN. Nem a fában (21./23. pont: jelszo es token SOHA nem kerul
 * az eletfaba) es nem is a `storages.json`-ben, amit a felulet listaz. Kulon
 * fajlban all, `0600` jogokkal, es a szerver SOHA nem adja vissza -- csak azt,
 * hogy VAN-e. Amit egyszer megmutatnank a bongeszonek, az onnantol
 * megjelenne a naplokban, a keperynyokepeken es a bongeszo-elozmenyekben is.
 *
 * A TOKEN NEM KERUL A `.git/config`-ba SEM. A tavoli cim
 * `https://<fiok>@github.com/...` marad -- felhasznalonev, nem titok --, a
 * kulcsot pedig futasidoben egy `GIT_ASKPASS` segedprogram adja at. Igy egy
 * depo-mentes vagy egy megosztott mappa nem viszi magaval a kulcsot.
 */

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { depotRoot } from './depot.js'
import { repoStatus } from './git-guard.js'
import { toLifeRel } from './life-explorer.js'
import { readStorageRegistry, writeStorageRegistry, removeGitAccount, storageKindRoot } from './storages.js'
import { logger } from './logger.js'

/** Csak a szerver olvassa. `0600`, es sose megy vissza a bongeszonek. */
function tokenFile(): string {
  return join(PROJECT_ROOT, 'store', '.git-tokens.json')
}

/** Az az apro program, ami a kulcsot atadja a gitnek -- argumentum nelkul. */
function askpassFile(): string {
  return join(PROJECT_ROOT, 'store', 'git-askpass.sh')
}

interface TokenRow {
  /** Ures, ha a kulcs mase: olyankor `borrowedFrom` mondja meg, kie. */
  token: string
  /**
   * Egy MASIK gh-bejelentkezes neve, aminek a kulcsaval ehhez a fiokhoz
   * hozzaferunk. A kulcs maga NEM kerul ide -- futasidoben keressuk elo.
   */
  borrowedFrom?: string
  /** Amit a GitHub visszaadott a kulcshoz -- igy latszik, ha elgepelte a fiokot. */
  login: string
  addedAt: string
}

type TokenStore = Record<string, TokenRow>

function readTokens(): TokenStore {
  try { return JSON.parse(readFileSync(tokenFile(), 'utf8')) as TokenStore } catch { return {} }
}

function writeTokens(store: TokenStore): void {
  const f = tokenFile()
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  writeFileSync(f, JSON.stringify(store, null, 2), 'utf8')
  // A jogok BEALLITASA a lenyeg, nem a fajl letezese: egy vilag altal olvashato
  // tokenfajl ugyanolyan rossz, mintha sehol nem lenne.
  try { chmodSync(f, 0o600) } catch { /* Windows-os fajlrendszeren nincs ertelme */ }
}

/**
 * A GEPEN MAR MEGLEVO gh-bejelentkezesek.
 *
 * A `gh` a sajat fajljaban tartja a kulcsokat. Ha ott mar all egy ervenyes
 * bejelentkezes, azt HASZNALJUK -- nem masoljuk at, nem irjuk sehova:
 * futasidoben olvassuk, es ugyanugy csak az askpass lathatja.
 *
 * A hozzarendeles: pontos nevegyezes, vagy `<fiok>-` kezdetu gh-felhasznalo
 * (igy a "lackor2" a "lackor2-crypto"-t, az "usalackor" az "usalackor-blip"-et
 * talalja meg). Szandekosan ennyi es nem tobb: egy talalgatosabb parositas
 * eloszor-utoljara IDEGEN fiok kulcsat adna oda egy fiokhoz.
 */
function ghCliTokens(): Array<{ login: string; token: string }> {
  try {
    const y = readFileSync(join(homedir(), '.config', 'gh', 'hosts.yml'), 'utf8')
    const users = y.split(/^\s*users:\s*$/m)[1]
    if (!users) return []
    const out: Array<{ login: string; token: string }> = []
    const re = /^\s{6,}([A-Za-z0-9_.-]+):\s*$\n\s+oauth_token:\s*(\S+)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(users))) out.push({ login: m[1], token: m[2] })
    return out
  } catch { return [] }
}

/** Egy gh-bejelentkezes kulcsa NEV szerint. */
function ghTokenByLogin(login: string): string {
  const l = String(login || '').toLowerCase()
  return ghCliTokens().find((r) => r.login.toLowerCase() === l)?.token || ''
}

/** Melyik gh-bejelentkezes tartozik ehhez a fiokhoz -- ha van ilyen. */
export function ghTokenFor(account: string): { login: string; token: string } | null {
  const a = String(account || '').trim().toLowerCase()
  if (!a) return null
  const all = ghCliTokens()
  return all.find((r) => r.login.toLowerCase() === a)
    || all.find((r) => r.login.toLowerCase().startsWith(a + '-'))
    || null
}

/**
 * A fiokhoz TENYLEGESEN hasznalhato kulcs.
 *
 * Sorrend: amit a felhasznalo maga adott meg, aztan a gh-e. A sajat kulcs
 * eloz, mert az a kesobbi, tudatos dontes -- ha valaki beir egy PAT-ot, azt
 * akarja hasznalni, nem a regi gh-bejelentkezest.
 */
function resolveToken(account: string): { token: string; login: string; source: 'sajat' | 'gh' | 'kolcson' } | null {
  const own = readTokens()[account]
  if (own?.token) return { token: own.token, login: own.login || '', source: 'sajat' }
  const gh = ghTokenFor(account)
  if (gh) return { token: gh.token, login: gh.login, source: 'gh' }
  // Kolcsonkulcs: egy masik fiok jogosultsaga. A kulcsot MOST keressuk elo --
  // ha ott kijelentkeztek, itt is elfogy, es ezt latni is fogjuk.
  const from = own?.borrowedFrom
  if (from) {
    const t = ghTokenByLogin(from)
    if (t) return { token: t, login: from, source: 'kolcson' }
  }
  return null
}

/** Van-e mar kulcs ehhez a fiokhoz. Maga a kulcs SOSE hagyja el a szervert. */
export function hasGitToken(account: string): boolean {
  return Boolean(resolveToken(account))
}

/**
 * Melyik REGISZTRALT fiokhoz van HASZNALHATO kulcs. Csak nevek.
 *
 * Boss, 2026-09-02: a Fiokok oldal ures GitHub-listat mutatott a lackor2 es
 * usalackor fiokra, pedig mindketto regisztralva van a Raktar oldalon
 * (storages.json gitAccounts), es mindketto mukodik is git-muveletekhez --
 * csak gh-CLI-bol kolcsonzott kulccsal, nem sajat PAT-tal. Ez a fuggveny
 * eddig CSAK a sajat token-tarolo (readTokens) kulcsait nezte, tehat egy
 * gh-CLI-bol felismert fiokot soha nem mutatott -- pedig a hasGitToken()
 * (amit a tenyleges git-muveletek hasznalnak) MAR figyelembe vette a
 * gh-forrast is. A ket fuggveny szetvalt, es a felulet a szukebbet hasznalta.
 */
export function gitAccountsWithToken(): string[] {
  return readStorageRegistry().gitAccounts.filter((a) => hasGitToken(a))
}

export function gitTokenInfo(account: string): { has: boolean; login: string; addedAt: string; source: '' | 'sajat' | 'gh' | 'kolcson' } {
  const r = resolveToken(account)
  if (!r) return { has: false, login: '', addedAt: '', source: '' }
  // A gh-bol atvett vagy kolcsonzott kulcsnal nincs "hozzaadva" datum --
  // nem mi adtuk hozza.
  const addedAt = r.source === 'sajat' ? (readTokens()[account]?.addedAt || '') : ''
  return { has: true, login: r.login, addedAt, source: r.source }
}

/** A kulcs torlese. A mar lehuzott repok a helyukon maradnak. */
export function removeGitToken(account: string): void {
  const store = readTokens()
  delete store[account]
  writeTokens(store)
}

function githubApi(token: string, path: string): Promise<{ ok: boolean; status: number; body: any }> {
  return fetch('https://api.github.com' + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Marveen',
    },
  }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }))
    .catch(() => ({ ok: false, status: 0, body: null }))
}

/**
 * Egy hitelesitett GitHub API keres EGY regisztralt fiok neveben.
 *
 * A KULCS SOSE HAGYJA EL A SZERVERT: itt oldjuk fel belul (`resolveToken`), es
 * csak a kesz `Response` megy vissza a hivonak -- magat a tokent nem adjuk ki.
 * Ez a github-bongeszo (`src/github-browse.ts`) EGYETLEN utja a GitHubhoz, igy
 * a `resolveToken` privat maradhat, es egy route SOHA nem lat nyers kulcsot.
 *
 * A `path` lehet abszolut URL (pl. egy lapozo `Link`-fejlecbol) vagy
 * `/`-kezdetu API-ut; az utobbi ele a `https://api.github.com` kerul. A hivo
 * `init`-je felulir minden alapertelmezett fejlecet a sajatjaval.
 */
export async function githubRequest(account: string, path: string, init: RequestInit = {}): Promise<Response> {
  const tok = resolveToken(account)?.token
  if (!tok) throw new Error(`Ehhez a fiókhoz („${account}") nincs használható GitHub-kulcs.`)
  const url = /^https?:\/\//i.test(path) ? path : 'https://api.github.com' + path
  return fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + tok,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Marveen',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  })
}

export interface TokenCheck {
  ok: boolean
  message: string
  login?: string
  repos?: number
}

/**
 * A kulcs ellenorzese ES eltarolasa.
 *
 * Eloszor MEGKERDEZZUK a GitHubot, es csak akkor mentunk, ha valoban mukodik.
 * Egy elgepelt kulcs csendes eltarolasa a legrosszabb: minden zoldnek latszana,
 * es csak hetek mulva, az elso lehuzasnal derulne ki, hogy semmi nem jott le.
 */
export async function setGitToken(account: string, token: string): Promise<TokenCheck> {
  const acc = String(account || '').trim()
  const tok = String(token || '').trim()
  if (!acc) return { ok: false, message: 'Hiányzik a fiók neve.' }
  if (!tok) return { ok: false, message: 'Írd be a hozzáférési kulcsot (GitHub → Settings → Developer settings → Personal access tokens).' }

  const me = await githubApi(tok, '/user')
  if (me.status === 401) return { ok: false, message: 'A GitHub nem fogadta el ezt a kulcsot. Lehet, hogy lejárt, vagy elgépelted.' }
  if (me.status === 0) return { ok: false, message: 'Nem értem el a GitHubot. Nézd meg az internetkapcsolatot, aztán próbáld újra.' }
  if (!me.ok) return { ok: false, message: `A GitHub ezt válaszolta: ${me.status}. A kulcsot nem mentettem el.` }

  const login = String(me.body?.login || '')
  const repos = await listRemoteRepos(acc, tok)

  const store = readTokens()
  store[acc] = { token: tok, login, addedAt: new Date().toISOString() }
  writeTokens(store)
  ensureAskpass()
  logger.info({ account: acc, login, repos: repos.length }, '[git-fiok] kulcs elmentve')

  // Ha a kulcs mas fiokhoz tartozik, azt KIMONDJUK -- de nem tagadjuk meg:
  // egy szervezeti fiokhoz jogos, hogy a szemelyes kulccsal ferunk hozza.
  const note = login && login.toLowerCase() !== acc.toLowerCase()
    ? ` (a kulcs a(z) „${login}” felhasználóé — szervezeti fióknál ez rendben van)`
    : ''
  return {
    ok: true, login, repos: repos.length,
    message: repos.length
      ? `Rendben${note}. ${repos.length} repót látok ezzel a kulccsal — a „Repók lehúzása” gombbal jöhetnek le.`
      : `A kulcs működik${note}, de ehhez a fiókhoz egyetlen repót sem látok. Ellenőrizd, jó-e a fióknév, és van-e a kulcsnak „repo” jogosultsága.`,
  }
}

export interface RemoteRepo {
  name: string
  cloneUrl: string
  private: boolean
  archived: boolean
  updatedAt: string
}

/**
 * Egy fiok repoi.
 *
 * Harom helyen keresunk, mert a "fiok" harom dolgot jelenthet: sajat
 * felhasznalo, szervezet, vagy egy masik felhasznalo, akinek a repoit latjuk.
 * Az elso, amelyik valaszol, dont.
 */
function mapRepos(body: any[]): RemoteRepo[] {
  return body
    .map((x: any) => ({
      name: String(x?.name || ''),
      cloneUrl: String(x?.clone_url || ''),
      private: Boolean(x?.private),
      archived: Boolean(x?.archived),
      updatedAt: String(x?.updated_at || ''),
    }))
    .filter((x: RemoteRepo) => x.name && x.cloneUrl)
}

export async function listRemoteRepos(account: string, token?: string): Promise<RemoteRepo[]> {
  const tok = token || resolveToken(account)?.token
  if (!tok) return []
  const me = await githubApi(tok, '/user')
  const login = String(me.body?.login || '')

  // A `lackor2-crypto` kulcs a `lackor2` fiokhoz SAJAT kulcs: ilyenkor a
  // `/user/repos` utat kell jarni, kulonben csak a NYILVANOS repok jonnenek le.
  const a = String(account).toLowerCase()
  const sajat = login.toLowerCase() === a || login.toLowerCase().startsWith(a + '-')
  const paths = sajat
    ? ['/user/repos?per_page=100&affiliation=owner&sort=updated']
    : [`/orgs/${account}/repos?per_page=100&sort=updated`, `/users/${account}/repos?per_page=100&sort=updated`]

  // Ha a fiok NEM a kulcs gazdaja, a `/orgs` es `/users` utak csak a
  // NYILVANOS repokat adjak vissza. A privatokhoz azt kell megkerdezni, mihez
  // van a kulcsnak koze -- es abbol kiszurni, aminek EZ a fiok a gazdaja.
  if (!sajat) {
    const r = await githubApi(tok, '/user/repos?per_page=100&affiliation=collaborator,organization_member&sort=updated')
    if (r.ok && Array.isArray(r.body)) {
      const rows = mapRepos(r.body.filter((x: any) => String(x?.owner?.login || '').toLowerCase() === a))
      if (rows.length) return rows
    }
  }

  for (const p of paths) {
    const r = await githubApi(tok, p)
    if (r.ok && Array.isArray(r.body)) {
      const rows = mapRepos(r.body)
      if (rows.length) return rows
    }
  }
  return []
}

/**
 * A `GIT_ASKPASS` segedprogram: a kulcsot a KORNYEZETBOL veszi.
 *
 * Miert nem parancssori argumentum: az `argv` minden felhasznalo szamara
 * lathato (`ps`), tehat egy argumentumkent atadott kulcs gyakorlatilag
 * nyilvanos. A kornyezeti valtozo a gyerekfolyamate marad.
 */
function ensureAskpass(): string {
  const f = askpassFile()
  const body = '#!/bin/sh\n# A Marveen adja at a git-kulcsot -- lasd src/git-accounts.ts\nprintf %s "$MARVEEN_GIT_TOKEN"\n'
  try {
    if (!existsSync(f) || readFileSync(f, 'utf8') !== body) {
      mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
      writeFileSync(f, body, 'utf8')
    }
    chmodSync(f, 0o700)
  } catch (e) {
    logger.warn({ err: String(e) }, '[git-fiok] az askpass segedprogram nem jott letre')
  }
  return f
}

/** A git-kornyezet egy adott fiokhoz. Kulcs nelkul is mukodik (nyilvanos repo). */
export function gitEnvFor(account: string): NodeJS.ProcessEnv {
  const token = resolveToken(account)?.token
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Ne alljon meg jelszot varva egy szolgaltatasban, ahol nincs, aki beirja.
    GIT_TERMINAL_PROMPT: '0',
  }
  if (token) {
    env.MARVEEN_GIT_TOKEN = token
    env.GIT_ASKPASS = ensureAskpass()
  }
  return env
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 900000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ ok: !e, out: String(stdout || '').trim(), err: String(stderr || '').trim() })
    })
  })
}

/**
 * Van-e a gepen olyan gh-bejelentkezes, ami LAT ehhez a fiokhoz tartozo repot.
 *
 * Nem talalgatunk nev alapjan: MEGKERDEZZUK a GitHubot, es csak akkor
 * mondjuk, hogy jo, ha tenylegesen jon vissza olyan repo, aminek EZ a fiok a
 * gazdaja. Igy nem fordulhat elo, hogy egy idegen fiok kulcsat rendeljuk ide.
 */
export async function findBorrowKey(account: string): Promise<{ login: string; repos: number } | null> {
  const a = String(account || '').trim().toLowerCase()
  if (!a) return null
  for (const cand of ghCliTokens()) {
    const r = await githubApi(cand.token, '/user/repos?per_page=100&affiliation=collaborator,organization_member')
    if (!r.ok || !Array.isArray(r.body)) continue
    const n = r.body.filter((x: any) => String(x?.owner?.login || '').toLowerCase() === a).length
    if (n) return { login: cand.login, repos: n }
  }
  return null
}

/** A kolcsonzes rogzitese. A KULCS nem kerul be -- csak az, hogy kie. */
export function setBorrowedFrom(account: string, login: string): void {
  const store = readTokens()
  store[account] = { token: '', login, borrowedFrom: login, addedAt: new Date().toISOString() }
  writeTokens(store)
}

export interface PullResult {
  ok: boolean
  message: string
  cloned: string[]
  present: string[]
  failed: Array<{ name: string; message: string }>
}

/**
 * A fiok osszes repojanak lehuzasa a sajat mappajaba.
 *
 * Ami MAR ott van, ahhoz itt nem nyulunk: annak a frissitese a `git-sync`
 * dolga, es az sokkal ovatosabb (soha nem ir felul helyi munkat). Itt csak a
 * HIANYZOKAT klonozzuk -- igy a gomb barmikor ujra megnyomhato, es sosem
 * csinal kart.
 */
export async function pullGitAccount(account: string): Promise<PullResult> {
  const acc = String(account || '').trim()
  const root = depotRoot()
  if (!root) return { ok: false, message: 'Nincs beállítva raktár — a Raktár oldalon add meg, hova kerüljenek a fájlok.', cloned: [], present: [], failed: [] }
  let kolcsonzott = ''
  if (!hasGitToken(acc)) {
    // Nincs sajat kulcs -- de lehet, hogy a gepen van olyan bejelentkezes,
    // ami LAT ide. A hozzaferes nem a tulajdonon mulik: egy kozremukodo is
    // olvashatja a repot, csak eppen nem o a gazdaja.
    const borrow = await findBorrowKey(acc)
    if (!borrow) {
      return { ok: false, message: 'Ehhez a fiókhoz nincs hozzáférési kulcs, és a gépen lévő fiókok egyike sem lát ide. Add meg a „Kulcs” gombbal.', cloned: [], present: [], failed: [] }
    }
    setBorrowedFrom(acc, borrow.login)
    kolcsonzott = borrow.login
  }

  const dir = join(root, storageKindRoot('git'), acc)
  mkdirSync(dir, { recursive: true })

  const repos = await listRemoteRepos(acc)
  if (!repos.length) {
    return { ok: false, message: 'Ezzel a kulccsal egyetlen repót sem látok ehhez a fiókhoz. Ellenőrizd a fióknevet és a kulcs „repo” jogosultságát.', cloned: [], present: [], failed: [] }
  }

  const kolcsonSzoveg = kolcsonzott
    ? ` A kulcsot a(z) „${kolcsonzott}” fiókból kölcsönöztem — ez a fiók lát ezekre a repókra.`
    : ''
  const env = gitEnvFor(acc)
  const cloned: string[] = []
  const present: string[] = []
  const failed: Array<{ name: string; message: string }> = []

  for (const repo of repos) {
    const target = join(dir, repo.name)
    if (existsSync(join(target, '.git'))) { present.push(repo.name); continue }
    // A felhasznalonev a cimben marad, a KULCS nem: azt az askpass adja at.
    // A cimbe a KULCS GAZDAJANAK a neve kerul, nem a fioke: kolcsonkulcsnal
    // a ketto nem ugyanaz, es egy nem letezo felhasznalonev felesleges
    // hitelesitesi hibat okozna.
    const url = repo.cloneUrl.replace('https://', `https://${kolcsonzott || acc}@`)
    const r = await git(dir, ['clone', '--quiet', url, repo.name], env)
    if (r.ok) cloned.push(repo.name)
    else failed.push({ name: repo.name, message: (r.err.split('\n').pop() || '').slice(0, 140) })
  }

  logger.info({ account: acc, cloned: cloned.length, present: present.length, failed: failed.length }, '[git-fiok] lehuzas kesz')

  const parts: string[] = []
  if (cloned.length) parts.push(`${cloned.length} repó lejött: ${cloned.join(', ')}.`)
  if (present.length) parts.push(`${present.length} már megvolt.`)
  if (failed.length) parts.push(`${failed.length} nem sikerült: ${failed.map((f) => f.name).join(', ')}.`)
  if (!parts.length) parts.push('Nem volt mit tenni.')
  // A ZAR AZONNAL JON, nem kesobb. Egy "majd beallitjuk" allapotban eppen az
  // a par perc a veszelyes, amikor senki nem szamit ra.
  if (kolcsonzott) {
    const lock = await lockAccountReadOnly(acc)
    parts.push(`Csak olvasásra állítva (${lock.locked.length} repó): feltölteni innen nem lehet.`)
    if (lock.failed.length) parts.push(`⚠ Ezeket nem sikerült zárolni: ${lock.failed.join(', ')}.`)
  }
  if (kolcsonSzoveg) parts.push(kolcsonSzoveg.trim())
  parts.push('Innentől magától frissül, 6 óránként.')

  return { ok: failed.length === 0, message: parts.join(' '), cloned, present, failed }
}


/**
 * A push-cim, ami helyett SEMMI nincs. Beszedes, mert a git szo szerint
 * kiirja, es igy a hibauzenet maga mondja meg, miert nem ment el.
 */
const NO_PUSH = 'CSAK-OLVASAS--ez-a-repo-nem-a-mienk-a-feltoltes-le-van-tiltva'

/**
 * Egy repo csak-olvasasra allitasa: a `fetch` marad, a `push` elvagva.
 *
 * Nem fajl-jogosultsagot allitunk: azt egy ugynok eszre sem venne, vagy
 * megkerulne, es kozben a sajat szerkesztesei is elhasalnanak. Itt pont az
 * ellenkezoje kell: helyben BARMIT lehet, csak a ceges tarolo ne valtozzon.
 */
const PRE_PUSH_HOOK = `#!/bin/sh
# Marveen csak-olvasas zar. Ez a repo NEM a mienk -- olvasni szabad,
# feltolteni nem. Ha tenyleg fel kell tolteni ide, azt a repo gazdaja teszi
# meg a sajat gepen; ne ezt a fajlt torold le.
echo "" >&2
echo "  ELUTASITVA: ez a repo csak olvasasra van lehuzva." >&2
echo "  A helyi valtoztatasaid megmaradnak, de nem mennek fel a tavoli repoba." >&2
echo "" >&2
exit 1
`

export async function lockRepoReadOnly(dir: string): Promise<boolean> {
  // 1. reteg: a push-cim sehova nem mutat -- a veletlen push itt hasal el.
  const r = await git(dir, ['remote', 'set-url', '--push', 'origin', NO_PUSH], process.env)

  // 2. reteg: a hook a CIMTOL FUGGETLENUL fut le. Aki a cimet visszaallitja,
  // meg mindig ebbe utkozik. Ket fuggetlen retegbol egyet visszavonni keves.
  let hookOk = false
  try {
    const hooks = join(dir, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    const f = join(hooks, 'pre-push')
    writeFileSync(f, PRE_PUSH_HOOK, 'utf8')
    chmodSync(f, 0o755)
    hookOk = true
  } catch (e) {
    logger.warn('git-fiok: a pre-push zar nem irhato itt: ' + dir + ' -- ' + String(e))
  }
  return r.ok && hookOk
}

/**
 * Melyik repokrol vettuk le SZANDEKOSAN a zarat.
 *
 * Kulon fajl, nem a token-tar: itt nincs titok, es igy a jogosultsaga is
 * lazabb lehet. Alakja: { "<fiok>": ["<repo>", ...] }.
 */
function readonlyExceptionsFile(): string {
  return join(PROJECT_ROOT, 'store', 'git-readonly-kivetelek.json')
}

function readReadonlyExceptions(): Record<string, string[]> {
  try {
    const d = JSON.parse(readFileSync(readonlyExceptionsFile(), 'utf8'))
    return (d && typeof d === 'object') ? d : {}
  } catch { return {} }
}

/** Ki van-e VEVE ez a repo a zar alol. */
export function isReadOnlyException(account: string, repo: string): boolean {
  const list = readReadonlyExceptions()[String(account || '').trim()] || []
  return list.includes(String(repo || '').trim())
}

/**
 * A kivetel be/ki kapcsolasa. Ez dont arrol, mi tortenik a KOVETKEZO
 * lehuzaskor -- a mostani allapotot a hivo allitja be a lock/unlock hivassal.
 */
export function setReadOnlyException(account: string, repo: string, kivetel: boolean): void {
  const acc = String(account || '').trim()
  const r = String(repo || '').trim()
  if (!acc || !r) return
  const all = readReadonlyExceptions()
  const list = new Set(all[acc] || [])
  if (kivetel) list.add(r); else list.delete(r)
  if (list.size) all[acc] = [...list]; else delete all[acc]
  const f = readonlyExceptionsFile()
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  writeFileSync(f, JSON.stringify(all, null, 2), 'utf8')
}

/**
 * A zar LEVETELE: a push-cim visszaall, a hook eltunik.
 *
 * Mindketto kell. Felig levett zar rosszabb a nyitottnal: ugy nez ki, mintha
 * vedene, tehat utana mar nem nezne meg senki.
 */
export async function unlockRepoReadOnly(dir: string): Promise<boolean> {
  const cim = await git(dir, ['remote', 'get-url', 'origin'], process.env, 15000)
  if (!cim.ok) return false
  const r = await git(dir, ['remote', 'set-url', '--push', 'origin', cim.out.trim()], process.env)
  try { rmSync(join(dir, '.git', 'hooks', 'pre-push'), { force: true }) } catch { return false }
  return r.ok
}

/** Ugyanez egy egesz fiokra -- a mar korabban lehuzott repokra is. */
export async function lockAccountReadOnly(account: string): Promise<{ locked: string[]; failed: string[] }> {
  const root = depotRoot()
  const locked: string[] = []
  const failed: string[] = []
  if (!root) return { locked, failed }
  const dir = join(root, storageKindRoot('git'), String(account || '').trim())
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return { locked, failed } }
  for (const name of entries) {
    if (!existsSync(join(dir, name, '.git'))) continue
    // A SZANDEKOS kivetelt nem zarjuk vissza. Egy dontes, amit a gep a hatad
    // mogott visszacsinal, rosszabb, mintha meg sem lehetett volna hozni.
    if (isReadOnlyException(account, name)) continue
    if (await lockRepoReadOnly(join(dir, name))) locked.push(name)
    else failed.push(name)
  }
  return { locked, failed }
}

/** Csak-olvasasra van-e allitva ez a repo. A felulet ezt mutatja meg. */
export async function isRepoReadOnly(dir: string): Promise<boolean> {
  const r = await git(dir, ['remote', 'get-url', '--push', 'origin'], process.env, 15000)
  const cim = r.ok && r.out.includes('CSAK-OLVASAS')
  let hook = false
  try { hook = readFileSync(join(dir, '.git', 'hooks', 'pre-push'), 'utf8').includes('csak-olvasas zar') } catch {}
  // MINDKETTO kell. Ha csak az egyik all, az felig levett zar -- azt pedig
  // rosszabb zartnak latni, mint nyitottnak, mert nem nezne utana senki.
  return cim && hook
}

export interface AccountDeleteResult {
  ok: boolean
  /** Igaz, ha van bent valami: a felulet ilyenkor RAKERDEZ, es ujra kuldi force-szal. */
  needsConfirm?: boolean
  message: string
  repos?: string[]
}

/**
 * Egy git-fiok TELJES levetele: regiszter + kulcs + mappa.
 *
 * MERES ELOSZOR. Egy ures fiokot nincs mit felteni -- azt szo nelkul levesszuk.
 * Ha viszont repok vannak alatta, eloszor MEGMONDJUK, mi van bent, es csak a
 * masodik korben (`force`) torlunk: aki egy felreklikkelt gombbal 800 MB
 * munkat veszit, annak hiaba magyarazzuk utolag.
 *
 * ES VAN, AMIT FORCE-SZAL SEM: ha egy repoban fel nem toltott commit vagy
 * modositott fajl van, itt megallunk, es a repo sajat torlo-utjara kuldunk.
 * Ott egyesevel latszik, MI veszne el -- egy fiok-szintu "biztos?" ezt
 * elmosna, pedig eppen ez a lenyeges informacio.
 */
export async function deleteGitAccount(
  account: string,
  opts: { force?: boolean } = {},
): Promise<AccountDeleteResult> {
  const acc = String(account || '').trim()
  if (!acc) return { ok: false, message: 'Hiányzik a fiók neve.' }

  // A  a fan BELULI, relativ utat adja -- a depo gyokere kell
  // ele, kulonben egy nem letezo mappat mernenk meg, es minden fiok "uresnek"
  // latszana. (Ezt egy elo proba fogta meg: fel nem toltott repot is atengedett.)
  const root = depotRoot()
  if (!root) return { ok: false, message: 'Nincs beállítva a raktár helye, ezért nem nyúlok semmihez.' }
  const dir = join(root, storageKindRoot('git'), acc)
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { entries = [] }
  const repos: string[] = []
  const veszelyes: string[] = []

  for (const name of entries) {
    if (!existsSync(join(dir, name, '.git'))) continue
    repos.push(name)
    const st = await repoStatus(toLifeRel(join(dir, name)))
    if (!st.safe) veszelyes.push(`${name} — ${st.sentence.replace(/^⚠ /, '')}`)
  }

  if (veszelyes.length) {
    return {
      ok: false, repos,
      message: 'Ezt a fiókot most nem veszem le, mert olyan munka van benne, ami sehol máshol nincs meg:\n'
        + veszelyes.map((v) => '• ' + v).join('\n')
        + '\n\nTöltsd fel, vagy töröld ezeket a repókat egyesével az Intézőben — ott látod, mi veszne el.',
    }
  }

  if (repos.length && !opts.force) {
    return {
      ok: false, needsConfirm: true, repos,
      message: `Ebben a fiókban ${repos.length} repó van (${repos.join(', ')}). `
        + 'Mind fel van töltve, tehát bármikor visszahúzható — de a helyi másolat törlődik. Törölhetem?',
    }
  }

  // A KULCS MEGY ELOSZOR. Ha a mappa torlese felutkozben elhasal, ne maradjon
  // ott egy gazdatlan hozzaferesi kulcs egy fiokhoz, ami mar nincs a listan.
  removeGitToken(acc)
  const reg = readStorageRegistry()
  writeStorageRegistry(removeGitAccount(reg, acc))
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    return { ok: false, message: 'A fiók lekerült a listáról, de a mappáját nem tudtam törölni: ' + String(e) }
  }
  logger.info({ account: acc, repos: repos.length }, '[git-fiok] fiok levéve')
  return {
    ok: true, repos,
    message: repos.length
      ? `Levéve: ${acc} (${repos.length} repó helyi másolatával együtt). A távoli tárolókhoz nem nyúltam.`
      : `Levéve: ${acc}. Üres volt, nem veszett el semmi.`,
  }
}
