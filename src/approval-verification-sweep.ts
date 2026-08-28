// Stale approval-verification sweep (Boss 2026-08-23).
//
// The problem this exists for, measured on the live board that day: of 176
// verification tasks dispatched to the free OpenRouter agents since 08-09,
// 100 were still sitting in 'pending' -- some for two weeks. The approvals
// page therefore showed counters like "Folyamatban (0/4)" that could never
// resolve, and nothing in the fleet ever noticed. Four separate causes, all
// invisible from the dashboard:
//   * the agent's model was withdrawn from the provider (Ling), or every call
//     returned a provider 400 (North);
//   * the agent read the task, answered in its own pane, and never called the
//     verify-result endpoint (Nemotronnano, Nemotronnano9, Lagunas);
//   * the agent had never once produced a result (Gemma, Nemotronvision);
//   * the machine restarted and nothing re-dispatched what was in flight.
//
// Boss, 2026-08-24: "latom a marvin megallt az utolso 2-t nem csinalta meg...
// gondolom azert mert elkezdte csinalni a tozsdei elemzest... oldd meg hogy ha
// mar egyszer ki van adva, akkor amikor ujra reer, akkor folytassa a munkat
// amit kapott. nem csak marvin hanem az osszes ugynok."
//
// Ket dolog allt ennek utjaban, mindketto MERVE ugyanaznap:
//
//  a) EGYETLEN emlekezteto ment ki, orokre. Ha az agens epp dolgozott, amikor
//     az az egy nudge megerkezett, tobbet semmi nem szolt neki -- a sor
//     csendben kivarta a hataridot es "nem valaszolt"-kent halt meg. Ezert a
//     nudge mostantol ISMETLODIK (REPEAT_MS), amig az agens elerheto.
//
//  b) az `agentExists` egy MAPPA letezeset nezte (`agents/<nev>/`), a
//     foagensnek viszont nincs ilyen mappaja: `agents/lackor2-bot` nem letezik
//     (merve). Vagyis Marvin minden 10 percnel regebbi ellenorzese azonnal
//     'noresponse:agent_gone'-t kapott volna -- "az ugynok mar nem letezik" --
//     mikozben Marvin el es epp dolgozik. A mai hat feladatbol a ket leglassabb
//     11 perc 10, illetve 11 perc 16 masodperc alatt keszult el: masodperceken
//     mult, hogy nem igy vegeztek. A letezes-kerdest ezert a HIVO donti el, aki
//     a foagenst a sajat forrasabol (tmux session) ismeri fel -- nem a mappak
//     szamabol kovetkeztetunk.
//
// A "ne probald orokke" elv marad, csak nem egyetlen nudge utan zar: 'noresponse' is NOT a verdict on the change under review,
// which is why the UI paints it amber rather than red (Boss: "narancssarga,
// mert piros akkor baj van").
//
// The core is dependency-injected so it unit-tests without a database, a
// tmux session, or a clock.
import type { ApprovalVerification } from './db.js'

/** No answer this long after dispatch and the agent gets its first reminder. */
export const VERIFICATION_REMINDER_MS = 10 * 60 * 1000
/**
 * Ennyi ido utan ISMET szolunk, ha meg mindig nincs valasz. Ez a valasz a
 * Boss keresere: egy elfoglalt agens (hosszu elemzes, futo build) ne veszitse
 * el a feladatot azert, mert az egyetlen emlekezteto rossz pillanatban jott.
 * Amig az agens elerheto, a feladat vissza-visszater a postaladajaba, es a
 * foagensnel az inbox-nudge-watcher a legkozelebbi TENYLEGES uresjaratban
 * kezbesiti -- vagyis pontosan akkor, "amikor ujra raer".
 */
export const VERIFICATION_REMINDER_REPEAT_MS = 10 * 60 * 1000

/**
 * ALLAPOT-VEZERELT IDOZITES (kanban 2a32b51e, Boss 2026-08-28):
 * "10 perc az sok. sokat kel varni. mi van ha 1 perc alatt megcsinal valamit
 *  az agent? akkor meg var 9 percig? feleslegesen? figyelni kellene hogy
 *  milyen statuszban van, es ha varakozoban, akkor mehet neki a kovetkezo!"
 *
 * Merve, a kifogas mogotti szam: 10 perc elso nudge + 2 perces sweep-tick =
 * egy agens, amelyik EGY PERC alatt vegez es utana tetlenul all, akar 12
 * percig nem kap semmit. Az ora rossz kerdesre valaszol; a jo kerdes az, hogy
 * az agens tud-e MOST feladatot fogadni.
 *
 * Ezert ket utemterv van, es azt, hogy melyik ervenyes, az agens allapota
 * dönti el:
 *   'idle' -> gyors utem: mar IDLE_GRACE_MS utan mehet az elso emlekezteto.
 *   'busy' -> a regi tizperces utem marad. Aki dolgozik, azt nem noszogatjuk;
 *             a tizperces ismetles annak az esetnek szol, amikor dolgozik
 *             ugyan, de kozben elvesztette a kapott feladatot.
 *   'unknown' -> szinten a tizperces utem, DE ez nem ugyanaz, mint a 'busy':
 *             azt jelenti, hogy nem lattunk oda. Nem allitjuk rola, hogy
 *             dolgozik, csak nem gyorsitunk. A hivo naplozza (lasd
 *             verification-sweep-job.ts).
 */
export type AgentActivity = 'idle' | 'busy' | 'unknown'

/**
 * Ennyi ido utan mehet az elso emlekezteto egy TETLEN agensnek. Nem nulla:
 * egy epp elinduló forduló ugy nez ki, mint a tetlenseg abban a pillanatban,
 * amikor a prompt mar bement, de a modell meg nem kezdett gepelni -- egy
 * masodperces nudge ugyanazt a feladatot kuldene ujra, amit epp olvas.
 */
export const VERIFICATION_IDLE_GRACE_MS = 90 * 1000

/**
 * Szunetek ket emlekezteto kozott TETLEN agensnel; az index a mar kikuldott
 * nudge-ok szama, az utolso ertek ismetlodik. Novekvo, mert egy tetlen, de
 * valaszolni nem tudo agens (halott modell, provider-hiba) kulonben negy oran
 * at masfel percenkent kapna uzenetet. Haz-minta: inbox-nudge-watcher.ts.
 */
export const VERIFICATION_IDLE_BACKOFF_MS: readonly number[] = [
  90 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
]

/**
 * Ennyi emlekezteto utan abbahagyjuk. Nem lezarjuk a sort -- azt a negyorás
 * hatarido teszi meg --, csak nem kuldunk tobbet. Aki hat noszogatasra nem
 * valaszolt, annak a hetedik sem fog segiteni, viszont a postaladajat
 * hasznalhatatlanna tenne.
 */
export const VERIFICATION_MAX_REMINDERS = 6

/** A gyors utem legkisebb ablaka -- ennel fiatalabb sort meg csak be sem
 *  olvasunk. Ez a lekerdezes vagasa: ha a REMINDER_MS maradna, a tetlen
 *  agenshez tartozo fiatal sor be sem kerulne a ciklusba, es a gyors utem
 *  sosem lepne eletbe. */
export const VERIFICATION_SCAN_FROM_MS = Math.min(VERIFICATION_IDLE_GRACE_MS, VERIFICATION_REMINDER_MS)

/** A ket utemterv egy helyen: mennyi ido utan mehet az ELSO nudge, es mennyi
 *  legyen a szunet a kovetkezoig, az allapot es az eddigi nudge-ok szamaban. */
export function reminderSchedule(activity: AgentActivity, remindersSent: number): { minAgeMs: number; gapMs: number } {
  if (activity !== 'idle') {
    return { minAgeMs: VERIFICATION_REMINDER_MS, gapMs: VERIFICATION_REMINDER_REPEAT_MS }
  }
  const i = Math.min(Math.max(remindersSent, 0), VERIFICATION_IDLE_BACKOFF_MS.length - 1)
  return { minAgeMs: VERIFICATION_IDLE_GRACE_MS, gapMs: VERIFICATION_IDLE_BACKOFF_MS[i]! }
}
/** No answer this long after dispatch and the row is given up on. Deliberately
 *  generous: a real review of a real commit (git show, reading the file, curling
 *  the endpoint) took the Szakerto ~10 minutes on 2026-08-23, and marking a
 *  slow-but-working agent as "never answered" would both lie on the page and
 *  dent its reliability badge. Waiting costs nothing but a later counter.
 *
 *  2026-08-24: 45 percrol 4 orara. A 45 perc egy EGYSZERI nudge-hoz volt merve;
 *  mostantol tizpercenkent ujra szolunk, es a Boss kerese az, hogy a mar kiadott
 *  feladat akkor is elkeszuljon, ha az agens kozben egy hosszu munkat kezdett.
 *  Negy ora alatt ~24 emlekezteto fer bele: ha egyikre sem jon valasz, az mar
 *  nem "epp elfoglalt", hanem valodi nema hiba -- azt viszont ki KELL mondani,
 *  kulonben a szamlalo sosem zar. */
export const VERIFICATION_TIMEOUT_MS = 4 * 60 * 60 * 1000

/** Stored in `report` instead of a sentence, so the dashboard can render the
 *  explanation in the reader's own language (HU/EN) rather than whatever
 *  language the sweep happened to be written in. */
export const NO_RESPONSE_TIMEOUT = 'noresponse:timeout'
export const NO_RESPONSE_AGENT_GONE = 'noresponse:agent_gone'

export interface VerificationSweepDeps {
  /** Wall clock, ms. */
  now: number
  /** Pending rows requested at or before the given epoch-SECOND cutoff. */
  listPendingOlderThan(cutoffEpochSec: number): ApprovalVerification[]
  /**
   * False csak akkor, ha az agens TENYLEG nincs meg (torolt/atnevezett).
   * A hivo dolga eldonteni, mert a foagenst nem mappa azonositja, hanem a
   * sajat channels-munkamenete -- lasd verification-sweep-job.ts.
   */
  agentExists(agent: string): boolean
  /** Delivers the nudge. Return false if it could not be queued. */
  sendReminder(row: ApprovalVerification): boolean
  /**
   * Records the nudge, refusing if one already went out after
   * `notRemindedSinceEpochSec`. The cutoff comes from HERE, because the repeat
   * window is the sweep's decision -- the store only closes the race between
   * two overlapping ticks. (Kanban 2a32b51e: while the store made that call
   * itself, with a hardcoded "never nudged before", the repeat below was dead
   * code and exactly one reminder ever went out.)
   */
  markReminded(id: string, atEpochSec: number, notRemindedSinceEpochSec: number): boolean
  markNoResponse(id: string, reason: string, atEpochSec: number): boolean
  /**
   * Az agens PILLANATNYI allapota. Harom ertek, mert a ketto hazudna: a
   * "nem lattam oda" (nincs munkamenet, olvashatatlan pane, ssh idotullepes)
   * NEM ugyanaz, mint a "dolgozik". Egy sort agensenkent egyszer kerdezunk le
   * fordulonkent -- a pane-olvasas masodpercekbe kerul.
   */
  probeActivity(agent: string): Promise<AgentActivity>
  /**
   * Van-e mar kikezbesitetlen uzenete az agensnek. Ha van, nem teszunk be
   * ujabbat: az uzenet-router magatol kivarja a tetlenseget bekuldes elott
   * (message-router.ts), tehat a mar sorban allo emlekezteto ugyis
   * kikezbesitodik. Ez a spam-vedelem legolcsobb fele, uj allapot nelkul.
   */
  hasUndeliveredMessage(agent: string): boolean
}

export interface VerificationSweepResult {
  reminded: string[]
  expired: string[]
  /** Sorok, amelyeknel nem lattunk oda az agens allapotara. Kulon gyujtve, hogy
   *  a hivo NAPLOZHASSA -- a nulla ket dolgot jelenthet, es ezt a kettot nem
   *  szabad osszemosni. */
  unreadable: string[]
}

/**
 * One pass. Safe to run on every startup and on a timer: a row is nudged only
 * when its own gap has passed (the store re-checks that under the UPDATE, so
 * two overlapping ticks cannot both send), and expired at most once (the
 * UPDATE is guarded on status = 'pending'). A restart loop cannot spam anyone.
 *
 * Async because deciding whether an agent is idle means reading its pane, and
 * that read is async. The probe is dependency-injected, so the tests still run
 * without tmux, a database, or a clock.
 */
export async function runVerificationSweep(deps: VerificationSweepDeps): Promise<VerificationSweepResult> {
  const nowSec = Math.floor(deps.now / 1000)
  const reminded: string[] = []
  const expired: string[] = []
  const unreadable: string[] = []

  // Egy lekerdezes a legszelesebb ablakra (a leggyorsabb utem alsohatara),
  // aztan memoriaban szetvalogatva -- a tobbi halmaz ennek reszhalmaza.
  const cutoffSec = Math.floor((deps.now - VERIFICATION_SCAN_FROM_MS) / 1000)
  // Egy agenst fordulonkent egyszer kerdezunk meg: a pane ketszeres olvasasa
  // masodpercekbe kerul, es ugyanaz a valasz all az osszes sorara.
  const activityByAgent = new Map<string, AgentActivity>()

  for (const row of deps.listPendingOlderThan(cutoffSec)) {
    const ageMs = deps.now - row.requested_at * 1000

    // An agent that no longer exists can never answer -- do not wait out the
    // full timeout for it, and never try to message it. This is the path that
    // clears rows left behind when an unreliable agent is removed.
    if (!deps.agentExists(row.agent)) {
      if (deps.markNoResponse(row.id, NO_RESPONSE_AGENT_GONE, nowSec)) expired.push(row.id)
      continue
    }

    if (ageMs >= VERIFICATION_TIMEOUT_MS) {
      if (deps.markNoResponse(row.id, NO_RESPONSE_TIMEOUT, nowSec)) expired.push(row.id)
      continue
    }

    // Az olcso kizarasok ELOSZOR, mert a kovetkezo lepes pane-olvasas.
    // 1) Elfogyott a nudge-keret: tobbet nem szolunk, a negyorás hatarido zar.
    if (row.reminder_count >= VERIFICATION_MAX_REMINDERS) continue
    // 2) Mar all egy kikezbesitetlen uzenet neki -- a router ugyis atadja,
    //    amint tetlen lesz. Egy masodik ugyanarrol csak zajt csinalna.
    if (deps.hasUndeliveredMessage(row.agent)) continue

    let activity = activityByAgent.get(row.agent)
    if (activity === undefined) {
      activity = await deps.probeActivity(row.agent)
      activityByAgent.set(row.agent, activity)
    }
    if (activity === 'unknown') unreadable.push(row.id)

    const { minAgeMs, gapMs } = reminderSchedule(activity, row.reminder_count)
    if (ageMs < minAgeMs) continue

    const sinceLastNudgeMs = row.reminded_at == null ? null : deps.now - row.reminded_at * 1000
    if (sinceLastNudgeMs !== null && sinceLastNudgeMs < gapMs) continue

    // Mark first: if the send throws or the router drops it, the row waits
    // out the gap instead of being nudged again on the next tick.
    const gapCutoffSec = Math.floor((deps.now - gapMs) / 1000)
    if (deps.markReminded(row.id, nowSec, gapCutoffSec)) {
      if (deps.sendReminder(row)) reminded.push(row.id)
    }
  }

  return { reminded, expired, unreadable }
}
