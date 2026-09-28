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
 * telepitesen egyformán ott van. Az elo, lepesenkenti tukrozes kesobbi
 * finomitas.
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
  workItem: { title: string; type: string } | null
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
export function buildCodeBridgePrompt(input: CodeBridgePromptInput): string {
  const language = input.lang === 'en' ? 'English' : 'Hungarian'
  const head = [
    '[MARVEEN WORKBENCH CHAT] The owner is talking to you from the chat of the Workbench (Munkapad), not from a terminal. Your final answer is shown in that chat word for word.',
    `Project: ${input.projectName}`,
    `Project folder: ${input.projectFolder ?? '(no folder set for this project)'}`,
    `Work item: ${input.workItem ? `${input.workItem.title} (type: ${input.workItem.type})` : '(none -- project-level chat)'}`,
    `Answer in ${language}, in plain sentences for a non-programmer.`,
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

  yield { type: 'notice', code: 'code_bridge_handed_off', message: msg('code_bridge_handed_off', input.lang, { id: enq.id }) }
  // Latszo folyamatjelzo a chat-panelen (a kod-hid-nezetre mutat a szoveg).
  yield { type: 'tool', name: 'code-bridge', status: 'running' }

  const start = deps.now()
  let lastStatus: CodeBridgeStatus | '' = ''

  for (;;) {
    if (input.signal?.aborted) {
      // Leallitas: a sorban is lezarjuk, hogy a worker ne dolgozzon tovabb
      // egy olyan kerdesen, amire mar senki nem var.
      try { deps.cancel?.(enq.id) } catch { /* a lezaras hibaja nem uj hiba a chatben */ }
      const m = msg('code_bridge_cancelled', input.lang)
      record('system', m)
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      yield { type: 'notice', code: 'code_bridge_cancelled', message: m }
      yield { type: 'done', model: null }
      return
    }

    const task = deps.getTask(enq.id)
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

    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') {
      yield* finishedEvents(task, input.lang, record)
      return
    }

    if (deps.now() - start > timeoutMs) {
      // Nem hagyjuk oroktol fogva nyitva a chat-kapcsolatot: a munka a
      // hattérben tovabb mehet, a Kod-hidon kovetheto -- ES a kesve erkezo
      // valasz is bekerul a beszelgetesbe (kulonben sehol nem latszana a chatben).
      const m = msg('code_bridge_timeout', input.lang, { id: enq.id })
      record('system', m)
      void followInBackground(enq.id, deps, input.lang, record)
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      yield { type: 'notice', code: 'code_bridge_timeout', message: m }
      yield { type: 'done', model: null }
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
    yield { type: 'error', code: 'code_bridge_error', message: m }
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
        recordCodeBridgeOutcome(task, lang, record)
        return
      }
    }
  } catch { /* hatterben: a hiba nem dobhat ki a szerverbol */ }
}
