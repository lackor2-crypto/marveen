// "Mindent ujraindit" -- EGY gomb, ami minden beallitast eletbe leptet.
//
// Boss, 2026-08-16: "nem lenne sokal egyszerubb ha mindent ujrainditana ami
// letezik a marveen ban? az atyauristent is? ezzel meg lenne oldva a problema
// egyszeruen. nem?"
//
// Igaza van. A `restartTarget` (src/config-registry.ts) megmondja ugyan, hogy
// melyik beallitas melyik folyamatban el, de ezt NEM a tulajdonos dolga fejben
// tartani. Ez a modul az az egy gomb, ami utan nincs "es most melyiket is".
//
// EGYETLEN dolgot nem szabad, es ez nem izlesbeli:
//
//   A csatorna-szolgaltatas (`*-channels.service`) alatt el a KOZOS tmux
//   SZERVER, `KillMode=control-group`-pal. Azt ujrainditani annyi, mint
//   egyszerre megolni MINDEN agens ablakat -- nem csak a foagenset
//   (lasd src/web/channel-monitor.ts:1048 es src/self-restart.ts).
//
// Ezert a "minden" itt NEM szolgaltatas-szintu ujrainditas, hanem pontosan az
// a harom muvelet, ami ma is letezik kulon-kulon, egymas utan:
//
//   1. minden FUTO sub-agens ablaka (restartAgentProcess)
//   2. a foagens ablaka (hardRestartMarveenChannels -- ez sem nyul a
//      tmux szerverhez, csak a foagens sajat munkamenetehez)
//   3. vegul a vezerlopult sajat magat (performSelfRestart)
//
// A sorrend nem tetszoleges: a vezerlopult az UTOLSO, mert az o ujrainditasa
// oli meg azt a folyamatot, amelyik a tobbi lepest vegrehajtja.
//
// Es amit szinten nem csinalunk: a LEALLITOTT agenseket nem inditjuk EL.
// A `restartAgentProcess` egy allo agenst elinditana, de aki leallitott egy
// agenst, az szandekosan tette. Egy "ujrainditas" gomb ne keltsen eletre
// semmit -- ezert azok a lepesek `included: false`-szal, kimondott indoklassal
// kerulnek a tervbe, nem neman kimaradva.
import { unitIsSafeToRestart } from './self-restart.js'

export type RestartStepKind = 'agent' | 'main-agent' | 'dashboard'

/** Egy lepes a tervben. A felulet ugyanezt mutatja meg megerosites elott. */
export interface RestartStep {
  kind: RestartStepKind
  /** Gepi azonosito: agens neve, illetve a systemd unit neve a vezerlopultnal. */
  id: string
  /** Ember-olvashato nev -- ez megy ki a feluletre. */
  label: string
  /** Fut-e most? Ami nem fut, azt nem inditjuk el (lasd a fejlec vegen). */
  running: boolean
  /** Eppen DOLGOZIK-e? Ezt a munkat szakitanank meg -- ezert kerdezunk ra. */
  busy: boolean
  /** Vegrehajtjuk-e ezt a lepest? */
  included: boolean
  /** Ha nem hajtjuk vegre: miert nem. Sosem hallgatjuk el. */
  skipReason?: string
}

export interface RestartAllPlan {
  steps: RestartStep[]
  /** Hany olyan lepes van, ami eppen dolgozo folyamatot szakit meg. */
  busyCount: number
  /** Ujra tudja-e magat inditani a vezerlopult ezen a telepitesen? */
  dashboardPossible: boolean
  /** Ha nem: az emberi indoklas (a self-restart sajat szovege). */
  dashboardReason: string
}

/** Egy agens allapota a terv szempontjabol. */
export interface AgentSnapshot {
  name: string
  displayName: string
  running: boolean
  busy: boolean
}

export interface RestartAllInput {
  agents: AgentSnapshot[]
  main: AgentSnapshot
  dashboard: { possible: boolean; unit: string | null; reason: string }
}

/** A leallitott folyamatokhoz tartozo indoklas kulcsa (a felulet forditja). */
export const SKIP_NOT_RUNNING = 'not_running'
/** A vezerlopult nem tudja magat ujrainditani ezen a telepitesen. */
export const SKIP_DASHBOARD_UNAVAILABLE = 'dashboard_unavailable'

/**
 * A terv osszeallitasa. Tiszta fuggveny: bemenet -> lepeslista.
 *
 * Kulon fuggveny, mert egy ujrainditasi sorozatot nem lehet "kiprobalni" egy
 * tesztben, a SORRENDET es a KIHAGYASOKAT viszont meg kell tudni merni.
 */
export function buildRestartAllPlan(input: RestartAllInput): RestartAllPlan {
  const steps: RestartStep[] = []

  // 1. Sub-agensek. Nev szerint rendezve, hogy a felulet listaja ne ugraljon
  //    ket megnyitas kozott -- ugyanaz a terv ugyanazt a sorrendet mutassa.
  for (const a of [...input.agents].sort((x, y) => x.name.localeCompare(y.name))) {
    steps.push({
      kind: 'agent',
      id: a.name,
      label: a.displayName || a.name,
      running: a.running,
      busy: a.busy,
      included: a.running,
      ...(a.running ? {} : { skipReason: SKIP_NOT_RUNNING }),
    })
  }

  // 2. A foagens. Akkor is bekerul, ha eppen nem fut: az o munkamenetet a
  //    `hardRestartMarveenChannels` allitja helyre, es egy nem futo foagens
  //    eseten pont ez a helyes valasz (nala a "leallitva" allapot nem
  //    szandekos dontes, hanem hiba).
  steps.push({
    kind: 'main-agent',
    id: input.main.name,
    label: input.main.displayName || input.main.name,
    running: input.main.running,
    busy: input.main.busy,
    included: true,
  })

  // 3. A vezerlopult -- MINDIG utolso.
  //
  //    A tiltast itt is megismeteljuk, nem csak a self-restart.ts-ben: ha egy
  //    kesobbi telepites ossze is vonna a vezerlopultot a csatornakkal, ez a
  //    terv inkabb NE tartalmazza a lepest, mint hogy tmux-szervert oljunk.
  const unitSafe = unitIsSafeToRestart(input.dashboard.unit)
  const dashboardPossible = input.dashboard.possible && unitSafe
  steps.push({
    kind: 'dashboard',
    id: input.dashboard.unit || 'dashboard',
    label: input.dashboard.unit || 'dashboard',
    running: true,
    busy: false,
    included: dashboardPossible,
    ...(dashboardPossible ? {} : { skipReason: SKIP_DASHBOARD_UNAVAILABLE }),
  })

  return {
    steps,
    // Csak azt szamoljuk, amit tenylegesen meg is szakitunk: egy leallitott
    // agens "dolgozik" jelzese egy elavult olvasat lenne, es feleslegesen
    // ijesztgetne a megerosito ablakban.
    busyCount: steps.filter(s => s.included && s.busy).length,
    dashboardPossible,
    // Ha a hivo mar megmondta, MIERT nem lehet (pl. "ez a gep nem systemd-vel
    // inditja a Marveent"), azt a valaszt hagyjuk meg: az pontosabb. A tmux-
    // tiltas szoveget csak akkor tesszuk a helyere, ha egyedul az unit neve
    // miatt bukik a lepes -- kulonben rossz okot olvasna a Boss.
    dashboardReason: input.dashboard.possible && !unitSafe
      ? 'Ezt a szolgáltatást szándékosan nem indítom újra innen, mert az összes futó ügynök munkamenetét megszakítaná.'
      : input.dashboard.reason,
  }
}

export interface RestartStepResult {
  kind: RestartStepKind
  id: string
  label: string
  ok: boolean
  skipped: boolean
  error?: string
}

export interface RestartAllDeps {
  restartAgent: (name: string) => { ok: boolean; error?: string }
  restartMainAgent: () => { ok: boolean; error?: string }
}

/**
 * A terv vegrehajtasa -- a VEZERLOPULT LEPESE NELKUL.
 *
 * Az utolso lepes szandekosan nem itt fut: eloszor ki kell mennie a HTTP
 * valasznak, kulonben a bongeszo egy megszakadt kapcsolatot lat, es a
 * felhasznalo azt hiszi, elromlott valami -- pedig eppen az tortenik, amit
 * kert. A hivo (src/web/routes/system-restart.ts) a valasz utan inditja.
 *
 * Egy elbukott lepes NEM allitja meg a sort. Ha egy sub-agens ablaka nem jon
 * vissza, attol a foagensnek es a vezerlopultnak meg ujra kell indulnia --
 * kulonben egyetlen rossz agens miatt a beallitas sehol nem lepne eletbe.
 * A hiba nem vesz el: minden lepes sajat sort kap az eredmenyben.
 */
export function executeRestartAllPlan(plan: RestartAllPlan, deps: RestartAllDeps): RestartStepResult[] {
  const results: RestartStepResult[] = []
  for (const step of plan.steps) {
    if (step.kind === 'dashboard') continue
    if (!step.included) {
      results.push({ kind: step.kind, id: step.id, label: step.label, ok: true, skipped: true })
      continue
    }
    let r: { ok: boolean; error?: string }
    try {
      r = step.kind === 'main-agent' ? deps.restartMainAgent() : deps.restartAgent(step.id)
    } catch (err: any) {
      r = { ok: false, error: err?.message || String(err) }
    }
    results.push({
      kind: step.kind,
      id: step.id,
      label: step.label,
      ok: r.ok,
      skipped: false,
      ...(r.ok ? {} : { error: r.error || 'ismeretlen hiba' }),
    })
  }
  return results
}
