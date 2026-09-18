// TETELENKENTI TORLES-MEGEROSITO SOR (kanban #301).
//
// Boss, 2026-09-17: "epitsuk meg amit a profik csinalnak". A szinkron-motor
// TOBBE NEM TOROL MAGATOL egyik iranyban sem. Ami torlodne, az ebbe a sorba
// kerul, a felulet tetejen CSILLAGOS listakent latszik, es tetelenkent kell ra
// igent vagy nemet mondani:
//
//   * `up`   -- a fajl a GEPEDROL tunt el, a Drive-on meg megvan. Igen = a
//               Drive-peldany a Drive KUKAJABA megy (30 napig visszahozhato).
//   * `down` -- a fajl a DRIVE-ROL tunt el, a gepeden meg megvan. Igen = a
//               helyi peldany a raktar sajat Kukajaba megy (Rendszer / Kuka),
//               NEM vegleges torles.
//
// A "nem" soha nem torol semmit: a tetel kikerul a sorbol, a fajl marad.
//
// Ez a modul csak a SORT kezeli (lemezre irva, azonnal). Hogy a jovahagyas
// utan mi tortenik a fajllal, azt a drive-sync vegpontja donti el -- itt
// semmilyen fajlhoz nem nyulunk.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

/** Fuggveny, nem konstans: a tesztek sajat, eldobhato mappat kapnak. */
let storeRoot = join(PROJECT_ROOT, 'store')

/** Csak a teszteknek. */
export function setDeleteQueueStoreDir(dir: string): void {
  storeRoot = dir
}

export function deleteQueuePath(): string { return join(storeRoot, 'drive-delete-queue.json') }

export type DeleteDirection = 'up' | 'down'

export interface DeleteQueueItem {
  /** Sajat azonosito: paros + irany + Drive-fajl. Igy ugyanaz a tetel nem kerul be ketszer. */
  id: string
  direction: DeleteDirection
  pairId: string
  pairLabel: string
  account: string
  driveId: string
  /** A paroshoz kepesti relativ ut (a nyilvantartas szerint). */
  relPath: string
  /** A teljes helyi ut -- ezt latja a felhasznalo. */
  localPath: string
  size?: number
  /** Mikor vettuk eszre eloszor. */
  detectedAt: string
}

export interface DeleteQueueLoad {
  items: DeleteQueueItem[]
  /**
   * Amire a felhasznalo NEMET mondott. Ezeket a kovetkezo futas nem teszi
   * vissza a sorba -- kulonben a "nem" csak a kovetkezo szinkronig tartana.
   * Ha a helyzet megszunik (a fajl visszakerult), a bejegyzes is kikerul.
   */
  dismissed: string[]
  /** Olvashatatlan fajl: NEM ugyanaz, mint az ures sor. */
  readError: string
}

export function itemId(direction: DeleteDirection, pairId: string, driveId: string): string {
  return `${direction}:${pairId}:${driveId}`
}

function valid(x: any): x is DeleteQueueItem {
  return !!x && typeof x === 'object'
    && (x.direction === 'up' || x.direction === 'down')
    && typeof x.id === 'string' && typeof x.pairId === 'string'
    && typeof x.driveId === 'string' && typeof x.relPath === 'string'
}

export function loadDeleteQueue(): DeleteQueueLoad {
  const p = deleteQueuePath()
  if (!existsSync(p)) return { items: [], dismissed: [], readError: '' }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const items = Array.isArray(raw?.items) ? raw.items.filter(valid) : []
    const dismissed = Array.isArray(raw?.dismissed) ? raw.dismissed.filter((x: unknown) => typeof x === 'string') : []
    return { items, dismissed, readError: '' }
  } catch (err: any) {
    return { items: [], dismissed: [], readError: String(err?.message || err) }
  }
}

function save(items: DeleteQueueItem[], dismissed: string[]): void {
  const p = deleteQueuePath()
  mkdirSync(dirname(p), { recursive: true })
  // Atomikus csere: egy felbeszakadt iras ne hagyjon felig irt, olvashatatlan sort.
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify({ items, dismissed }, null, 2))
  renameSync(tmp, p)
}

/**
 * Egy paros egyik iranyanak sorat a MOSTANI kephez igazitja.
 *
 * `current`: amit ebben a futasban torlendonek latunk. Ami mar bent van, az
 * megtartja az eredeti `detectedAt`-jat; ami uj, bekerul; ami bent volt, de
 * mar nem torlendo (a fajl visszakerult, vagy kozben mashogy rendezodott), az
 * KIKERUL -- kulonben egy mar okafogyott tetelre lehetne igent mondani.
 *
 * Csak TELJES kepbol szabad hivni. Csonka bejarasnal a "most nem latom" nem
 * azt jelenti, hogy "mar nem torlendo".
 */
export function syncQueueForPair(
  pairId: string,
  direction: DeleteDirection,
  current: Array<Omit<DeleteQueueItem, 'id' | 'detectedAt' | 'direction' | 'pairId'>>,
  now = new Date().toISOString(),
): { added: number; removed: number; total: number } {
  const load = loadDeleteQueue()
  // Olvashatatlan sor fole nem irunk: az a felhasznalo dontesre varo listaja.
  if (load.readError) {
    logger.warn(`[drive-delete-queue] a sor olvashatatlan, nem irom felul: ${load.readError}`)
    return { added: 0, removed: 0, total: 0 }
  }
  const mas = load.items.filter((i) => !(i.pairId === pairId && i.direction === direction))
  const regi = new Map(load.items
    .filter((i) => i.pairId === pairId && i.direction === direction)
    .map((i) => [i.id, i]))
  const elotag = `${direction}:${pairId}:`
  const mostIdk = new Set(current.map((c) => itemId(direction, pairId, c.driveId)))
  // A "nem" addig el, amig a helyzet fennall; utana elfelejtjuk.
  const dismissed = load.dismissed.filter((d) => !d.startsWith(elotag) || mostIdk.has(d))
  const elutasitva = new Set(dismissed)
  let added = 0
  const uj: DeleteQueueItem[] = []
  for (const c of current) {
    const id = itemId(direction, pairId, c.driveId)
    if (elutasitva.has(id)) continue
    const volt = regi.get(id)
    if (!volt) added++
    uj.push({ ...c, id, direction, pairId, detectedAt: volt?.detectedAt || now })
  }
  const removed = [...regi.keys()].filter((k) => !uj.some((u) => u.id === k)).length
  if (added || removed || dismissed.length !== load.dismissed.length) save([...mas, ...uj], dismissed)
  return { added, removed, total: uj.length }
}

export function getQueueItem(id: string): DeleteQueueItem | null {
  return loadDeleteQueue().items.find((i) => i.id === id) || null
}

/**
 * Egy tetel eltavolitasa a sorbol. `dismiss`: a felhasznalo NEMET mondott --
 * ilyenkor meg is jegyezzuk, hogy a kovetkezo futas ne kerdezze ujra.
 */
export function removeQueueItem(id: string, dismiss = false): boolean {
  const load = loadDeleteQueue()
  if (load.readError) return false
  const items = load.items.filter((i) => i.id !== id)
  if (items.length === load.items.length) return false
  const dismissed = dismiss && !load.dismissed.includes(id) ? [...load.dismissed, id] : load.dismissed
  save(items, dismissed)
  return true
}

/** Egy paros minden tetele ki (a paros leválasztásakor). */
export function removePairFromQueue(pairId: string): void {
  const load = loadDeleteQueue()
  if (load.readError) return
  const items = load.items.filter((i) => i.pairId !== pairId)
  const dismissed = load.dismissed.filter((d) => d.split(':')[1] !== pairId)
  if (items.length !== load.items.length || dismissed.length !== load.dismissed.length) save(items, dismissed)
}
