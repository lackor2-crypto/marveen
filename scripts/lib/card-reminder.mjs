#!/usr/bin/env node
// card-reminder.mjs -- "a landolt kartyat tedd at 'waiting'-be" emlekezteto.
//
// MIERT KULON FAJL (2026-09-19, kartya 876b2833 / #332):
// Ez a logika a land-pr.sh-ba volt beagyazva egy egysoros `node -e`-vel, es
// KET hibat hordozott, amit teszt nem fogott meg (a szkriptbol semmi nem volt
// egysegtesztelheto):
//
//   1. A "NEM LATTAM ODA" ugyanugy nezett ki, mint a "nincs ilyen kartya".
//      Ha a dashboard nem futott, a token-fajl nem volt olvashato, vagy a curl
//      idotullepest kapott, a valasz ures sztring lett -- es a szkript ilyenkor
//      ugyanazt az enyhe emlekeztetot irta ki, mint amikor a kartyat tenyleg
//      nem talalta a tablan. A nulla ket dolgot jelenthet; itt kulon all.
//   2. HAMIS RIASZTAS ARCHIVALT KARTYARA. A lekerdezes a `/api/kanban`-t
//      hasznalta, ami `archived_at IS NULL`-ra szur ES kozben auto-archivalja a
//      regi 'done' kartyakat. Egy mar lezart, archivalt kartyara hivatkozo
//      kesobbi commit igy azt kapta, hogy "ha kesz, tedd at waiting-be" -- egy
//      olyan kartyara, amit a tulajdonos regen lezart. A zajos emlekezteto arra
//      tanitja az agenst, hogy ne olvassa el. A `/api/kanban/card-ids` MINDEN
//      kartyat visszaad (archivaltat is), tehat ez a forras.
//
// Hasznalat parancssorbol (a land-pr.sh igy hivja):
//   printf '%s' "$cards_json" | node scripts/lib/card-reminder.mjs "$TITLE" [lookup-hiba-oka]
// A masodik argumentum NEM ures, ha a lekerdezes el sem jutott a valaszig
// (nincs token-fajl, nem valaszolt a dashboard) -- ekkor a stdin tartalma nem
// szamit. Kimenet: a kiirando sor a stdout-on, vagy SEMMI, ha nincs teendo.
// Kilepokod mindig 0: ez emlekezteto, sose bukhat el tole a landolas.

/** A cimben levo elso kartya-referencia, vagy '' ha nincs.
 *  Nyolc-hat jegyu hexa (kartya-azonosito) vagy sorszam (#332). */
export function cardRefFromTitle(title) {
  const m = String(title || '').match(/#([0-9a-f]{6,8}|[0-9]+)\b/i)
  return m ? m[1].toLowerCase() : ''
}

/** A kartya allapota a `/api/kanban/card-ids` valaszabol.
 *  Visszaad: { ok: true, found, status } vagy { ok: false, why } -- a "nem
 *  ertelmezheto valasz" SOHA nem "nincs ilyen kartya". */
export function lookupCard(cardsJson, ref) {
  let rows
  try {
    const parsed = JSON.parse(cardsJson)
    rows = Array.isArray(parsed) ? parsed : parsed?.cards
  } catch {
    return { ok: false, why: 'a valasz nem ertelmezheto JSON' }
  }
  if (!Array.isArray(rows)) return { ok: false, why: 'a valasz nem kartya-lista' }
  const hit = rows.find((c) => String(c?.id ?? '').toLowerCase() === ref || String(c?.seq ?? '') === ref)
  if (!hit) return { ok: true, found: false, status: '' }
  return { ok: true, found: true, status: String(hit.status || '') }
}

/** Az emlekezteto sora, vagy '' ha nincs teendo. */
export function reminderLine(title, cardsJson, lookupError) {
  const ref = cardRefFromTitle(title)
  if (!ref) return ''
  if (lookupError) {
    return `land-pr: >>> NEM TUDTAM MEGNEZNI a #${ref} kartya allapotat (${lookupError}) -- ha kesz, tedd at 'waiting'-be. <<<`
  }
  const res = lookupCard(cardsJson, ref)
  if (!res.ok) {
    return `land-pr: >>> NEM TUDTAM MEGNEZNI a #${ref} kartya allapotat (${res.why}) -- ha kesz, tedd at 'waiting'-be. <<<`
  }
  if (!res.found) {
    // Nem riasztunk: a cimben levo szam lehet PR-szam vagy commit-toredek is.
    return `land-pr: (a #${ref} nem szerepel a kanban tablan, archivumban sem -- ha ez kartya-azonosito volt, nezz utana.)`
  }
  if (res.status === 'waiting' || res.status === 'done') return ''
  return `land-pr: >>> EMLEKEZTETO: a #${ref} kartya meg '${res.status}' -- a munka LANDOLT, tedd at 'waiting'-be (a 'done'-t a tulajdonos teszi). <<<`
}

// CLI: csak akkor fut, ha kozvetlenul hivjak (a teszt importalja a fuggvenyeket).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const title = process.argv[2] || ''
  const lookupError = process.argv[3] || ''
  let input = ''
  process.stdin.on('data', (d) => { input += d })
  process.stdin.on('end', () => {
    const line = reminderLine(title, input, lookupError)
    if (line) process.stdout.write(line + '\n')
  })
  // Ha nincs stdin (a hivo nem csovezett be semmit), ne fagyjunk be.
  if (process.stdin.isTTY) process.stdin.emit('end')
}
