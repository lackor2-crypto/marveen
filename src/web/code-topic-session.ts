// Kanban 2741d289 (#252), 1. resz -- "meddig tart ugyanaz a munka".
//
// Boss hanguzenete (2026-09-10): "Amig ugyanahhoz a temahoz tartozik, addig
// ugyanahhoz a csetbe irjon. [...] De amig van kanban kartya, akkor a kanban
// kartyat kell figyelni, hogy ha az mar le van zarva, akkor oda mar nem irok
// tobbet."
//
// A KET DONTES, amit Boss 2026-09-11-en kimondott (Telegram, uzenet 821), es
// amit ez a modul valositt meg:
//
//   (a) MI DONTI EL, hogy "ugyanaz a tema"?  -> A KANBAN KARTYA AZONOSITOJA.
//       Boss valasztasa a ket felkinalt ut kozul az volt, amit ajanlottam:
//       "merheto, nem megitelés kerdese". Tehat NEM a cset szovegebol, NEM a
//       kartya cimenek hasonlosagabol, NEM az agens szabad megitelésebol --
//       hanem abbol az egy mezobol, amit a kiadas amugy is rogzit
//       (`code_tasks.card_ref`).
//
//   (c) MI LEGYEN, HA NINCS KARTYA?  -> MINDIG UJ BESZELGETES.
//       Ez szigoritas a korabbi viselkedeshez kepest: eddig egy kartya nelkuli
//       feladat is RESUME-elt a projekt "Marvin-sajat" beszelgetesebe. Mostantol
//       nem: tema nelkul nincs mihez tartoznia.
//
// MIERT NEM IDO-ALAPU. A korabbi nyitott kerdes az volt, hogy "X percig ugyanaz
// a munka". Az ora nem tud a temarol: egy ket perccel kesobb kiadott, MASIK
// hibarol szolo feladat ugyanugy belecsuszna a regi szalba, mig egy ket oraval
// kesobbi folytatas feleslegesen uj szalat nyitna. A kartya-azonosito pont azt
// meri, amit Boss mondott.
//
// A DONTES IRANYA BIZONYTALANSAGNAL: UJ BESZELGETES. Egy friss beszelgetes
// legrosszabb esetben annyi, hogy a futas nem latja az elozmenyt. Egy rossz
// szalba iras viszont IDEGEN (akar a tulaj altal eppen kezzel hasznalt)
// beszelgetesbe teszi a munkat -- ezt a kartya 032aa826 mar egyszer kizarta, es
// ez a modul nem nyithatja vissza.

/** Latjuk-e MOST azt a beszelgetest, amibe ujra irnank.
 *  A NULLA KET DOLGOT JELENTHET: a jeloltlista a memoriaban el, tehat egy
 *  vezerlopult-ujrainditas utan URES -- az nem azt jelenti, hogy a beszelgetes
 *  nincs meg, hanem azt, hogy nem latunk oda. Ezert harom ertek, nem ketto. */
export type SessionVisibility = 'yes' | 'no' | 'unknown'

export type TopicSessionDecision =
  /** Ugyanaz a tema, es a beszelgetes meg el: ebbe irjunk tovabb. */
  | { kind: 'reuse'; sessionId: string; cardRef: string }
  /** Uj, ures beszelgetes -- a `why` megmondja, MIERT (naploba is ez megy). */
  | { kind: 'fresh'; why: FreshReason }

export type FreshReason =
  /** A feladat egyetlen kanban kartyat sem nevez meg -> Boss (c) dontese. */
  | 'no_card'
  /** Ehhez a kartyahoz meg nem futott kod-hid munka ebben a projektben. */
  | 'no_prior_run'
  /** A kartya mar le van zarva: ment bele zaro uzenet, oda nem irunk tobbet. */
  | 'closed'
  /** Lattuk a projekt beszelgeteseit, es ez a szal mar nincs koztuk. */
  | 'session_gone'
  /** NEM LATUNK ODA (all a worker, vagy meg nem jelentett) -- nem talalgatunk. */
  | 'cannot_see'

export interface TopicSessionInput {
  /** `code_tasks.card_ref` -- a tema azonositoja. Ures = nincs tema. */
  cardRef: string | null
  project: string
  /** A most kiadando feladat, hogy sajat magat ne szamolja elozmenynek. */
  taskId: string
}

export interface TopicSessionDeps {
  /**
   * Azok a beszelgetesek, amelyekben EHHEZ a kartyahoz mar futott kod-hid munka
   * ebben a projektben -- LEGFRISSEBB eloszor.
   *
   * Csak olyan elozmeny szamit, amelyiknel a beszelgetest valaki SZANDEKOSAN
   * valasztotta: vagy a futas maga nyitotta (`start_fresh`), vagy a bekuldo egy
   * konkret fulre cimezte (`target_session_id`). A regi, 032aa826 elotti sorok
   * a felderites altal talalt "aktualis" fulbe futottak -- az akar a tulaj sajat
   * beszelgetese is lehetett, es azt nem szabad tema-egyezes cimen feltamasztani.
   */
  priorSessionsForCard: (cardRef: string, project: string, excludeTaskId: string) => string[]
  /** Ment-e mar "lezarva" uzenet erre a (kartya, beszelgetes) parosra. */
  wasClosed: (cardRef: string, sessionId: string) => boolean
  sessionVisible: (sessionId: string) => SessionVisibility
}

/**
 * A dontes maga, mellekhatas-mentesen: melyik beszelgetesbe menjen a most
 * kiadando feladat. Csak a legfrissebb elozmenyt nezi: az "ugyanaz a tema"
 * folytatasa a legutobbi allapot folytatasa, nem egy regebbi szale.
 */
export function decideTopicSession(input: TopicSessionInput, deps: TopicSessionDeps): TopicSessionDecision {
  const cardRef = (input.cardRef ?? '').trim()
  if (!cardRef) return { kind: 'fresh', why: 'no_card' }

  const prior = deps.priorSessionsForCard(cardRef, input.project, input.taskId)
  const last = prior[0]
  if (!last) return { kind: 'fresh', why: 'no_prior_run' }

  // A lezaras a (kartya, beszelgetes) parosra szol, es a zaro uzenet maga is ott
  // all a cset vegen -- ha kiment, oda tobbet nem irunk, akkor sem, ha a kartya
  // kesobb visszakerulne dolgozni. Olyankor a kovetkezo futas uj szalat nyit, es
  // annak a szalnak sajat lezarasa lesz.
  if (deps.wasClosed(cardRef, last)) return { kind: 'fresh', why: 'closed' }

  const seen = deps.sessionVisible(last)
  if (seen === 'no') return { kind: 'fresh', why: 'session_gone' }
  if (seen === 'unknown') return { kind: 'fresh', why: 'cannot_see' }
  return { kind: 'reuse', sessionId: last, cardRef }
}
