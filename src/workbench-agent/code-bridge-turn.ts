/**
 * A MUNKAPAD CHAT TELJES ERTEKU HATTERE (kanban #433, B opcio).
 *
 * Amikor a teljes mod be van kapcsolva ES van online kod-hid worker (a dontest
 * a `backend-router.ts` hozza), a Munkapad chat uzenete NEM a szukitett
 * projekt-asszisztenshez megy, hanem egy VALODI Claude Code sessionhoz a
 * kod-hidon at. Ez a modul csinalja: felad egy kod-feladatot, majd a
 * befejezesig pollozza, es a valaszt UGYANABBA az esemeny-formaba tukrozi
 * vissza, amit a chat-felulet a projekt-asszisztenstol is var
 * (`OrchestratorEvent`). Igy a felulet valtozatlanul rendereli.
 *
 * Szandekosan a `result`/`error` mezoket olvassa (nem a transzkriptet
 * parszolja): az a keszre-futott feladat vegleges valasza, ami minden
 * telepitesen egyformán ott van. A lepesenkenti eszkozfutasok a `toolRuns`
 * dep-en jonnek (a kod-hid sajat transzkriptjebol, `code-bridge-tool-feed.ts`).
 *
 * A modul dep-injektalt (enqueue / getTask / now / sleep), hogy kulso worker
 * nelkul, determinisztikusan teszthelheto legyen.
 *
 * Merve (2026-09-28): a kod-hid eddig CSAK a puszta utolso mondatot kapta
 * ("na most meg tudod csinalni?") -- elozmeny, projekt, munkadarab nelkul --,
 * es a fordulo nem kerult a beszelgetesbe (ujratoltes utan eltunt, a
 * projekt-asszisztens sem latta). A prompt ezert a beszelgetes vegevel es a
 * projekt adataival indul (`buildCodeBridgePrompt`), es minden fordulo a
 * `record`-on at a beszelgetes-naploba kerul.
 */
import type { OrchestratorEvent } from './orchestrator.js'
import { msg, type Lang } from './messages.js'
import { PROMPT_MAX_CHARS } from '../web/code-bridge-store.js'
import { detectsUsageLimit } from '../model-fallback.js'

export type CodeBridgeStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface CodeBridgeTaskView {
  status: CodeBridgeStatus
  result: string | null
  summary: string | null
  error: string | null
}

export interface CodeBridgeEnqueue {
  project: string
  prompt: string
  requestedBy: string | null
  chatId: string | null
}

export type CodeBridgeEnqueueResult =
  | { ok: true; id: string }
  | { ok: false; message: string }

export interface CodeBridgeTurnDeps {
  enqueue(input: CodeBridgeEnqueue): CodeBridgeEnqueueResult
  getTask(id: string): CodeBridgeTaskView | null
  now(): number
  /** Varakozas ket lekerdezes kozott; az AbortSignal-t tiszteli. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  /** Lekerdezesek koze eso ido (alap 2000 ms). */
  pollMs?: number
  /** Meddig varjuk itt a befejezest, mielott a hattérnek engedjuk (alap 15 perc). */
  timeoutMs?: number
  /** A fordulo a beszelgetes-naploba (user kerdes, valasz, rendszer-sor). */
  record?(role: 'user' | 'assistant' | 'system', content: string): void
  /** A felhasznalo leallitotta: a feladatot a sorban is lezarjuk. */
  cancel?(id: string): void
  /** A chat varakozasa utan meddig figyeljuk meg a hatterben (alap 6 ora),
   *  hogy a kesve erkezo valasz is bekeruljon a beszelgetesbe. */
  backgroundMs?: number
  /** The bridge's own tool runs (Read, Bash, ...) since the previous call, read
   *  from its transcript (`code-bridge-tool-feed.ts`); `finish` closes the runs
   *  left open when the task ended. Missing = only the single bridge row. */
  toolRuns?(taskId: string, finish?: 'ok' | 'error'): OrchestratorEvent[]
  /** Can the turn go on with ANOTHER account right now (Boss, 2026-09-29)? When
   *  true, a limit / stalled outcome is NOT written into the conversation: the
   *  caller continues the work elsewhere, and the owner only ever sees the
   *  limit when every account is out. Missing = false (old behaviour). */
  canContinueElsewhere?(): boolean
  /** Set when the task is handed to the background: a continuation that
   *  already took the work over must not get the stale outcome written. */
  wasContinued?(taskId: string): boolean
  /** The bridge's Claude Code is too old (#446): try to update it. When it
   *  reports `updated`, the turn starts the task again ONCE; `notice` (already
   *  in the turn's language) is shown either way. Missing = no repair. */
  repairPossible?(): boolean
  repairOutdatedBridge?(detail: string, lang: Lang): Promise<{ updated: boolean; notice: string | null }>
}

export interface CodeBridgeTurnInput {
  /** A Munkapad-projekt azonositoja (a kod-hid ebbol oldja fel a workspace-t;
   *  ha nem talal kituzott sessiont, a preamble mondja meg, HOL a munka). */
  projectRef: string
  /** A felhasznalo sajat mondata -- ez kerul a beszelgetes-naploba. */
  message: string
  /** A kod-hidnak atadott feladat (kontextussal); ha nincs, a `message` megy. */
  prompt?: string
  lang: Lang
  requestedBy: string | null
  /** Ahova a valasz visszamegy: a Munkapad-beszelgetes azonositoja. A feladat
   *  lezarasakor a szerver ebbe irja a valaszt (`deliverCodeTaskToWorkbench`)
   *  -- akkor is, ha kozben ujraindult, es az elo fordulo mar nem el. */
  chatId?: string | null
  signal?: AbortSignal
}

const DEFAULT_POLL_MS = 2000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_BACKGROUND_MS = 6 * 60 * 60 * 1000
const BACKGROUND_POLL_MS = 10_000

/** Az elozmenybol ennyi fordulo es ennyi karakter megy a feladatba. */
export const CODE_BRIDGE_HISTORY_TURNS = 12
export const CODE_BRIDGE_HISTORY_CHARS = 16_000
const CODE_BRIDGE_TURN_CHARS = 4_000

export interface CodeBridgePromptInput {
  projectName: string
  /** A projektmappa abszolut utja, ha be van allitva (kulonben null). */
  projectFolder: string | null
  /** `folder`: a munkadarab sajat mappaja (projekt-relativ); `materials`: a
   *  csatolt anyagai, projekt-relativ uttal es tamogatasi allapottal (#441). */
  workItem: { title: string; type: string; folder?: string | null; materials?: string[]; documentsHint?: string | null; family?: string[] } | null
  /** A beszelgetes eddigi sorai, idorendben, az UJ uzenet NELKUL. */
  history: { role: string; content: string }[]
  message: string
  lang: Lang
}

/**
 * A teljes erteku ugynok feladata: KI beszel, MIROL (projekt, munkadarab,
 * mappa), mi hangzott el eddig, es mi az uj uzenet. Enelkul egy "na most meg
 * tudod?" jellegu mondat ertelmezhetetlen.
 */
const MATERIALS_IN_PROMPT = 30

/** A munkadarab mappaja es anyagai (#441) -- hogy a "toltottem fel ide egy
 *  fajlt" mondat utan az agens tudja, hol keresse. Uresen semmit nem ir. */
function workItemFileLines(w: CodeBridgePromptInput['workItem']): string[] {
  if (!w) return []
  const out: string[] = []
  if (w.folder) out.push(`Work item folder (inside the project folder): ${w.folder}`)
  const m = w.materials || []
  if (m.length) {
    const shown = m.slice(0, MATERIALS_IN_PROMPT)
    out.push(`Work item materials (files the owner attached, path inside the project folder [support]): ${shown.join('; ')}${m.length > shown.length ? ` ... and ${m.length - shown.length} more` : ''}`)
  }
  if (w.family?.length) out.push(...w.family)
  if (w.documentsHint) out.push(w.documentsHint)
  return out
}

export function buildCodeBridgePrompt(input: CodeBridgePromptInput): string {
  const language = input.lang === 'en' ? 'English' : 'Hungarian'
  const head = [
    '[MARVEEN WORKBENCH CHAT] The owner is talking to you from the chat of the Workbench (Munkapad), not from a terminal. Your final answer is shown in that chat word for word.',
    `Project: ${input.projectName}`,
    `Project folder: ${input.projectFolder ?? '(no folder set for this project)'}`,
    `Work item: ${input.workItem ? `${input.workItem.title} (type: ${input.workItem.type})` : '(none -- project-level chat)'}`,
    ...workItemFileLines(input.workItem),
    `Answer in ${language}, in plain sentences for a non-programmer.${input.lang === 'en' ? '' : ' Address the owner informally (tegezés: "te"), never with "Ön" or "Maga".'}`,
  ]
  const tail = ['\n--- NEW MESSAGE FROM THE OWNER ---', input.message]
  const historyIntro = '\nThe conversation so far (oldest first; the project assistant answered these as ASSISTANT). The new message may refer back to it:\n\n'
  const noHistory = '\n(No earlier messages in this conversation.)'
  // #434: the code bridge refuses any prompt over PROMPT_MAX_CHARS, and the
  // history budget alone used to be larger than that -- a long conversation
  // made EVERY later message fail with "prompt too long (12187 > 12000)"
  // (Boss, TG 1764). The history gets only what the fixed parts leave free.
  const fixed = head.join('\n').length + tail.join('\n').length + historyIntro.length + 2
  const budget = Math.min(CODE_BRIDGE_HISTORY_CHARS, PROMPT_MAX_CHARS - fixed)
  const rows = input.history.filter((r) => r.role === 'user' || r.role === 'assistant').slice(-CODE_BRIDGE_HISTORY_TURNS)
  const lines: string[] = []
  let total = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    const body = r.content.length > CODE_BRIDGE_TURN_CHARS
      ? `${r.content.slice(0, CODE_BRIDGE_TURN_CHARS)}\n[... shortened here only; the owner saw the full message in the chat]`
      : r.content
    const line = `${r.role === 'user' ? 'OWNER' : 'ASSISTANT'}: ${body}`
    // "\n\n" joins the lines: count it, or the sum drifts past the budget.
    if (total + line.length + 2 > budget) break
    lines.unshift(line)
    total += line.length + 2
  }
  return [
    ...head,
    lines.length ? `${historyIntro}${lines.join('\n\n')}` : noHistory,
    ...tail,
  ].join('\n')
}

/** A hiba VALODI oka: a worker gyakran csak altalanos hibat ad
 *  ("Claude Code reported an error"), a konkret ok (pl. kimerult keret) a
 *  result/summary mezoben all. Mindkettot kiirjuk, nem talalgatunk. */
export function codeBridgeErrorDetail(task: CodeBridgeTaskView): string {
  const err = (task.error ?? '').trim()
  const why = (task.result ?? task.summary ?? '').trim()
  if (err && why && !err.includes(why)) return `${err}: ${why}`
  return err || why
}

/**
 * Egy Munkapad-fordulo a kod-hidon at. Ugyanazokat az esemenyeket adja
 * (`session` kivetelevel, azt a hivo mar kiadta), amiket a projekt-asszisztens.
 *
 * `input.message` a felhasznalo SAJAT mondata (ez kerul a naploba);
 * `input.prompt` -- ha van -- a kod-hidnak atadott, kontextussal bovitett
 * feladat (`buildCodeBridgePrompt`).
 */
export async function* runCodeBridgeTurn(
  input: CodeBridgeTurnInput,
  deps: CodeBridgeTurnDeps,
): AsyncGenerator<OrchestratorEvent> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const record = (role: 'user' | 'assistant' | 'system', content: string): void => {
    try { deps.record?.(role, content) } catch { /* a naplo hibaja nem allitja meg a valaszt */ }
  }
  // A transcript that cannot be read never breaks the answer: no rows, that's all.
  const toolRuns = (id: string, finish?: 'ok' | 'error'): OrchestratorEvent[] => {
    try { return deps.toolRuns?.(id, finish) ?? [] } catch { return [] }
  }

  record('user', input.message.trim())

  const enq = deps.enqueue({
    project: input.projectRef,
    prompt: input.prompt ?? input.message,
    requestedBy: input.requestedBy,
    chatId: input.chatId ?? null,
  })
  if (!enq.ok) {
    // A feladat nem indult el: a chat a megszokott hiba-mondatot mutatja,
    // nem nemul el.
    const m = msg('code_bridge_enqueue_failed', input.lang, { detail: enq.message })
    record('system', m)
    yield { type: 'notice', code: 'code_bridge_enqueue_failed', message: m }
    yield { type: 'done', model: null }
    return
  }

  let taskId = enq.id
  let repairTried = false
  yield { type: 'notice', code: 'code_bridge_handed_off', message: msg('code_bridge_handed_off', input.lang, { id: taskId }) }
  // Latszo folyamatjelzo a chat-panelen (a kod-hid-nezetre mutat a szoveg).
  yield { type: 'tool', name: 'code-bridge', status: 'running' }

  const start = deps.now()
  let lastStatus: CodeBridgeStatus | '' = ''

  for (;;) {
    if (input.signal?.aborted) {
      // Leallitas: a sorban is lezarjuk, hogy a worker ne dolgozzon tovabb
      // egy olyan kerdesen, amire mar senki nem var.
      try { deps.cancel?.(taskId) } catch { /* a lezaras hibaja nem uj hiba a chatben */ }
      yield* toolRuns(taskId, 'ok')
      const m = msg('code_bridge_cancelled', input.lang)
      record('system', m)
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      yield { type: 'notice', code: 'code_bridge_cancelled', message: m }
      yield { type: 'done', model: null }
      return
    }

    const task = deps.getTask(taskId)
    if (!task) {
      const m = msg('code_bridge_lost', input.lang)
      record('system', m)
      yield { type: 'tool', name: 'code-bridge', status: 'error' }
      yield { type: 'error', code: 'code_bridge_lost', message: m }
      return
    }

    if (task.status !== lastStatus) {
      lastStatus = task.status
      if (task.status === 'running') {
        yield { type: 'notice', code: 'code_bridge_running', message: msg('code_bridge_running', input.lang) }
      }
    }

    if (task.status === 'running') yield* toolRuns(taskId)

    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
      yield* toolRuns(taskId, task.status === 'error' ? 'error' : 'ok')
      // #446: a too-old bridge program is repaired and the task started again,
      // once per turn (the updater itself allows one attempt per hour).
      const outdated = task.status === 'error' && !repairTried && deps.repairOutdatedBridge ? codeBridgeOutdatedDetail(task) : null
      if (outdated && deps.repairOutdatedBridge) {
        repairTried = true
        if (deps.repairPossible?.() !== false) {
          yield { type: 'notice', code: 'code_bridge_updating', message: msg('code_bridge_updating', input.lang) }
        }
        let fix: { updated: boolean; notice: string | null } | null = null
        try { fix = await deps.repairOutdatedBridge(outdated, input.lang) } catch { fix = null }
        if (fix?.notice) {
          record('system', fix.notice)
          yield { type: 'notice', code: 'code_bridge_update_result', message: fix.notice }
        }
        if (fix?.updated) {
          const again = deps.enqueue({ project: input.projectRef, prompt: input.prompt ?? input.message, requestedBy: input.requestedBy, chatId: input.chatId ?? null })
          if (again.ok) {
            taskId = again.id
            lastStatus = ''
            continue
          }
        }
      }
      const quiet = !!codeBridgeContinuable(task) && !!deps.canContinueElsewhere?.()
      yield* finishedEvents(task, input.lang, quiet ? () => { /* continued elsewhere */ } : record)
      return
    }

    if (deps.now() - start > timeoutMs) {
      // Nem hagyjuk oroktol fogva nyitva a chat-kapcsolatot: a munka a
      // hattérben tovabb mehet, a Kod-hidon kovetheto -- ES a kesve erkezo
      // valasz is bekerul a beszelgetesbe (kulonben sehol nem latszana a chatben).
      const m = msg('code_bridge_timeout', input.lang, { id: taskId })
      record('system', m)
      void followInBackground(taskId, deps, input.lang, record)
      // NEM mondjuk kesznek (Boss, 2026-09-29: "ne mutassa nekem itt hogy kesz
      // ha meg nincs keszen"): se zold pipa, se `done`. A folyam `done` nelkul
      // zarul, a felulet a szervert kerdezi, ami a meg futo feladat miatt
      // "fut"-ot mond -- a chat figyel tovabb, az uj uzenet sorba all.
      yield { type: 'notice', code: 'code_bridge_timeout', message: m }
      return
    }

    await deps.sleep(pollMs, input.signal)
  }
}

/** Egy lezarult feladat esemenyei + naplo-sora. */
/** A limit-szoveg rovid: egy hosszu, valodi valasz, ami csak idez egy
 *  limit-mondatot, nem limit. */
const LIMIT_TEXT_MAX_CHARS = 400

/**
 * A kod-hid (VS Code) fiokja kimerult-e (kanban #434). A worker nem mondja meg,
 * melyik fiokkal fut, ezert a feladat SAJAT kimenetebol olvassuk ki: a Claude
 * Code a limitnel "You've hit your weekly limit · resets ..." szoveggel zar --
 * hol eredmenykent (`done`), hol hibakent (`error`). Ilyenkor a hivo masik
 * fiokkal, a helyi munkamenettel folytathatja.
 */
export function codeBridgeLimitDetail(task: CodeBridgeTaskView): string | null {
  if (task.status !== 'done' && task.status !== 'error') return null
  const text = task.status === 'done'
    ? (task.result ?? task.summary ?? '').trim()
    : codeBridgeErrorDetail(task)
  if (!text || text.length > LIMIT_TEXT_MAX_CHARS) return null
  return detectsUsageLimit(text) ? text : null
}

/** The worker stopped the run without an answer (its own time limits:
 *  "timed out after N s" / "no progress for N s"). Not the owner's Stop. */
export function codeBridgeStallDetail(task: CodeBridgeTaskView): string | null {
  if (task.status !== 'error') return null
  const text = codeBridgeErrorDetail(task)
  return /\btimed out after\b|\bno progress for\b/i.test(text) ? text : null
}

/** The worker's Claude Code is too old for the requested model ("Claude Code
 *  2.1.226 does not support this model; version 2.1.280 or newer is required").
 *  Not a quota problem and not the owner's mistake: the run never started. */
export function codeBridgeOutdatedDetail(task: CodeBridgeTaskView): string | null {
  if (task.status !== 'error') return null
  const text = codeBridgeErrorDetail(task)
  if (!text || text.length > LIMIT_TEXT_MAX_CHARS) return null
  return /does not support this model|or newer is required/i.test(text) ? text : null
}

/** A limit, an outdated worker or a stalled run: the work was NOT finished and another account
 *  can take it over (Boss, 2026-09-29: "Az elso dolog az legyen, hogy megnezi,
 *  hogy milyen masik fiokban van limit es tud dolgozni"). */
export function codeBridgeContinuable(task: CodeBridgeTaskView): 'limit' | 'outdated' | 'stalled' | null {
  if (codeBridgeLimitDetail(task)) return 'limit'
  if (codeBridgeOutdatedDetail(task)) return 'outdated'
  if (codeBridgeStallDetail(task)) return 'stalled'
  return null
}

function* finishedEvents(
  task: CodeBridgeTaskView,
  lang: Lang,
  record: (role: 'user' | 'assistant' | 'system', content: string) => void,
): Generator<OrchestratorEvent> {
  const limit = codeBridgeLimitDetail(task)
  if (limit) {
    // Nem valasz: a limit-mondat nem kerulhet a beszelgetesbe valaszkent.
    const m = msg('code_bridge_limit', lang, { detail: limit })
    record('system', m)
    yield { type: 'tool', name: 'code-bridge', status: 'error' }
    yield { type: 'error', code: 'code_bridge_limit', message: m }
    return
  }
  if (task.status === 'done') {
    yield { type: 'tool', name: 'code-bridge', status: 'ok' }
    const answer = (task.result ?? task.summary ?? '').trim()
    if (answer) {
      record('assistant', answer)
      yield { type: 'text', text: answer }
    } else {
      const m = msg('code_bridge_done_empty', lang)
      record('system', m)
      yield { type: 'notice', code: 'code_bridge_done_empty', message: m }
    }
    yield { type: 'done', model: null }
    return
  }
  if (task.status === 'error') {
    const detail = codeBridgeErrorDetail(task)
    const m = detail ? msg('code_bridge_error_detail', lang, { detail }) : msg('code_bridge_error', lang)
    record('system', m)
    yield { type: 'tool', name: 'code-bridge', status: 'error' }
    const code = codeBridgeStallDetail(task) ? 'code_bridge_stalled'
      : codeBridgeOutdatedDetail(task) ? 'code_bridge_outdated' : 'code_bridge_error'
    yield { type: 'error', code, message: m }
    return
  }
  const m = msg('code_bridge_cancelled', lang)
  record('system', m)
  yield { type: 'tool', name: 'code-bridge', status: 'ok' }
  yield { type: 'notice', code: 'code_bridge_cancelled', message: m }
  yield { type: 'done', model: null }
}

/** Egy LEZARULT feladat vegeredmenyenek naplo-sora (valasz, hiba vagy
 *  leallitas) -- ugyanaz a szoveg, amit az elo fordulo is beirna. */
export function recordCodeBridgeOutcome(
  task: CodeBridgeTaskView,
  lang: Lang,
  record: (role: 'user' | 'assistant' | 'system', content: string) => void,
): void {
  if (task.status !== 'done' && task.status !== 'error' && task.status !== 'cancelled') return
  for (const _ of finishedEvents(task, lang, record)) { /* csak a naplo-sor kell */ }
}

/** A chat mar nem var, de a feladat vegeredmenye meg a beszelgetesbe kerul. */
async function followInBackground(
  id: string,
  deps: CodeBridgeTurnDeps,
  lang: Lang,
  record: (role: 'user' | 'assistant' | 'system', content: string) => void,
): Promise<void> {
  const until = deps.now() + (deps.backgroundMs ?? DEFAULT_BACKGROUND_MS)
  const poll = deps.pollMs ?? BACKGROUND_POLL_MS
  try {
    while (deps.now() < until) {
      await deps.sleep(poll)
      const task = deps.getTask(id)
      if (!task) return
      if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
        if (deps.wasContinued?.(id)) return
        // A limit / stalled end belongs to the completion hook: it either hands
        // the work to another account or writes the real reason (it always runs,
        // restarts included). Recording it here too would race the hook.
        if (deps.wasContinued && codeBridgeContinuable(task)) return
        recordCodeBridgeOutcome(task, lang, record)
        return
      }
    }
  } catch { /* hatterben: a hiba nem dobhat ki a szerverbol */ }
}
