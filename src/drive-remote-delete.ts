// FENT TOROLT, LENT MEGLEVO FAJL EGY MENTES-PAROSNAL (a tulajdonos, 2026-09-23).
//
// A mentes-paros iranya: a gep az igazsag, a Drive (vagy MEGA) a masolat. Ha a
// tulajdonos FENT torol egy fajlt, ket, egymasnak ellentmondo vedelem utkozik:
//
//   * A gepen NEM torlunk magatol -- ha valaki feltori a fiokot es mindent
//     letorol, a gepen minden megmarad.
//   * Eddig viszont a kovetkezo futas a fajlt "ujnak" latta, es VISSZATOLTOTTE
//     -- vegtelen korben, ahanyszor csak fent torolt.
//
// A dontes (a tulajdonos "A" valasza, uzenet 1271): a gepen marad, NEM toltjuk
// vissza, hanem a megerosito sorba kerul harom valasztassal: torold itt is /
// toltsd vissza / maradjon csak itt a gepen. Ha egyszerre sok fajl tunik el
// fent (VESZFEK_KUSZOB felett), az lehet feltores is -- akkor Telegramon szol.
//
// Ez a modul TISZTA dontes: fajlhoz, Drive-hoz nem nyul, csak megmondja, mit
// kell a nyilvantartassal es a sorral tenni. Igy kiprobalhato, es ugyanaz a
// szabaly all a Drive-ra es a MEGA-ra.

/** Ennel tobb EGYSZERRE eltunt fajl mar nem hetkoznapi takaritas. */
export const VESZFEK_KUSZOB = 50

export interface TrackedEntry {
  path: string
  size?: number
  /** Fent toroltek, a gepen megvan, es a tulajdonos meg nem kerte vissza. */
  remoteDeleted?: boolean
}

export interface RemoteDeleteResult {
  /** Ezek kerulnek a megerosito sorba (fent nincs, lent van). */
  queue: Array<{ driveId: string; relPath: string; size?: number }>
  /** Most jeloltuk meg eloszor -- ezeket szamolja a veszfek. */
  newlyMarked: string[]
  /** Fent ujra megjelent (pl. visszahozta a Kukabol): a jelzes lekerul. */
  cleared: string[]
  /** Fent SEM, lent SEM: nincs mit vedeni, a bejegyzes torolheto. */
  dropped: string[]
  /** Igaz, ha a mostani eltunes a veszfek kuszobe felett van. */
  brake: boolean
}

/**
 * `complete`: a bejaras TELJES volt. Csonka kepbol SEMMIT nem kovetkeztetunk --
 * a "nem lattam" nem azt jelenti, hogy "fent toroltek".
 */
export function planRemoteDeletions(
  state: Record<string, TrackedEntry>,
  seen: Set<string>,
  complete: boolean,
  localExists: (relPath: string) => boolean,
): RemoteDeleteResult {
  const r: RemoteDeleteResult = { queue: [], newlyMarked: [], cleared: [], dropped: [], brake: false }
  for (const [id, s] of Object.entries(state)) {
    if (!s || typeof s.path !== 'string' || !s.path) continue
    if (seen.has(id)) {
      if (s.remoteDeleted) r.cleared.push(id)
      continue
    }
    if (!complete) continue
    if (!localExists(s.path)) { r.dropped.push(id); continue }
    if (!s.remoteDeleted) r.newlyMarked.push(id)
    r.queue.push({ driveId: id, relPath: s.path, size: s.size })
  }
  r.brake = r.newlyMarked.length > VESZFEK_KUSZOB
  return r
}

/** A veszfek Telegram-uzenete, a telepites nyelven. */
export function brakeAlertText(lang: 'hu' | 'en', n: number, label: string): string {
  return lang === 'hu'
    ? `⚠️ Mentés: egyszerre ${n} fájl tűnt el fent (${label}). Ha nem te törölted, lehet, hogy valaki hozzáfért a fiókhoz. `
      + 'A gépeden minden megvan, semmit nem töröltem. A Raktár lapon a „Törlésre váró fájlok" listán egy gombbal vissza tudod tölteni őket.'
    : `⚠️ Backup: ${n} files vanished remotely at once (${label}). If you did not delete them, someone may have accessed the account. `
      + 'Everything is still on your computer, nothing was deleted. On the Depot page, the "Files awaiting deletion" list can re-upload them with one button.'
}
