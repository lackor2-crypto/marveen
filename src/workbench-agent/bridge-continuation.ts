/**
 * A MUNKAPAD MUNKAJA NEM ALL MEG EGY FIOK KERETEN (Boss, 2026-09-29).
 *
 * "Az elso dolog az legyen, hogy megnezi, hogy milyen masik fiokban van limit
 * es tud dolgozni. Es ha van, akkor folytassa azzal a munkat. [...] Ezt a
 * keretkimerulest csak akkor irja ki, ha mar minden keret kimerult. [...] ez
 * kifejezetten a munkapad alatt [ervenyes], nem globalisan."
 *
 * A kod-hid (VS Code worker) feladata ket modon ert veget munka nelkul: a
 * fiokja kifogyott a keretbol, vagy a worker a sajat idokorlatja miatt
 * leallitotta. Ilyenkor a Munkapad-beszelgetesbe NEM a hiba kerul, hanem a
 * munka egy masik, bejelentkezett es keretben levo fiokkal folytatodik (az allo,
 * helyi munkamenetben). A hiba csak akkor latszik, ha nincs ilyen fiok.
 *
 * KET UT, EGY DONTES. A feladat lezarasat ket helyen latjuk: az elo chat-fordulo
 * (ha a felulet meg var), es a szerver lezaras-horga (mindig, ujrainditas utan
 * is). Az elo fordulo folytat, ha o figyel (`watching`); kulonben a horog
 * utemez egy hatter-folytatast. Egy feladat EGYSZER folytatodik (`continued`).
 */
import type { CodeTask } from '../web/code-bridge-store.js'
import { codeBridgeContinuable, codeBridgeFullyDone } from './code-bridge-turn.js'

/** Feladatok, amiket most egy elo chat-fordulo figyel: azok folytatasa az o dolga. */
const watching = new Set<string>()
/** Feladatok, amiknek a munkajat mar atvette egy masik fiok. */
const continued = new Set<string>()

/**
 * Boss, 2026-10-02 (TG 7117 + 7127): "amig a munka nincs kesz, barmilyen hibaval
 * all le, a dashboard adja ki ujra, hogy folytasd". Ezert MINDEN hibas leallas
 * folytatodik, nem csak a keret/elavult/elakadas. De egy DETERMINISZTIKUS hiba,
 * ami ujra meg ujra ugyanugy bukik (sosem lesz teljesen kesz), maga is a "nem tud
 * dolgozni" allapot: ennyiszer egymas utan folytatjuk chatenkent, utana a valodi
 * ok kerul a beszelgetesbe. Ugyanez all a befejezetlen ('incomplete') futasra is.
 * Egy TELJESEN KESZ (marker) lezaras nullazza a szamlalot. */
const MAX_ERROR_CONTINUES = 5
const errorContinues = new Map<string, number>()

/** A hatter-folytatas inditoja (a Munkapad-utvonal allitja be, korkoros import
 *  nelkul). true = van keretben levo fiok, a folytatas elindult. */
type Handler = (task: CodeTask) => boolean
let handler: Handler | null = null

export function setBridgeContinuationHandler(h: Handler | null): void { handler = h }

export function watchBridgeTask(id: string): void { watching.add(id) }
export function unwatchBridgeTask(id: string): void { watching.delete(id) }
export function isBridgeTaskWatched(id: string): boolean { return watching.has(id) }

export function markBridgeTaskContinued(id: string): void { continued.add(id) }
export function wasBridgeTaskContinued(id: string): boolean { return continued.has(id) }

/** Csak teszthez. */
export function resetBridgeContinuationForTest(): void {
  watching.clear()
  continued.clear()
  errorContinues.clear()
  handler = null
}

/**
 * A lezaras-horog kerdese: at kell-e irni a feladat kimenetelet a
 * beszelgetesbe? `true` = NEM kell (egy elo fordulo intezi, vagy egy masik
 * fiok mar folytatja) -- a limit/elakadas sora igy nem kerul ki.
 */
export function continueBridgeTaskElsewhere(task: CodeTask): boolean {
  if (task.origin !== 'workbench' || !task.chatId) return false
  if (continued.has(task.id)) return true
  // A TELJESEN kesz (marker) futas azt jelenti, hogy a munka tenyleg veget ert:
  // a chat folytatas-szamlaloja nullazodik, es nincs tovabbi folytatas.
  if (codeBridgeFullyDone(task)) { errorContinues.delete(task.chatId); return false }
  const kind = codeBridgeContinuable(task)
  if (!kind) return false
  // Sima hiba es befejezetlen (marker nelkuli) futas is folytatodik, de nem a
  // vegtelensegig: ha haladas (= teljesen kesz) nelkul ismetlodik, az maga is
  // "nem tud dolgozni" -> megall, es a valodi ok kerul a beszelgetesbe.
  if ((kind === 'error' || kind === 'incomplete') && (errorContinues.get(task.chatId) ?? 0) >= MAX_ERROR_CONTINUES) {
    errorContinues.delete(task.chatId)
    return false
  }
  // Az elo fordulo maga dont: ha van fiok, folytat, ha nincs, o irja ki az okot.
  if (watching.has(task.id)) return true
  if (!handler) return false
  let started = false
  try { started = handler(task) } catch { started = false }
  if (started) {
    continued.add(task.id)
    if (kind === 'error' || kind === 'incomplete') errorContinues.set(task.chatId, (errorContinues.get(task.chatId) ?? 0) + 1)
  }
  return started
}
