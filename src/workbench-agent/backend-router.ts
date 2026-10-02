/**
 * A MUNKAPAD CHAT KET HATTERE (kanban #433, B opcio).
 *
 * Boss dontese (2026-09-27): a Munkapad chat moge egy VALODI, teljes erteku
 * Claude Code session kerul a kod-hidon at, a szukitett workbench-agent
 * helyett -- hogy helyben tudjon hibat felismerni ES javitani.
 *
 * De a kod-hid egy KULSO, bejelentkezett Claude Code workert igenyel. Ha az
 * nem fut (pl. friss telepites, worker meg nincs beparositva), a chat NEM
 * halhat meg: ilyenkor a meglevo, projektmappara szukitett workbench-agent
 * fut tovabb, es a felulet a `reason`-bol tudja, hogy setupra hivjon.
 *
 * Ez a modul CSAK a dontes. Szandekosan tiszta (nincs DB, nincs I/O), hogy
 * onmagaban teszthelheto legyen; a hivo adja be a mert allapotot.
 */

/** `live-session` (#434, C opcio): allo, helyi Claude Code folyamat, elo
 *  valasszal. Boss (2026-09-28): "ha lehet, akkor a VS Code-ot, a kodhidat
 *  valassza, ha van online" -- ezert automatikus fiokvalasztasnal az online
 *  kod-hid az ELSO; a helyi munkamenet akkor jon, ha nincs kod-hid, ha annak
 *  a fiokja kimerult, vagy ha a tulajdonos kifejezetten fiokot valasztott. */
export type WorkbenchBackend = 'live-session' | 'code-bridge' | 'workbench-agent'

export type BackendReason =
  /** A teljes erteku mod fut: van online worker es be van kapcsolva. */
  | 'ok'
  /** A tulajdonos nem kapcsolta be a teljes modot -> a projekt-asszisztens fut. */
  | 'disabled'
  /** Be van kapcsolva, de nincs online kod-hid worker -> a felulet setupra hiv. */
  | 'no_worker'
  /** #455: a chosen non-Claude model the live session cannot start (e.g. its
   *  key is missing) -> the project assistant answers and names why. Never the
   *  code bridge: that would silently answer on a Claude model instead. */
  | 'model_not_runnable'

export interface BackendDecisionInput {
  /**
   * Be van-e kapcsolva a teljes erteku mod (tulajdonosi beallitas). Alapbol
   * false: a bekapcsolatlan rendszer a megszokott projekt-asszisztenst hasznalja,
   * tehat a valtoztatas onmagaban semmit nem tor el.
   */
  fullAgentEnabled: boolean
  /**
   * Van-e legalabb egy FRISSEN latott (nem elavult) kod-hid worker.
   * A hivo a `codeBridgeHealth().workerOnline`-t adja be -- SOSE beegetve.
   */
  workerOnline: boolean
  /**
   * Indithato-e helyben az allo munkamenet: van `claude` CLI a PATH-on ES
   * bejelentkezett Claude-fiok. A hivo meri -- SOSE beegetve. Hianyzo mezo =
   * false (a regi hivok viselkedese valtozatlan).
   */
  liveAvailable?: boolean
  /**
   * Az online kod-hid elozze-e a helyi munkamenetet. A hivo adja: igaz, ha a
   * tulajdonos nem valasztott kifejezetten fiokot ES a kod-hid fiokja nem
   * futott nemreg limitbe. Hianyzo mezo = false (a regi sorrend).
   */
  bridgeFirst?: boolean
  /**
   * #455: the model chosen in the chat's Settings is not a Claude model (GLM,
   * DeepSeek, OpenRouter, local Ollama). The code bridge runs the worker's own
   * Claude login and cannot run it, so it is skipped: the live session (which
   * runs the chosen model) answers, else the project assistant. Missing = false
   * (the old order).
   */
  nonClaudeModel?: boolean
}

export interface BackendDecision {
  backend: WorkbenchBackend
  reason: BackendReason
  /** A felulet ebbol tudja, hogy a "koss be workert" setupra kell-e hivnia. */
  needsWorkerSetup: boolean
}

/**
 * Melyik hatter szolgalja ki a Munkapad chat kovetkezo uzenetet.
 *
 * A sorrend szandekos: eloszor a kapcsolo (a tulajdonos donti el, akar-e teljes
 * modot), utana a worker megléte. Igy egy bekapcsolt, de worker nelkuli allapot
 * NEM nemul el: fallbackol a projekt-asszisztensre, es jelzi, hogy setup kell.
 */
export function decideWorkbenchBackend(input: BackendDecisionInput): BackendDecision {
  if (!input.fullAgentEnabled) {
    return { backend: 'workbench-agent', reason: 'disabled', needsWorkerSetup: false }
  }
  if (input.workerOnline && input.bridgeFirst && !input.nonClaudeModel) {
    return { backend: 'code-bridge', reason: 'ok', needsWorkerSetup: false }
  }
  if (input.liveAvailable) {
    return { backend: 'live-session', reason: 'ok', needsWorkerSetup: false }
  }
  if (input.nonClaudeModel) {
    return { backend: 'workbench-agent', reason: 'model_not_runnable', needsWorkerSetup: false }
  }
  if (!input.workerOnline) {
    return { backend: 'workbench-agent', reason: 'no_worker', needsWorkerSetup: true }
  }
  return { backend: 'code-bridge', reason: 'ok', needsWorkerSetup: false }
}

/**
 * Which Claude login a code-bridge project runs with is decided by where its
 * folder lives (Boss, 2026-10-02): a Windows drive path (`f:\...`) belongs to
 * the Windows-side VS Code, which Boss keeps for his own trading-code work and
 * which may be signed in with another account; a WSL path (`\\wsl.localhost\...`
 * or `/home/...`) is the Marveen-side bridge. The Workbench chat does NOT go
 * through the Windows-drive bridge: it uses the live session with the best
 * account (the one with the most free quota), so an exhausted Windows login
 * can never stop it.
 */
export function isWindowsDriveBridgePath(workspacePath: string | null | undefined): boolean {
  return /^[A-Za-z]:[\\/]/.test(String(workspacePath ?? '').trim())
}
