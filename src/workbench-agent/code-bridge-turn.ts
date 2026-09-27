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
 */
import type { OrchestratorEvent } from './orchestrator.js'
import { msg, type Lang } from './messages.js'

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
}

export interface CodeBridgeTurnInput {
  /** A Munkapad-projekt azonositoja (a kod-hid ebbol oldja fel a workspace-t;
   *  ha nem talal kituzott sessiont, a preamble mondja meg, HOL a munka). */
  projectRef: string
  message: string
  lang: Lang
  requestedBy: string | null
  chatId?: string | null
  signal?: AbortSignal
}

const DEFAULT_POLL_MS = 2000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Egy Munkapad-fordulo a kod-hidon at. Ugyanazokat az esemenyeket adja
 * (`session` kivetelevel, azt a hivo mar kiadta), amiket a projekt-asszisztens.
 */
export async function* runCodeBridgeTurn(
  input: CodeBridgeTurnInput,
  deps: CodeBridgeTurnDeps,
): AsyncGenerator<OrchestratorEvent> {
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const enq = deps.enqueue({
    project: input.projectRef,
    prompt: input.message,
    requestedBy: input.requestedBy,
    chatId: input.chatId ?? null,
  })
  if (!enq.ok) {
    // A feladat nem indult el: a chat a megszokott hiba-mondatot mutatja,
    // nem nemul el.
    yield { type: 'notice', code: 'code_bridge_enqueue_failed', message: msg('code_bridge_enqueue_failed', input.lang, { detail: enq.message }) }
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
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      yield { type: 'notice', code: 'code_bridge_cancelled', message: msg('code_bridge_cancelled', input.lang) }
      yield { type: 'done', model: null }
      return
    }

    const task = deps.getTask(enq.id)
    if (!task) {
      yield { type: 'tool', name: 'code-bridge', status: 'error' }
      yield { type: 'error', code: 'code_bridge_lost', message: msg('code_bridge_lost', input.lang) }
      return
    }

    if (task.status !== lastStatus) {
      lastStatus = task.status
      if (task.status === 'running') {
        yield { type: 'notice', code: 'code_bridge_running', message: msg('code_bridge_running', input.lang) }
      }
    }

    if (task.status === 'done') {
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      const answer = (task.result ?? task.summary ?? '').trim()
      if (answer) yield { type: 'text', text: answer }
      else yield { type: 'notice', code: 'code_bridge_done_empty', message: msg('code_bridge_done_empty', input.lang) }
      yield { type: 'done', model: null }
      return
    }
    if (task.status === 'error') {
      yield { type: 'tool', name: 'code-bridge', status: 'error' }
      const detail = (task.error ?? '').trim()
      yield { type: 'error', code: 'code_bridge_error', message: detail || msg('code_bridge_error', input.lang) }
      return
    }
    if (task.status === 'cancelled') {
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      yield { type: 'notice', code: 'code_bridge_cancelled', message: msg('code_bridge_cancelled', input.lang) }
      yield { type: 'done', model: null }
      return
    }

    if (deps.now() - start > timeoutMs) {
      // Nem hagyjuk oroktol fogva nyitva a chat-kapcsolatot: a munka a
      // hattérben tovabb mehet, a Kod-hidon kovetheto.
      yield { type: 'tool', name: 'code-bridge', status: 'ok' }
      yield { type: 'notice', code: 'code_bridge_timeout', message: msg('code_bridge_timeout', input.lang, { id: enq.id }) }
      yield { type: 'done', model: null }
      return
    }

    await deps.sleep(pollMs, input.signal)
  }
}
