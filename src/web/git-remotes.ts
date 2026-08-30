import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'

/**
 * A ket git-remote, amibol a Marveen frissul, KIOLVASVA -- sehol nem beegetve.
 *
 *  - `origin`   : innen frissul EZ a telepites (az update.sh ezt huzza).
 *  - `upstream` : az eredeti projekt, amibol ez a repo forkolodott. Az
 *                 Attekintes "Upstream szinkron" doboza ezt meri.
 *
 * Aki a mi Marveenunket telepiti, sajat `origin`-t lat; aki minket forkol,
 * minket lat `upstream`-kent. Egy friss telepitesen NINCS `upstream` remote --
 * ez nem hiba, hanem a normalis allapot, es a felulet ilyenkor hallgat.
 *
 * ★ A NULLA KET DOLGOT JELENTHET: kulon valaszt ad a "nincs ilyen remote"
 *   (readable:true, upstream:null) es a "nem tudom megnezni" (readable:false +
 *   a git TENYLEGES hibauzenete) allapotra. A hivo ezt a kettot sosem mossa
 *   ossze, es az okot sosem talalja ki.
 */

export interface RemoteInfo {
  name: string
  url: string
  /** `Owner/Repo`, ha GitHub-cim; egyebkent ures string (nem talalgatunk). */
  repo: string
}

export type RemotesResult =
  | { readable: true; origin: RemoteInfo | null; upstream: RemoteInfo | null }
  | { readable: false; error: string }

// A git eleresi utja. A `/usr/bin/git` a tipikus hely, de nem mindenhol az
// (Homebrew, Nix, egyedi telepites) -- ha nincs ott, a PATH-ra bizzuk. Igy egy
// friss telepites nem azon bukik el, hogy mashol all a binaris.
const GIT = existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git'

/**
 * Minden git-hivas kornyezete.
 *
 * ★ LC_ALL=C: a git hibauzenetei LEFORDULNAK, ha a rendszeren fel van telepitve
 *   a git-l10n (ezen a gepen nincs -- ott ez sosem latszana). Mi viszont a
 *   "No such remote" szovegre TAMASZKODUNK, hogy megkulonboztessuk a "nincs
 *   ilyen forras"-t (ez normalis) a "nem tudom megnezni"-tol (ez hiba). Egy
 *   nemet vagy francia telepitesen ez a kettő osszecsuszna, es egy friss
 *   telepites hibasnak latszana. Ezert a gepnek angolul valaszol a git; a
 *   felhasznalo ettol fuggetlenul a sajat nyelven latja a felulet mondatait.
 */
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANGUAGE: 'C', GIT_TERMINAL_PROMPT: '0' }

// A git hibauzenete ugy, AHOGY VAN (utolso ertelmes sor). Sosem irjuk felul
// tippelt okkal ("nincs halozat", "rossz kulcs") -- azt a felhasznalo a sajat
// szemevel kell hogy lassa.
function gitErrText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string; code?: string }
  const raw = typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString('utf-8') ?? ''
  const line = raw.split('\n').map(s => s.trim()).filter(Boolean).pop()
  return (line || e?.message || String(err)).slice(0, 300)
}

/** `Owner/Repo` egy GitHub-cimbol; minden mas cimre ures string. */
export function repoFromUrl(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
  return m ? m[1] : ''
}

function readOne(name: string): { url: string } | { missing: true } | { error: string } {
  try {
    const url = execFileSync(GIT, ['remote', 'get-url', name], {
      cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return url ? { url } : { missing: true }
  } catch (err) {
    // A git a "nincs ilyen remote" esetet is nem-nulla kilepokoddal jelzi.
    // Ez NEM hiba -- ezt kulon kell valasztani a "nem tudom megnezni"-tol,
    // kulonben egy friss telepites hibanak latszik.
    const text = gitErrText(err)
    if (/No such remote/i.test(text)) return { missing: true }
    return { error: text }
  }
}

export function readRemotes(): RemotesResult {
  // Eloszor magat a forrast kerdezzuk meg: git-checkout-e egyaltalan? Ha nem,
  // a "nincs upstream" valasz hazugsag lenne.
  try {
    execFileSync(GIT, ['rev-parse', '--git-dir'], { cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { readable: false, error: gitErrText(err) }
  }
  const out: { origin: RemoteInfo | null; upstream: RemoteInfo | null } = { origin: null, upstream: null }
  for (const name of ['origin', 'upstream'] as const) {
    const r = readOne(name)
    if ('error' in r) return { readable: false, error: r.error }
    if ('missing' in r) continue
    out[name] = { name, url: r.url, repo: repoFromUrl(r.url) }
  }
  return { readable: true, ...out }
}

export type UrlRejectReason = 'empty' | 'whitespace' | 'dash' | 'scheme' | 'shape'

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: UrlRejectReason }

/**
 * Elfogadhato remote-cim? Csak `https://`, `ssh://` es `felhasznalo@gep:ut`
 * alakot engedunk at.
 *
 * Ez nem kozmetika: a git `ext::<parancs>` es `file://` remote-jai PARANCSOT
 * tudnak futtatni a lehuzaskor, egy `-` kezdetu "cim" pedig a git sajat
 * kapcsolojakent ertelmezodne. A cim a feluletrol jon, tehat ellenorizzuk.
 */
export function validateRemoteUrl(input: string): UrlCheck {
  const url = (input || '').trim()
  if (!url) return { ok: false, reason: 'empty' }
  if (/\s/.test(url)) return { ok: false, reason: 'whitespace' }
  if (url.startsWith('-')) return { ok: false, reason: 'dash' }
  if (/^(https|ssh):\/\//i.test(url)) {
    if (!/^(https|ssh):\/\/[^/]+\/.+/i.test(url)) return { ok: false, reason: 'shape' }
    return { ok: true, url }
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+/.test(url)) return { ok: true, url }
  // Minden mas (ext::, file://, http://, csupasz ut) elutasitva.
  return { ok: false, reason: /^[a-z0-9+.-]+::?/i.test(url) ? 'scheme' : 'shape' }
}

export type WriteFailReason = 'bad-name' | 'bad-url' | 'git-failed'
export type WriteResult = { ok: true } | { ok: false; reason: WriteFailReason; detail?: string }

// Csak ezt a ket remote-ot engedjuk a feluletrol allitani. Barmi mas nev
// (vagy egy `--upload-pack=...` alaku "nev") elutasitva.
const ALLOWED = new Set(['origin', 'upstream'])

export function setRemote(name: string, url: string): WriteResult {
  if (!ALLOWED.has(name)) return { ok: false, reason: 'bad-name' }
  const check = validateRemoteUrl(url)
  if (!check.ok) return { ok: false, reason: 'bad-url', detail: check.reason }
  const existing = readOne(name)
  const args = 'url' in existing
    ? ['remote', 'set-url', name, check.url]
    : ['remote', 'add', name, check.url]
  try {
    execFileSync(GIT, args, { cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'git-failed', detail: gitErrText(err) }
  }
}

/**
 * Az `upstream` remote levetele. Csak ez a remote vehato le a feluletrol: az
 * `origin` nelkul a telepites nem tudna frissulni, azt tehat nem kinaljuk.
 * A muvelet visszafordithato -- a cim ujra megadhato ugyanitt.
 */
export function removeRemote(name: string): WriteResult {
  if (name !== 'upstream') return { ok: false, reason: 'bad-name' }
  try {
    execFileSync(GIT, ['remote', 'remove', name], { cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: 'git-failed', detail: gitErrText(err) }
  }
}
