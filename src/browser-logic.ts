// Kartya #165 (31f3e26f): a bongeszo-kepesseg TISZTA dontesei. Semmi
// Playwright, semmi fajlrendszer -- igy a teszt a bongeszo nelkul is lefut, es
// ezek a dontesek (lejart-e a munkamenet, visszafordithatatlan-e egy kattintas)
// nem a futo Chromiumon mulnak.

/** A mentett munkamenet allapota. A 'none' NEM hiba (nincs mentve semmi),
 *  az 'expired' viszont a leghangosabb sor -- a kettot a hivo kulon kapja. */
export type SessionHealth = 'ok' | 'expired'

interface CookieLike { expires?: number }

/**
 * Egy storageState sutijeibol dont: lejart-e. Csak a LEJARATI IDOVEL rendelkezo
 * sutik szamitanak; ha van ilyen es MIND lejart, a bejelentkezes elszallt. A
 * lejarat nelkuli (munkamenet-) sutiket nem tudjuk megitelni, ezert azok nem
 * billentik 'expired'-re -- azt a navigacio utani belepo-oldal-eszleles fogja.
 */
export function sessionHealthFromState(state: { cookies?: CookieLike[] } | null | undefined, nowSec: number): SessionHealth {
  const dated = (state?.cookies || []).filter(c => typeof c.expires === 'number' && c.expires > 0)
  if (dated.length === 0) return 'ok'
  return dated.every(c => (c.expires as number) <= nowSec) ? 'expired' : 'ok'
}

/** A belepo-oldal ismert URL-mintai. Ha egy mentett munkamenettel ide erkezunk,
 *  a munkamenet elszallt -- ezt kimondjuk, nem ures eredmenyt adunk. */
const LOGIN_URL_RE = /(\/|\b)(login|log-in|signin|sign-in|sign_in|auth\/|bejelentkez|belepes)/i

export function looksLikeLoginUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return LOGIN_URL_RE.test(u.pathname + u.search)
  } catch {
    return false
  }
}

/** Visszafordithatatlan lepesre utalo gomb-feliratok (HU+EN). */
const IRREVERSIBLE_RE = /\b(fizet\w*|kifizet\w*|v[aá]s[aá]rl?\w*|megrendel\w*|rendel[eé]s lead\w*|elk[uü]ld\w*|k[uü]ld[eé]s|bek[uü]ld\w*|t[oö]r[oö]l\w*|t[oö]rl[eé]s|j[oó]v[aá]hagy\w*|meger[oő]s[ií]t\w*|al[aá][ií]r\w*|pay|payment|checkout|buy|purchase|order|place order|submit|send|delete|remove|confirm|sign)\b/i

/**
 * Visszafordithatatlan-e egy kattintas. A `type=submit` gomb mindig az (urlapot
 * kuld el), egyebkent a felirat dont. Inkabb kerdezzunk ra egyszer feleslegesen,
 * mint hogy csendben elmenjen egy fizetes.
 */
export function isIrreversibleClick(el: { text?: string | null; type?: string | null; tag?: string | null }): boolean {
  const type = (el.type || '').toLowerCase()
  const tag = (el.tag || '').toLowerCase()
  if (type === 'submit' && (tag === 'button' || tag === 'input')) return true
  return IRREVERSIBLE_RE.test((el.text || '').trim())
}

/** Kartya 360da728 (Boss, 2026-09-18): a bongeszo-kepesseg alapbol BE. A config
 *  FAJL tartalmabol dont (vagy null, ha a fajl nincs / nem olvashato). Hianyzo
 *  vagy romlott config -> true, tehat egy FRISS telepitesen is bekapcsolva van,
 *  terminal/API nelkul. Csak a KIFEJEZETT `enabled:false` kapcsol ki -- azt a
 *  felhasznalo allitotta. Igy a "nincs config" es a "kifejezetten kikapcsolt"
 *  ket kulon eset, nem mossuk ossze oket. */
export function browserEnabledFromConfig(raw: string | null | undefined): boolean {
  if (raw == null) return true
  try {
    return JSON.parse(raw).enabled !== false
  } catch {
    return true
  }
}

/** A megjelenitett kepernyokepre kattintas -> a valodi bongeszo-viewport
 *  pixel-koordinatai. A kep aranytartoan jelenik meg (CSS: max-width:100%,
 *  height:auto), ezert egyszeru aranyszamitas eleg; a szeleket 0..1-re vagjuk,
 *  hogy egy hatarra eso kattintas se menjen a viewporton kivulre. Kartya
 *  a5e542ac: a headless Chromium page.mouse.click(x,y) ezt varja. */
export function mapImageClickToViewport(
  offsetX: number, offsetY: number, displayW: number, displayH: number, naturalW: number, naturalH: number,
): { x: number; y: number } | null {
  const nums = [offsetX, offsetY, displayW, displayH, naturalW, naturalH]
  if (nums.some(n => !Number.isFinite(n))) return null
  if (!(displayW > 0) || !(displayH > 0) || !(naturalW > 0) || !(naturalH > 0)) return null
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  return {
    x: Math.round(clamp(offsetX / displayW) * naturalW),
    y: Math.round(clamp(offsetY / displayH) * naturalH),
  }
}

/** A munkamenet neve a Vault-azonositoba kerul: csak biztonsagos karakterek. */
export function sessionSlug(name: string): string {
  return String(name || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

export const SESSION_VAULT_PREFIX = 'browser-session-'

/** Csak http(s) cimre navigalunk: file:// vagy javascript: a gep sajat fajljait
 *  / a dashboardot tenne elerhetove egy bongeszo-feladaton at. */
export function normalizeNavigateUrl(raw: string): string | null {
  let s = String(raw || '').trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** #762: a feltoltheto fajl CSAK a bongeszo feltoltes-mappajabol jon (store/browser/uploads).
 *  Egy ugynok-kerte tetszoleges utvonal ("../../.env") a gep fajljait vinne ki egy weboldalra. */
export function safeUploadName(raw: string): string | null {
  const s = String(raw || '').trim()
  if (!s || s.length > 200) return null
  if (s.includes('/') || s.includes('\\') || s.includes('\0') || s === '.' || s === '..' || s.startsWith('.')) return null
  return s
}

/** #762: letoltott fajl neve: utvonal-karakterek nelkul, ures nev helyett tartalek. */
export function safeDownloadName(suggested: string, fallback = 'letoltes'): string {
  const base = String(suggested || '').split(/[\\/]/).pop() || ''
  const clean = base.replace(/[\0-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 150)
  return clean || fallback
}

/** #762: fulindex a felulet/ugynok szovegebol: egesz, 0-tol, a lista hosszan belul. */
export function parseTabIndex(raw: unknown, count: number): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isInteger(n) || n < 0 || n >= count) return null
  return n
}

/** #762: JS-parbeszedablak (alert/confirm/prompt) kezelese: alapbol elutasitjuk (biztonsagos),
 *  mert egy confirm("Torlod?") elfogadasa visszafordithatatlan lehet. Elfogadni csak kifejezett kerere. */
export type DialogPolicy = 'dismiss' | 'accept'
export function parseDialogPolicy(raw: unknown): DialogPolicy | null {
  const s = String(raw ?? '').trim().toLowerCase()
  return s === 'accept' || s === 'dismiss' ? s : null
}

/** #762: a cookie a lejarat nelkuli ("session") sutik Chromium-ujrainditaskor elvesznek, pedig sok oldal
 *  bejelentkezese ilyen -- es a bongeszo 5 perc uresjarat utan magatol leall. Ezert a lejarat nelkuli sutiket
 *  kulon elmentjuk, es indulaskor ennyi masodpercnyi lejarattal visszaadjuk (ugy viselkednek, mint egy
 *  "maradj bejelentkezve" suti). */
export const SESSION_COOKIE_KEEP_SEC = 30 * 24 * 3600
export function sessionCookiesToKeep<T extends { expires?: number }>(cookies: unknown, nowSec: number): Array<T & { expires: number }> {
  if (!Array.isArray(cookies)) return []
  const out: Array<T & { expires: number }> = []
  for (const c of cookies as T[]) {
    if (!c || typeof c !== 'object') continue
    const exp = (c as any).expires
    if (exp === undefined || exp === null || exp === -1 || exp === 0) out.push({ ...c, expires: nowSec + SESSION_COOKIE_KEEP_SEC })
  }
  return out
}
