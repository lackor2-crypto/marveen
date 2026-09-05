// Kanban #207 (d345eb2c): "pending work" a friss/ujrainditott sessionnek.
//
// A problema (usalackor merte fel): egy channels-restart / osszeomlas /
// watchdog-ujrainditas utan a friss session URES JARATBAN all. A taskstate-
// replay (agent-taskstate.ts) CSAK a PreCompact altal IRT rekordbol injektal --
// restart/osszeomláskor viszont PreCompact NEM fut, tehat nincs rekord, a replay
// no-op, es senki nem olvassa el az in_progress kanbant vagy a hot-memoriat
// session-indulaskor. Ez a modul ezt a rest tolti be: az ELO adatbol
// (in_progress kanban + hot emlek) allitja ossze, mit folytasson az agens.
//
// KETTOSSEG ("a nulla ket dolgot jelenthet"): egy URES valasz KET dolog lehet --
// "tenyleg nincs fuggo munka" (friss telepites, helyes csend) VAGY "nem ertem el
// az adatbazist" (elromlott, itt a leghangosabb sor kell). Ez a modul a ketto
// kozott KULONBSEGET tesz: az `olvashatatlan` flag jelzi a DB-hibat, es SOSE
// tunik ugy, mint "nincs fuggo munka". A hook fail-open (a session sose all meg),
// de a flag rendelkezesre all egy kesobbi feluletnek, hogy HANGOSAN mutassa.
//
// Fork-barat: uj fajl, a megosztott src/db.ts-t NEM modositja (a meglevo
// exportokat hasznalja). A taskstate-atfedes ellen: ha van AKTIV (nem fogyott,
// nem ures, TTL-en beluli) taskstate-rekord, ez a modul HALLGAT
// (`alreadyReplayed`), hogy ne injektaljunk ketszer.

import { listKanbanCards, getAgentMemories } from '../db.js'
import { readTaskState, isEmptyTaskState, TASKSTATE_TTL_MS } from './agent-taskstate.js'
import { currentBotName, MAIN_AGENT_ID } from '../config.js'

// A korlatok szandekosan szigoruak: az injektalt blokk fogodzo, nem archivum.
// Egy hataron tul maga a "mit folytass" is ujabb kontextus-teher lenne.
export const MAX_CARDS = 5
export const MAX_MEMORIES = 5
export const MEMORY_MAX_CHARS = 240
// A hot-emlekeknel a DB accessed_at DESC szerint ad -- de nekunk a LEGUTOBB IRT
// (created_at) kell (a legutobbi munkam), nem a legutobb OLVASOTT. Ezert szelesebb
// ablakot kerunk, es hivo-oldalt rendezunk created_at DESC szerint, ugy vagunk 5-re.
export const MEMORY_FETCH = 20

export interface PendingCardView {
  seq?: number // #N (rowid-alapu, ember-barat sorszam)
  id: string // 8-karakteres hex azonosito
  title: string
  status: string
}

export interface PendingMemoryView {
  id: number
  content: string // MEMORY_MAX_CHARS-ra vagva
}

export interface PendingWorkResult {
  // A hook ezt injektalja SessionStart additionalContext-kent. null = nincs mit
  // injektalni (a hook ilyenkor hallgat).
  additionalContext: string | null
  cards: PendingCardView[]
  memories: PendingMemoryView[]
  // Van aktiv taskstate-rekord -> a taskstate-replay kezeli, mi hallgatunk.
  alreadyReplayed: boolean
  // A DB-t nem sikerult elolvasni. Ez NEM ugyanaz, mint "nincs fuggo munka":
  // itt volt mit olvasni, csak nem lattunk oda -> a hivo ne mondja "minden csendes"-t.
  olvashatatlan: boolean
  // "A nulla ket dolgot jelenthet" a kartyaknal is: ha NINCS rad szignalt kartya,
  // az meg lehet ugy, hogy VAN in_progress kartya -- csak senkire (unassigned) vagy
  // MAS agensre szignalva. Ezeket NEM injektaljuk (nem a te munkad), de a szamukat
  // kulon jelezzuk, hogy egy felulet meg tudja mondani: "van folyamatban levo munka,
  // csak nem a tied", szemben a valodi "semmi sincs folyamatban"-nal.
  unassignedInProgressCount: number
  othersInProgressCount: number
}

// A tesztelhetoseg kulcsa: a DB-hozzaferes injektalhato. Igy a tiszta dontesi
// logika (korlatok, alreadyReplayed, olvashatatlan, ures-eset) filesystem es
// adatbazis nelkul is merheto.
// Az in_progress kartyak pillanatkepe egy agenshez: a SAJATJAI (rad szignalva),
// plusz a szetvalasztashoz ket szamlalo. A `mine` mar szurt es rendezett.
export interface InProgressSnapshot {
  mine: PendingCardView[]
  unassignedCount: number // in_progress, de assignee ures/NULL
  othersCount: number // in_progress, de MAS agensre szignalva
}

export interface PendingWorkDeps {
  listInProgressCards: (agent: string) => InProgressSnapshot
  getHotMemories: (agent: string) => PendingMemoryView[]
  hasActiveTaskState: (agent: string) => boolean
}

// Az assignee SZABAD SZOVEG (a 8 in_progress kartya kozott 'Marvin', 'Boss',
// 'usalackor', 'lackor2-bot' es 4 NULL is elofordul). Ezert a parositas
// kis/nagybetu-fuggetlen, es a fo agensnel a MEGJELENO nevet (currentBotName,
// pl. 'Marvin') IS elfogadjuk az agent_id ('marveen') mellett -- gepfuggetlenul,
// beegetett nev nelkul (src/config.ts). Mas agens kartyajat SOSE parositjuk.
export function assigneeMatchesAgent(assignee: string | null | undefined, agent: string): boolean {
  const a = (assignee ?? '').trim().toLowerCase()
  if (!a) return false
  const names = new Set<string>([agent.trim().toLowerCase()])
  if (agent === MAIN_AGENT_ID) names.add(currentBotName().trim().toLowerCase())
  return names.has(a)
}

export function truncate(s: string, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t
}

// Alapertelmezett (eles) deps: a meglevo src/db.ts + agent-taskstate exportokra epul.
export const defaultPendingWorkDeps: PendingWorkDeps = {
  listInProgressCards(agent: string): InProgressSnapshot {
    const inProgress = listKanbanCards().filter((c) => c.status === 'in_progress')
    const mine = inProgress
      .filter((c) => assigneeMatchesAgent(c.assignee, agent))
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, MAX_CARDS)
      .map((c) => ({ seq: c.seq, id: c.id, title: c.title, status: c.status }))
    // A ket szamlalo a TELJES in_progress halmazbol (nem a levagott 5-bol):
    // ures/NULL assignee vs. konkret MAS agens.
    const unassignedCount = inProgress.filter((c) => !(c.assignee ?? '').trim()).length
    const othersCount = inProgress.filter(
      (c) => (c.assignee ?? '').trim() !== '' && !assigneeMatchesAgent(c.assignee, agent),
    ).length
    return { mine, unassignedCount, othersCount }
  },
  getHotMemories(agent: string): PendingMemoryView[] {
    // Szelesebb ablak (MEMORY_FETCH), majd created_at DESC (legutobb IRT) szerint
    // rendezve vagunk MAX_MEMORIES-re -- a DB accessed_at DESC-je a legutobb OLVASOTT-at
    // hozna elore, nekunk viszont a legutobbi MUNKAM (irasom) kell.
    return getAgentMemories(agent, MEMORY_FETCH, 'hot')
      .slice()
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .slice(0, MAX_MEMORIES)
      .map((m) => ({
        id: m.id,
        content: truncate(m.content, MEMORY_MAX_CHARS),
      }))
  },
  hasActiveTaskState(agent: string): boolean {
    // Ugyanaz a feltetel, mint amire a taskstate-replay tuzel: letezik,
    // nem fogyott, nem ures, TTL-en belul. Ha igen -> o kezeli, mi hallgatunk.
    const r = readTaskState(agent)
    if (!r || r.consumed) return false
    if (Date.now() - r.ts > TASKSTATE_TTL_MS) return false
    if (isEmptyTaskState(r)) return false
    return true
  },
}

const SENTINEL = '=== FUGGO MUNKA -- folytatas ujrainditas utan (NEM uj feladat) ==='

/**
 * A tiszta szoveg-osszeallito. A sorrend szandekos: (1) koszones-fegyelem
 * (kondicionalis, hogy ne legyen MASODIK koszones a channel-visszajatszas
 * utan), (2) a konkret fuggo munka azonositoval, (3) "folytasd" a vegen.
 */
export function buildPendingWorkContext(
  agent: string,
  cards: PendingCardView[],
  memories: PendingMemoryView[],
): string {
  const lines: string[] = [SENTINEL]
  lines.push(
    'Ez a session ures jaratban indult (ujrainditas, osszeomlas vagy watchdog-restart utan), de van fuggo munkad. ' +
      'A koszonesrol NE magadtol donts: ha ezen az inditason kaptal EBREDES-KOSZONES sort (feljebb), az dont -- kovesd. ' +
      'Ha nem kaptal ilyet, es meg NEM koszontel a tulajdonosnak a sajat csatornajan, tedd meg egy rovid mondattal ' +
      '("Szia, itt vagyok, felebredtem"). Ha a csatorna-visszajatszas mar koszont helyetted, NE koszonj masodszor.',
  )
  if (cards.length) {
    lines.push(
      'FUGGO KANBAN KARTYAK (in_progress, neked cimezve):\n' +
        cards
          .map((c) => `  - ${c.seq != null ? `#${c.seq} ` : ''}(${c.id}) ${c.title} [${c.status}]`)
          .join('\n'),
    )
  }
  if (memories.length) {
    lines.push(
      'FRISS HOT-EMLEKEK (a legutobbi munkad, azonositoval):\n' +
        memories.map((m) => `  - [emlek ${m.id}] ${m.content}`).join('\n'),
    )
  }
  lines.push(
    'Folytasd a fenti KONKRET munkat onnan, ahol abbamaradt -- a fenti kartya/emlek a fogodzo, ' +
      'NE kezdj el talalgatni vagy vaktaban keresgelni. Ha kozben a tulajdonos mar irt valami mast a csatornan, ' +
      'az elsobbseget elvez. A kanban kartyat NE told "done"-ra magadtol (azt csak a tulajdonos teheti).',
  )
  return lines.join('\n\n')
}

/**
 * A fuggo munka osszerakasa egy agenshez. Elkapja a DB-hibat es KULON
 * `olvashatatlan` allapotot ad -- ez SOSE keverheto ossze a "nincs fuggo munka"
 * (ures, de olvashato) esettel.
 */
export function getPendingWork(
  agent: string,
  deps: PendingWorkDeps = defaultPendingWorkDeps,
): PendingWorkResult {
  const empty = (over: Partial<PendingWorkResult>): PendingWorkResult => ({
    additionalContext: null,
    cards: [],
    memories: [],
    alreadyReplayed: false,
    olvashatatlan: false,
    unassignedInProgressCount: 0,
    othersInProgressCount: 0,
    ...over,
  })

  let cards: PendingCardView[]
  let memories: PendingMemoryView[]
  let unassignedInProgressCount = 0
  let othersInProgressCount = 0
  try {
    // A taskstate-atfedes eloszor: ha o replay-el, mi ne szoljunk bele.
    if (deps.hasActiveTaskState(agent)) return empty({ alreadyReplayed: true })
    const snap = deps.listInProgressCards(agent)
    cards = snap.mine.slice(0, MAX_CARDS)
    unassignedInProgressCount = snap.unassignedCount
    othersInProgressCount = snap.othersCount
    memories = deps.getHotMemories(agent).slice(0, MAX_MEMORIES)
  } catch {
    // "Nem lattam oda" -- itt volt mit olvasni, csak nem ertem el. NEM csend.
    return empty({ olvashatatlan: true })
  }

  // Valodi ures allapot: a csend HELYES, hiba nelkul. DE a szamlalokat igy is
  // atadjuk -- "nincs rad szignalt kartya" != "semmi sincs in_progress":
  // lehet, hogy van in_progress munka, csak unassigned vagy mas agense.
  if (cards.length === 0 && memories.length === 0) {
    return empty({ unassignedInProgressCount, othersInProgressCount })
  }

  // A fuggo munka szovegebe SZANDEKOSAN csak a SAJAT kartyat + emleket injektaljuk
  // (usalackor korrekcio: "SOSE injektald mas agens kartyajat"). Az unassigned/mas
  // szamlalok a valaszban vannak, nem a resume-promptban.
  return empty({
    additionalContext: buildPendingWorkContext(agent, cards, memories),
    cards,
    memories,
    unassignedInProgressCount,
    othersInProgressCount,
  })
}
