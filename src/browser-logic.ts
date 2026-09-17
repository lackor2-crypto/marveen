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
