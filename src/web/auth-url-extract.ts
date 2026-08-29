// Kiolvassa a bejelentkezes OAuth-URL-jet a Claude Code tmux-paneljebol.
//
// Boss, 2026-08-29: "nem jelent meg semmi amikor a bejelentkezesre klikkeltem.
// tehat az a bongeszoben autentikation ablak nem jelent meg." Merve ugyanakkor
// az elo panelen -- a CLI PONTOSAN megmondja, mi tortent:
//
//     Login
//     Browser didn't open? Use the url below to sign in (c to copy)
//     https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88
//     ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co
//     m%2Foauth%2Fcode%2Fcallback&scope=...
//     Paste code here if prompted >
//
// A bejelentkezes egy FEJ NELKULI WSL tmux session-ben fut: ott nincs bongeszo,
// amit meg lehetne nyitni, ezert a CLI kiirja az URL-t. A vezerlopultnak tehat
// ezt az URL-t KELL megmutatnia -- kulonben a bejelentkezes a feluletrol nem
// vihato vegig (friss telepitesen sem).
//
// Ket dolog rontotta el eddig:
//
//   1. A regi kod HAROM KONKRET DOMAINRE illesztett (console.anthropic.com,
//      auth.anthropic.com, claude.ai/...login). A mai URL egyikre sem
//      illeszkedik -- ez ugyanaz a csapda, mint a lathatatlan szokozok
//      felsorolasa: a domain a szolgaltato dontese, barmikor valtozhat. Ezert
//      itt NEM domaint keresunk, hanem az OAUTH-VEGPONT alakjat.
//
//   2. A panel a FIX SZELESSEGERE TORDELI az URL-t. Meg ha a minta illeszkedne
//      is, csak az ELSO SORT kapnank meg -- egy csonka URL pedig rosszabb a
//      semminel: ugy nez ki, mintha mukodne, es egy hibaoldalra visz.
//      A tordelt sorokat ezert ossze kell fuzni.

/** A tordelt URL folytatasa-e ez a sor?
 *
 *  A panel a folytatast a BAL SZELEN kezdi (nincs behuzas) es nincs benne
 *  szokoz -- a CLI minden mas kiirasa be van huzva. A ket feltetel egyutt
 *  eleg szoros ahhoz, hogy egy kovetkezo, veletlenul szokoz nelkuli sort
 *  (pl. egy behuzas nelkuli szo) ne ragasszunk az URL vegere.
 */
function isWrappedContinuation(line: string): boolean {
  if (line.length === 0) return false
  if (/^\s/.test(line)) return false        // behuzott sor = mar nem az URL
  if (/\s/.test(line.trim())) return false  // szokozt tartalmazo sor = proza
  return true
}

/** Egy https-URL, ami OAuth-engedelyezo vegpontnak latszik. A `code_challenge`
 *  / `client_id` / `oauth` jelenlete a dontő, nem a gazdagep neve. */
const OAUTH_URL_RX = /https:\/\/\S*(?:oauth|\/authorize|client_id=)\S*/i

/** Barmilyen https-URL -- vegso tartalek, ha a fenti nem talal. */
const ANY_URL_RX = /https:\/\/\S+/

/** A CLI sora, ami az URL-t bevezeti. Ha megvan, az UTANA kovetkezo URL a jo. */
const SIGNIN_HINT_RX = /use the url below to sign in|browser didn'?t open/i

export interface ExtractedAuthUrl {
  url: string
  /** Hany panel-sorbol allt ossze. 1 = nem volt tordelve. Diagnosztikahoz. */
  lineCount: number
}

/**
 * Kiolvassa (es a tordelesbol osszefuzi) a bejelentkezesi URL-t.
 * `null`, ha a panelben nincs ilyen -- ez NEM azonos azzal, hogy a
 * bejelentkezes nem indult el; a hivonak ezt a kettot kulon kell mondania.
 */
export function extractAuthUrl(pane: string | null | undefined): ExtractedAuthUrl | null {
  if (!pane) return null
  const lines = pane.split('\n')

  // Ha megvan a bevezeto sor, onnantol keresunk: ez a legmegbizhatobb horgony,
  // mert a scrollbackben feljebb allo, regi URL-t nem szedjuk fel helyette.
  let from = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SIGNIN_HINT_RX.test(lines[i])) { from = i; break }
  }

  const pick = (rx: RegExp): ExtractedAuthUrl | null => {
    for (let i = from; i < lines.length; i++) {
      const m = rx.exec(lines[i])
      if (!m) continue
      const parts = [m[0]]
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j].replace(/\r$/, '')
        if (!isWrappedContinuation(raw)) break
        parts.push(raw.trim())
      }
      return { url: parts.join(''), lineCount: parts.length }
    }
    return null
  }

  return pick(OAUTH_URL_RX) ?? pick(ANY_URL_RX)
}
