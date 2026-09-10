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
// nem nulla, ezert a `:MM` NEM kotelezo. A zarojeles idozona-jelolest
// szandekosan atlepjuk: lasd a fuggveny doksijat.
const RESET_RX =
  /\breset(?:s)?(?:\s+at)?\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i

/**
 * A bannerben megnevezett visszaallasi pillanat epoch ms-ben, vagy `null`, ha a
 * szoveg nem hordoz ertelmezheto idopontot. A "nem talaltam" SOHA nem lesz
 * nulla vagy "most": a hivo maga donti el, mit kezd a hianyzo meressel.
 *
 * `anchorMs` = az a pillanat, AMIKOR a banner keletkezett (nem feltetlenul a
 * mostani ido!). A banner nem ir evet, a csupasz ora meg napot sem, tehat a
 * hianyzo reszeket valahonnan venni kell: a valasz mindig az `anchorMs` UTANI
 * ELSO ilyen pillanat. Egy tegnapi hibauzenetet ezert a sajat idejehez kell
 * horgonyozni, nem a mostanihoz -- kulonben egy ejfelt atlepo "resets 2am"
 * naprol napra elorecsuszna, es a belole szamolt lejarat sosem kovetkezne be.
 *
 * IDOZONA: a pillanatot a FOLYAMAT sajat idozonajaban ertelmezzuk, a bannerben
 * allo zarojeles zonat (pl. "(Europe/Budapest)") figyelmen kivul hagyva. A
 * bannert a Claude Code a felhasznalo sajat gepen ervenyes zonajaban irja ki,
 * tehat a ketto egy gepen egybeesik; ket kulonbozo zonaju gep eseten a hiba
 * legfeljebb az offset-kulonbseg, es ez a fuggveny csak kijelzest es egy
 * lejaratot vezerel, nem visszafordithatatlan muveletet.
 */
export function parseUsageLimitResetAt(text: string, anchorMs: number): number | null {
  if (!text || !Number.isFinite(anchorMs)) return null
  const m = RESET_RX.exec(text)
  if (!m) return null
  const [, monAbbr, dayStr, hStr, minStr, ap] = m
  const hour12 = Number(hStr)
  // A 12 orás alak 1..12; barmi mas nem ora, hanem valami mas szam a szovegben.
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null
  let hours = hour12 % 12
  if (/pm/i.test(ap ?? '')) hours += 12
  const minutes = minStr ? Number(minStr) : 0
  if (minutes > 59) return null

  const anchor = new Date(anchorMs)
  if (monAbbr) {
    const mi = MONTH_ABBRS.indexOf(monAbbr.slice(0, 3).toLowerCase())
    if (mi < 0) return null
    const day = Number(dayStr)
    if (!Number.isInteger(day) || day < 1 || day > 31) return null
    // EVFORDULO: a banner nem ir evet. A "Jan 2" egy december 31-i hibauzenetben
    // a KOVETKEZO ev januarja -- a horgony evevel szamolva viszont majdnem egy
    // egesz evvel a MULTBA esne, es a belole szamolt lejarat azonnal lejartnak
    // latszana. Mindig a horgony utani elso ilyen datum kell.
    for (const year of [anchor.getFullYear(), anchor.getFullYear() + 1]) {
      const dt = new Date(year, mi, day, hours, minutes, 0, 0)
      // Naptari ellenorzes: a "Feb 30" atfordul marciusra, azt nem fogadjuk el
      // meresnek (a hibas datum rosszabb a hianyzonal).
      if (dt.getMonth() !== mi || dt.getDate() !== day) return null
      if (dt.getTime() >= anchorMs) return dt.getTime()
    }
    return null
  }

  // Csupasz ora: a horgony napjan, vagy -- ha az mar elmult -- masnap. Az
  // ablak atfordulhat ejfelen ("resets 2am" egy 23:40-es hibauzenetben).
  const sameDay = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), hours, minutes, 0, 0)
  if (sameDay.getTime() >= anchorMs) return sameDay.getTime()
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 1, hours, minutes, 0, 0).getTime()
}
