/**
 * Kanban 13fc793f (#255). Claude Code keret-banner: "resets ..." -> epoch ms.
 *
 * Egy helyen ertelmezzuk, mert ket, egymastol tavoli fogyasztoja van, es ket
 * masolat ket kulonbozo idopontot adna ugyanarra a szovegre:
 *
 *  - `web/routes/overview.ts` a tmux-panelbol kikapart bannerbol olvassa ki,
 *    mikor all vissza a fiok otorai ablaka (kijelzo);
 *  - `web/code-bridge-store.ts` a kod-hid kvota-blokkjanak LEJARATAHOZ hasznalja
 *    (dontes): egy keret-kimerules jel nem allhat orokke, lasd
 *    `QUOTA_BLOCK_FALLBACK_MS`.
 *
 * A masolat eddig az overview.ts-ben allt, teszt nelkul -- a kozos hely egyben
 * az elso tesztlefedettsege is.
 */

const MONTH_ABBRS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// A Claude Code ket alakban irja ki a visszaallast: csupasz ora ("resets 6:20pm",
// "resets 9pm"), es -- ha az ablak egy napnal tavolabb van -- datummal is
// ("resets Aug 14, 9am", "resets Sep 11, 9am"). A percet csak akkor irja ki, ha
// nem nulla, ezert a `:MM` NEM kotelezo.
//
// A zarojeles zona-jelolest (`(Europe/Budapest)`) MEGFOGJUK: a banner maga
// mondja meg, melyik zonaban ertendo a kiirt ora -- lasd a fuggveny IDOZONA
// bekezdeset. Nem kotelezo resz: regebbi/rovidebb bannerekben nincs ott.
const RESET_RX =
  /\breset(?:s)?(?:\s+at)?\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(\s*(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\s*\))?/i

/** Egy hosszabb, mint barmelyik valodi keret-ablak: ennel tavolabbi "visszaallas"
 *  mar biztosan nem a most futo ablakrol szol, hanem evfordulo-tevesztes. A
 *  leghosszabb valodi ablak egy het; 60 nap bőven fölötte van, viszont messze a
 *  ~365 napos evfordulo-tevedes alatt. */
const MAX_PLAUSIBLE_AHEAD_MS = 60 * 24 * 60 * 60 * 1000

/** Mennyivel jar a `zone` az UTC elott az adott pillanatban, ms-ben. `null`, ha
 *  a zonat ez a futtatokornyezet nem ismeri (a hivo ilyenkor visszaesik a
 *  folyamat sajat zonajara -- a hibas ido rosszabb a regi viselkedesnel). */
function zoneOffsetMs(zone: string, atMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(atMs))
    const p: Record<string, string> = {}
    for (const part of parts) p[part.type] = part.value
    const asUtc = Date.UTC(
      Number(p['year']), Number(p['month']) - 1, Number(p['day']),
      Number(p['hour']), Number(p['minute']), Number(p['second']),
    )
    if (!Number.isFinite(asUtc)) return null
    // Az Intl masodperc-pontossagu, ezert a nyers kulonbseget percre kerekitjuk:
    // minden valodi zona-offset egesz perc, a maradek csak szamitasi zaj.
    return Math.round((asUtc - atMs) / 60000) * 60000
  } catch {
    return null
  }
}

/** A megadott FALIORA-idopont (`zone` szerinti ev/ho/nap/ora/perc) epoch ms-ben.
 *  Ket menet, mert az elso becsles offsetje meg a rossz oldalan allhat egy
 *  nyariido-valtasnak. */
function wallClockToEpoch(
  y: number, mo: number, d: number, h: number, mi: number, zone: string | null,
): number | null {
  if (!zone) return new Date(y, mo, d, h, mi, 0, 0).getTime()
  const guess = Date.UTC(y, mo, d, h, mi, 0, 0)
  const off1 = zoneOffsetMs(zone, guess)
  if (off1 === null) return null
  const first = guess - off1
  const off2 = zoneOffsetMs(zone, first)
  if (off2 === null) return null
  return guess - off2
}

/** A `zone` szerinti naptari datum az adott pillanatban. */
function calendarDateIn(atMs: number, zone: string | null): { y: number; mo: number; d: number } | null {
  if (!zone) {
    const dt = new Date(atMs)
    return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate() }
  }
  const off = zoneOffsetMs(zone, atMs)
  if (off === null) return null
  const shifted = new Date(atMs + off)
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() }
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()
}

/**
 * A bannerben megnevezett visszaallasi pillanat epoch ms-ben, vagy `null`, ha a
 * szoveg nem hordoz ertelmezheto idopontot. A "nem talaltam" SOHA nem lesz
 * nulla vagy "most": a hivo maga donti el, mit kezd a hianyzo meressel.
 *
 * `anchorMs` = az a pillanat, AMIKOR a banner keletkezett (nem feltetlenul a
 * mostani ido!). A banner nem ir evet, a csupasz ora meg napot sem, tehat a
 * hianyzo reszeket valahonnan venni kell -- mindig a horgonyhoz KEPEST. Egy
 * tegnapi hibauzenetet ezert a sajat idejehez kell horgonyozni, nem a
 * mostanihoz: kulonben egy ejfelt atlepo "resets 2am" naprol napra
 * elorecsuszna, es a belole szamolt lejarat sosem kovetkezne be.
 *
 * IDOZONA (kartya 13fc793f masodik kor): a kiirt ora annak a gepnek a
 * zonajaban ertendo, amelyik a bannert irta -- es a banner ezt MEG IS MONDJA
 * ("resets Sep 11, 9am (Europe/Budapest)"). Ezert eloszor a bannerben allo
 * zonat hasznaljuk; ha a szoveg nem nevez zonat, a hivo altal atadott
 * `fallbackZone`-t (a telepites `APP_TZ`-je); es csak ha az sincs -- vagy ezt a
 * zonat a futtatokornyezet nem ismeri --, akkor a folyamat sajat zonajat.
 *
 * Ez a szolgaltatas-folyamat zonaja NEM feltetlenul a felhasznalo gepeje: egy
 * UTC-ben futo systemd-service ugyanarra a bannerre ket orat tevedne, es a
 * kvota-blokk ket oraval korabban oldodna fel. Friss telepitesen, mas zonaban
 * ez nem elmeleti eset (CLAUDE.md: ne a fejleszto gepere jellemzo ertekre
 * epits).
 */
export function parseUsageLimitResetAt(
  text: string,
  anchorMs: number,
  fallbackZone?: string | null,
): number | null {
  if (!text || !Number.isFinite(anchorMs)) return null
  const m = RESET_RX.exec(text)
  if (!m) return null
  const [, monAbbr, dayStr, hStr, minStr, ap, bannerZone] = m
  const hour12 = Number(hStr)
  // A 12 orás alak 1..12; barmi mas nem ora, hanem valami mas szam a szovegben.
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null
  let hours = hour12 % 12
  if (/pm/i.test(ap ?? '')) hours += 12
  const minutes = minStr ? Number(minStr) : 0
  if (minutes > 59) return null

  // A zona-sorrend: banner -> a telepites zonaja -> a folyamat zonaja (`null`,
  // vagyis a regi viselkedes). Ismeretlen zonanal ugyanide esunk vissza.
  let zone: string | null = bannerZone ?? fallbackZone ?? null
  if (zone && zoneOffsetMs(zone, anchorMs) === null) zone = null

  const anchorDate = calendarDateIn(anchorMs, zone)
  if (!anchorDate) return null

  if (monAbbr) {
    const mi = MONTH_ABBRS.indexOf(monAbbr.slice(0, 3).toLowerCase())
    if (mi < 0) return null
    const day = Number(dayStr)
    if (!Number.isInteger(day) || day < 1 || day > 31) return null

    // EVFORDULO: a banner nem ir evet, tehat a HORGONYHOZ LEGKOZELEBBI ilyen
    // datum a helyes valasz -- nem az utana kovetkezo elso.
    //
    // Miert nem "az elso, ami mar a horgony utan van"? Mert akkor egy MULTBELI
    // datum (pl. egy panelen ott ragadt, regi "resets Aug 14" szeptemberben)
    // csendben a KOVETKEZO ev augusztusara csuszna: egy majdnem egy evvel
    // kesobbi, sosem jovo lejarat. Az pontosan az a "sosem jar le" allapot,
    // ami ellen ez a kartya szol -- csak eggyel feljebb, a datum szintjen. A
    // legkozelebbi ev viszont a decemberi "Jan 2"-t is helyesen a kovetkezo
    // evre teszi (2 nap vs. 363), es a januari "Dec 30"-at az elozore.
    let best: number | null = null
    for (const year of [anchorDate.y - 1, anchorDate.y, anchorDate.y + 1]) {
      // Naptari ellenorzes: a "Feb 30" nem letezik, azt nem fogadjuk el
      // meresnek (a hibas datum rosszabb a hianyzonal).
      if (day > daysInMonth(year, mi)) continue
      const ts = wallClockToEpoch(year, mi, day, hours, minutes, zone)
      if (ts === null) continue
      if (best === null || Math.abs(ts - anchorMs) < Math.abs(best - anchorMs)) best = ts
    }
    if (best === null) return null
    // Egy "visszaallas", ami tobb honappal a horgony utan van, nem ablak-vege,
    // hanem felreertett datum -- a hianyzo meres jobb nala.
    if (best - anchorMs > MAX_PLAUSIBLE_AHEAD_MS) return null
    return best
  }

  // Csupasz ora: a horgony napjan, vagy -- ha az mar elmult -- masnap. Az
  // ablak atfordulhat ejfelen ("resets 2am" egy 23:40-es hibauzenetben). Itt a
  // "kovetkezo ilyen pillanat" helyes: egy ora-pontossagu megjeloles sosem szol
  // 24 orandal tavolabbi ablakrol.
  const sameDay = wallClockToEpoch(anchorDate.y, anchorDate.mo, anchorDate.d, hours, minutes, zone)
  if (sameDay === null) return null
  if (sameDay >= anchorMs) return sameDay
  return wallClockToEpoch(anchorDate.y, anchorDate.mo, anchorDate.d + 1, hours, minutes, zone)
}
