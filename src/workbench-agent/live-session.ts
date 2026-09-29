/**
 * A MUNKAPAD CHAT ALLANDO, ELO MUNKAMENETE (kanban #434, C opcio).
 *
 * Boss (2026-09-28, TG 1809): "558 masodperc ota dolgozik. Ha meg itt irom
 * neked a telegramon, 10 masodperc mulva valaszolsz." Mert: a kod-hid minden
 * uzenetre UJ `claude.exe -p --resume` folyamatot inditott a Windows gepen, a
 * valaszt csak a legvegen, egyben adta vissza (`--output-format json`), es
 * kozben ket reteg pollozott. Boss dontese (TG 1819, "A"): a profik modja --
 * egy beszelgetes = EGY folyamatosan futo Claude Code folyamat streaming
 * bemenettel (`--input-format stream-json`), a valasz szavankent folyik a
 * chatbe, a lepesekkel egyutt, es CSAK a chatbe (Telegramra nem).
 *
 * Merve (2026-09-28, ugyanezen a gepen): allo folyamatnal az elso valasz
 * 4,5 mp (inditassal egyutt), a masodik uzenetre 1,2 mp.
 *
 * Elszigeteles (a hiba itt csendes es kulso lenne, ezert kotelezo):
 *  - `--setting-sources ''`: SEMMILYEN user/projekt beallitas nem toltodik be.
 *    A fo agens config-konyvtaraban a Telegram plugin es a csatorna-hookok
 *    (inbox-drain, stop-drain, progress-tukor) elnek; egy masodik peldanyuk a
 *    tulajdonos Telegram-uzeneteit es a fo agens inboxat vinne el.
 *  - `--strict-mcp-config` MCP-konfig nelkul: nincs MCP szerver (Telegram sem).
 *  - `--settings`: a flotta sablonjabol CSAK a PreToolUse ORHOOKOK (elo fa,
 *    skill-scope, ingyenes agens, fajl-igenyles, audit) + a flotta
 *    engedely-modja -- ugyanaz a vedelem, ami minden agensnek jar.
 *
 * A modul dep-injektalt (spawn / now / fajl-tar), hogy valodi CLI nelkul,
 * determinisztikusan teszthelheto legyen.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { OrchestratorEvent } from './orchestrator.js'
import { msg, type Lang } from './messages.js'
import { detectsUsageLimit } from '../model-fallback.js'

/** Tetlen folyamatot ennyi ido utan leallitunk (a kovetkezo uzenet folytatja). */
export const LIVE_IDLE_MS = 30 * 60 * 1000
/** Egyszerre legfeljebb ennyi allo folyamat; a legregebben hasznalt all le. */
export const LIVE_MAX_SESSIONS = 4

/** Egy stream-json kimeneti sor -> chat-esemenyek. */
export interface StreamState {
  /** tool_use id -> eszkoz neve (a tool_result csak az id-t hozza). */
  toolNames: Map<string, string>
  /** Volt-e mar szoveg ebben a fordulban (bekezdes-hatar a kovetkezo ele). */
  sawText: boolean
  model: string | null
  sessionId: string | null
}

export function newStreamState(): StreamState {
  return { toolNames: new Map(), sawText: false, model: null, sessionId: null }
}

/** A forduló vege: sikeres (`ok`) vagy a CLI szavaval megfogalmazott hiba. */
export type TurnEnd = { ok: true } | { ok: false; detail: string }

/** Egy eszkozhivas rovid, ember-olvashato celja (fajl, parancs, minta). */
export function toolDetail(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (k: string): string => (typeof i[k] === 'string' ? String(i[k]) : '')
  let d = ''
  if (name === 'Bash') d = pick('description') || pick('command')
  else if (name === 'Grep' || name === 'Glob') d = pick('pattern')
  else if (name === 'WebFetch') d = pick('url')
  else if (name === 'WebSearch') d = pick('query')
  else if (name === 'Task' || name === 'Agent') d = pick('description')
  else d = pick('file_path') || pick('notebook_path') || pick('path')
  d = d.replace(/\s+/g, ' ').trim()
  return d.length > 140 ? d.slice(0, 139) + '…' : d
}

/**
 * Egy kimeneti sor feldolgozasa. `events` = a chatnek kimeno esemenyek;
 * `end` = a fordulo lezarult (a `result` sor).
 *
 * A szoveg a `stream_event` szovegdarabjaibol jon (`--include-partial-messages`):
 * a teljes `assistant` uzenet UGYANAZT a szoveget meg egyszer hozza, ezert
 * abbol csak az eszkozhivasokat vesszuk -- kulonben minden mondat duplan allna.
 */
export function mapStreamLine(line: string, st: StreamState): { events: OrchestratorEvent[]; end?: TurnEnd } {
  const out: OrchestratorEvent[] = []
  const s = line.trim()
  if (!s) return { events: out }
  let j: any
  try { j = JSON.parse(s) } catch { return { events: out } }
  if (!j || typeof j !== 'object') return { events: out }

  if (j.type === 'system' && j.subtype === 'init') {
    if (typeof j.session_id === 'string') st.sessionId = j.session_id
    if (typeof j.model === 'string') st.model = j.model
    return { events: out }
  }
  if (j.type === 'stream_event' && j.event && typeof j.event === 'object') {
    const ev = j.event
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && st.sawText) {
      out.push({ type: 'text', text: '\n\n' })
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
      st.sawText = true
      out.push({ type: 'text', text: ev.delta.text })
    }
    return { events: out }
  }
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    if (typeof j.message.model === 'string') st.model = j.message.model
    for (const b of j.message.content) {
      if (b && b.type === 'tool_use' && typeof b.name === 'string') {
        if (typeof b.id === 'string') st.toolNames.set(b.id, b.name)
        out.push({ type: 'tool', name: b.name, status: 'running', detail: toolDetail(b.name, b.input) })
      }
    }
    return { events: out }
  }
  if (j.type === 'user' && Array.isArray(j.message?.content)) {
    for (const b of j.message.content) {
      if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const name = st.toolNames.get(b.tool_use_id)
        if (!name) continue
        st.toolNames.delete(b.tool_use_id)
        out.push({ type: 'tool', name, status: b.is_error ? 'error' : 'ok' })
      }
    }
    return { events: out }
  }
  if (j.type === 'result') {
    if (typeof j.session_id === 'string') st.sessionId = j.session_id
    if (j.is_error || (typeof j.subtype === 'string' && j.subtype !== 'success')) {
      // SOSE talalgatjuk az okot: a CLI sajat szava megy ki.
      const detail = String(j.result || (Array.isArray(j.errors) ? j.errors.join('; ') : '') || j.subtype || 'error').slice(0, 500)
      return { events: out, end: { ok: false, detail } }
    }
    // Ha semmi nem streamelt (pl. a partial-uzenetek kimaradtak), a vegleges
    // valasz akkor se vesszen el.
    if (!st.sawText && typeof j.result === 'string' && j.result.trim()) {
      st.sawText = true
      out.push({ type: 'text', text: j.result })
    }
    return { events: out, end: { ok: true } }
  }
  return { events: out }
}

// ---------------------------------------------------------------------------
// Allo folyamatok

export interface LiveSpawnSpec {
  bin: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface LiveSessionDeps {
  spawn(spec: LiveSpawnSpec): ChildProcess
  now(): number
  /** A folytatashoz eltett munkamenet-azonositok (dashboard-ujrainditas utan is). */
  loadIds(): Record<string, SavedSession>
  saveIds(ids: Record<string, SavedSession>): void
}

/** Egy beszelgetes eltett allapota: a folytatas csak UGYANAZZAL a fiokkal es
 *  mappaval ervenyes (a CLI a fiok config-konyvtaraban, a mappa szerint tarolja). */
export interface SavedSession { sessionId: string; configDir: string; cwd: string }

export interface LiveStartSpec {
  /** A beszelgetes kulcsa (projekt + munkadarab). */
  key: string
  bin: string
  configDir: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** A CLI-nek atadott fix kapcsolok (settings, engedely, modell). */
  baseArgs: string[]
  /** The account (agent id) whose login this session runs on -- named in the
   *  chat when the work moves to another account. */
  account?: string
}

interface Live {
  key: string
  child: ChildProcess
  spec: LiveStartSpec
  lastUsed: number
  /** A stdout-sorok vevoje (a futo fordulo), vagy null. */
  onLine: ((line: string) => void) | null
  /** A folyamat halalanak vevoje (a futo fordulo), vagy null. */
  onExit: ((detail: string) => void) | null
  stderr: string
  dead: boolean
  /** Uj folyamat: a prompt a beszelgetes-elozmennyel indul. */
  fresh: boolean
}

/** A fiok keretenek kifogyasa (`live_limit`) kulon kod: a hivo ilyenkor a
 *  kovetkezo fiokkal probalhatja (#434). Minden mas hiba `live_failed`. */
function failCode(detail: string): 'live_limit' | 'live_failed' {
  return detectsUsageLimit(detail) ? 'live_limit' : 'live_failed'
}

export class LiveSessionPool {
  private sessions = new Map<string, Live>()
  private reaper: NodeJS.Timeout | null = null

  constructor(private deps: LiveSessionDeps) {}

  /** Fut-e allo folyamat ehhez a kulcshoz (teszthez / allapothoz). */
  has(key: string): boolean { return this.sessions.has(key) }

  /** Az allo folyamat leallitasa (Leallitas gomb): a kovetkezo uzenet folytatja. */
  stop(key: string): boolean {
    const l = this.sessions.get(key)
    if (!l) return false
    this.kill(l)
    return true
  }

  stopAll(): void { for (const l of [...this.sessions.values()]) this.kill(l) }

  private kill(l: Live): void {
    l.dead = true
    this.sessions.delete(l.key)
    try { l.child.kill('SIGTERM') } catch { /* mar halott */ }
  }

  private ensureReaper(): void {
    if (this.reaper) return
    this.reaper = setInterval(() => {
      const now = this.deps.now()
      for (const l of [...this.sessions.values()]) {
        if (!l.onLine && now - l.lastUsed > LIVE_IDLE_MS) this.kill(l)
      }
      if (!this.sessions.size && this.reaper) { clearInterval(this.reaper); this.reaper = null }
    }, 60 * 1000)
    this.reaper.unref?.()
  }

  private rememberId(key: string, sessionId: string, spec: LiveStartSpec): void {
    let ids: Record<string, SavedSession> = {}
    try { ids = this.deps.loadIds() || {} } catch { ids = {} }
    const prev = ids[key]
    if (prev && prev.sessionId === sessionId && prev.configDir === spec.configDir && prev.cwd === spec.cwd) return
    ids[key] = { sessionId, configDir: spec.configDir, cwd: spec.cwd }
    try { this.deps.saveIds(ids) } catch { /* a folytatas elvesz, a chat nem */ }
  }

  private forgetId(key: string): void {
    let ids: Record<string, SavedSession> = {}
    try { ids = this.deps.loadIds() || {} } catch { return }
    if (!(key in ids)) return
    delete ids[key]
    try { this.deps.saveIds(ids) } catch { /* nem baj */ }
  }

  /** Az allo folyamat (vagy egy uj, folytatva az eltett munkamenetet). */
  private acquire(spec: LiveStartSpec, resumeAllowed: boolean): Live {
    const cur = this.sessions.get(spec.key)
    if (cur && !cur.dead && cur.spec.configDir === spec.configDir && cur.spec.cwd === spec.cwd) return cur
    if (cur) this.kill(cur)

    // Helyet csinalunk: a legregebben hasznalt TETLEN folyamat all le.
    if (this.sessions.size >= LIVE_MAX_SESSIONS) {
      const idle = [...this.sessions.values()].filter((l) => !l.onLine).sort((a, b) => a.lastUsed - b.lastUsed)
      if (idle[0]) this.kill(idle[0])
    }

    let saved: SavedSession | undefined
    try { saved = (this.deps.loadIds() || {})[spec.key] } catch { saved = undefined }
    const resume = resumeAllowed && saved && saved.configDir === spec.configDir && saved.cwd === spec.cwd ? saved.sessionId : null
    const args = [...spec.baseArgs, ...(resume ? ['--resume', resume] : [])]
    const child = this.deps.spawn({ bin: spec.bin, args, cwd: spec.cwd, env: spec.env })
    const l: Live = {
      key: spec.key, child, spec, lastUsed: this.deps.now(),
      onLine: null, onExit: null, stderr: '', dead: false, fresh: !resume,
    }
    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf-8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        l.onLine?.(line)
      }
    })
    child.stderr?.on('data', (d: Buffer) => { if (l.stderr.length < 4000) l.stderr += d.toString('utf-8') })
    const died = (detail: string): void => {
      if (this.sessions.get(l.key) === l) this.sessions.delete(l.key)
      l.dead = true
      l.onExit?.(detail)
    }
    child.on('error', (e: Error) => died(e.message))
    child.on('close', (code: number | null) => died(l.stderr.trim().slice(-500) || `exit ${code}`))
    this.sessions.set(spec.key, l)
    this.ensureReaper()
    return l
  }

  /**
   * Egy fordulo: az uzenet bemegy az allo folyamatba, az esemenyek elo
   * folynak kifele, amig a `result` sor le nem zarja.
   *
   * `buildPrompt(fresh)`: uj (nem folytatott) folyamatnal a prompt a
   * beszelgetes-elozmennyel es a projekt adataival indul; allo vagy
   * folytatott munkamenetnel eleg a puszta uzenet (a kontextus ott van).
   *
   * Ha egy folytatott munkamenet azonnal elhal (pl. a CLI mar nem talalja),
   * EGYSZER ujraindul elozmennyel -- a chat nem nemulhat el egy elavult id miatt.
   */
  async *turn(spec: LiveStartSpec, buildPrompt: (fresh: boolean) => string, lang: Lang, signal?: AbortSignal): AsyncGenerator<OrchestratorEvent> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const l = this.acquire(spec, attempt === 0)
      const st = newStreamState()
      const queue: OrchestratorEvent[] = []
      let end: TurnEnd | null = null
      let exitDetail: string | null = null
      let wake: (() => void) | null = null
      const poke = (): void => { const w = wake; wake = null; w?.() }

      l.onLine = (line) => {
        const r = mapStreamLine(line, st)
        queue.push(...r.events)
        if (st.sessionId) this.rememberId(spec.key, st.sessionId, spec)
        if (r.end) end = r.end
        poke()
      }
      l.onExit = (detail) => { exitDetail = detail; poke() }
      const onAbort = (): void => { this.kill(l); exitDetail = exitDetail ?? 'aborted'; poke() }
      signal?.addEventListener('abort', onAbort, { once: true })
      l.lastUsed = this.deps.now()

      const wasFresh = l.fresh
      const text = buildPrompt(wasFresh)
      l.fresh = false
      try {
        l.child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
      } catch (e) {
        exitDetail = e instanceof Error ? e.message : String(e)
      }

      let sawAny = false
      try {
        while (true) {
          while (queue.length) { sawAny = true; yield queue.shift() as OrchestratorEvent }
          if (end || exitDetail !== null) break
          await new Promise<void>((r) => { wake = r })
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        l.onLine = null
        l.onExit = null
        l.lastUsed = this.deps.now()
      }

      const fin = end as TurnEnd | null
      if (fin) {
        if (fin.ok) { yield { type: 'done', model: st.model, via: null }; return }
        yield { type: 'error', code: failCode(fin.detail), message: msg('live_session_failed', lang, { detail: fin.detail }) }
        return
      }
      if (signal?.aborted) return
      // A folyamat a valasz elott elhalt. Folytatott munkamenetnel egyszer
      // ujrainditjuk elozmennyel (az eltett id elavult lehet).
      if (attempt === 0 && !sawAny && !wasFresh) { this.forgetId(spec.key); continue }
      yield { type: 'error', code: failCode(String(exitDetail)), message: msg('live_session_failed', lang, { detail: String(exitDetail) }) }
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Valos fuggosegek

/** A flotta sablonjabol a PreToolUse orhookok, a telepites utjaval kitoltve. */
export function guardSettingsJson(templatePath: string, projectRoot: string): string {
  let hooks: unknown[] = []
  let defaultMode = 'bypassPermissions'
  try {
    const t = JSON.parse(readFileSync(templatePath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', projectRoot).replaceAll('{{INSTALL_DIR}}', projectRoot))
    if (Array.isArray(t?.hooks?.PreToolUse)) hooks = t.hooks.PreToolUse
    if (typeof t?.permissions?.defaultMode === 'string') defaultMode = t.permissions.defaultMode
  } catch { /* sablon nelkul is indul, csak orhook nelkul */ }
  return JSON.stringify({ permissions: { defaultMode }, hooks: { PreToolUse: hooks } })
}

export function fileIdStore(path: string): Pick<LiveSessionDeps, 'loadIds' | 'saveIds'> {
  return {
    loadIds: () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}),
    saveIds: (ids) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(ids, null, 2))
    },
  }
}

export function realLiveDeps(storeDir: string): LiveSessionDeps {
  return {
    spawn: (s) => spawn(s.bin, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] }),
    now: () => Date.now(),
    ...fileIdStore(join(storeDir, 'workbench-live-sessions.json')),
  }
}
