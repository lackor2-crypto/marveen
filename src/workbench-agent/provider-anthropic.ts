/**
 * ANTHROPIC PROVIDER (kanban #336, 2. fazis, spec 7 + 0.2 + 20).
 *
 * EGY UT: A TULAJDONOS SAJAT ELOFIZETESE (`claude -p`, a fiok OAuth-loginjaval).
 * Ez az, ami a spec 0.2-t egyaltalan ertelmesse teszi: a kozos 5 oras keretet
 * CSAK az elofizetes-alapu hivas fogyasztja, tehat csak ezt van ertelme egy
 * kozos UsageManagerrel kapuzni. A telepites kimondott szabalya is ez
 * (`life-inbox-ai.ts`: "Never a paid API").
 *
 * A korabbi masodik ut (sajat Anthropic API-kulcs, `WORKBENCH_ANTHROPIC_API_KEY`)
 * a tulajdonos dontesere (#404, TG 6527 "1A") TELJESEN kikerult: nincs
 * beallitas, nincs mezo, nincs fizetos hivas. Egy korabban eltarolt kulcsot a
 * beallitas-tar ismeretlen kulcskent figyelmen kivul hagy. A `via: api_key`
 * tipus (provider.ts) es a megjelenitese MARAD: a regi beszelgetes-sorok igy
 * olvashatok maradnak, uj ilyen sor nem keletkezik.
 *
 * MODELL: configbol (`WORKBENCH_MODEL`, alapbol a telepites sajat
 * alapertelmezett modellje). Semmi beegetett modell-id.
 *
 * A gyerekfolyamat kornyezetebol ugyanazokat a valtozokat vesszuk ki, mint a
 * `life-inbox-ai.ts`: egy CLI-hivas nem csuszhat at egy fizetos vegpontra
 * csak azert, mert a kornyezetben ott felejtettek egy kulcsot.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_AGENT_ID, DEFAULT_AGENT_MODEL } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { tryResolveFromPath } from '../platform.js'
import { resolveAgentConfigDir } from '../web/claude-plans.js'
import { workbenchAccounts } from './accounts.js'
import type { AIAvailability, AICallRequest, AIChunk, AIProvider, AIVia } from './provider.js'

/** Egy valasz felso hatara. Egy interaktiv beszelgetes-fordulo, nem konyv. */
const CALL_TIMEOUT_MS = 180_000

/** Amit egy CLI-hivas kornyezetebol kiveszunk (fizetos/idegen vegpont ellen). */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'OPENROUTER_API_KEY',
]

/** A configbol jovo modell. Ures beallitas = a telepites alapertelmezettje. */
export function workbenchModel(): string {
  const v = String(getEffectiveSettingValue('WORKBENCH_MODEL') ?? '').trim()
  return v || DEFAULT_AGENT_MODEL
}

/** A fo agens Claude-configkonyvtara, ha van bejelentkezes. `null`, ha nincs. */
export function loggedInConfigDir(agent = MAIN_AGENT_ID): string | null {
  try {
    const dir = resolveAgentConfigDir(agent).configDir || join(homedir(), '.claude')
    return existsSync(join(dir, '.credentials.json')) ? dir : null
  } catch {
    return null
  }
}

/** Egy kimenet-sor a CLI stream-json modjabol -> szovegdarab, ha van benne. */
export function textFromStreamLine(line: string): { text?: string; whole?: boolean; done?: boolean; limit?: boolean; error?: string } | null {
  const s = line.trim()
  if (!s) return null
  let j: any
  try { j = JSON.parse(s) } catch { return null }
  if (!j || typeof j !== 'object') return null
  // Reszleges darab (--include-partial-messages).
  if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && typeof j.event.delta?.text === 'string') {
    return { text: j.event.delta.text }
  }
  if (j.type === 'content_block_delta' && typeof j.delta?.text === 'string') return { text: j.delta.text }
  // Egesz asszisztens-uzenet. `whole`: a --include-partial-messages mellett
  // ugyanez a szoveg MAR megjott darabokban -- a hivo dont (#401).
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    const text = j.message.content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('')
    return text ? { text, whole: true } : null
  }
  // Zaro sor.
  if (j.type === 'result') {
    if (j.is_error && typeof j.result === 'string' && /\blimit\b/i.test(j.result)) return { limit: true }
    if (j.is_error) return { error: typeof j.result === 'string' ? j.result : 'unknown error' }
    return { done: true }
  }
  return null
}

/**
 * A CLI a --include-partial-messages mellett MINDKETTOT kuldi: a darabokat
 * (content_block_delta) ES a zaro egesz uzenetet ({type:'assistant'}). Ha
 * mindkettot tovabbadjuk, a valasz duplan jon, es a tool-hivas JSON-ja
 * ertelmezhetetlen lesz (#401). Az egesz uzenet csak akkor megy tovabb, ha
 * elotte egyetlen darab sem jott hozza (delta nelkuli futas = tartalek).
 */
export function makeCliTextFilter(): (ev: { text?: string; whole?: boolean }) => string | null {
  let deltaSinceWhole = false
  return (ev) => {
    if (!ev.text) return null
    if (!ev.whole) { deltaSinceWhole = true; return ev.text }
    const dup = deltaSinceWhole
    deltaSinceWhole = false
    return dup ? null : ev.text
  }
}

/** A promptba fuzott beszelgetes: a CLI egy bemenetet kap. */
export function renderConversation(req: AICallRequest): string {
  const lines: string[] = []
  for (const m of req.messages) {
    lines.push(m.role === 'user' ? `USER:\n${m.content}` : `ASSISTANT:\n${m.content}`)
  }
  lines.push('ASSISTANT:')
  return lines.join('\n\n')
}

type Spawner = typeof spawn

let spawner: Spawner = spawn
/** Csak teszthez: a gyerekfolyamat-inditas cserelese. `null` visszaallitja. */
export function setSpawnerForTest(s: Spawner | null): void { spawner = s || spawn }

async function* streamViaCli(req: AICallRequest, configDir: string, model: string, via: AIVia): AsyncIterable<AIChunk> {
  const bin = tryResolveFromPath('claude')
  if (!bin) {
    yield { kind: 'error', code: 'not_configured', detail: 'claude CLI not found on PATH' }
    return
  }
  const cwd = mkdtempSync(join(tmpdir(), 'marveen-workbench-'))
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
  for (const k of STRIPPED_ENV) delete env[k]
  const args = [
    '-p', '--model', model,
    '--tools', '', '--setting-sources', 'project', '--no-session-persistence',
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--system-prompt', req.system,
  ]

  const child = spawner(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const queue: AIChunk[] = []
  let resolveWait: (() => void) | null = null
  let finished = false
  let sawText = false
  let stderr = ''

  const push = (c: AIChunk): void => { queue.push(c); resolveWait?.(); resolveWait = null }
  const finish = (): void => { finished = true; resolveWait?.(); resolveWait = null }

  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* mar halott */ } }, CALL_TIMEOUT_MS)
  const onAbort = (): void => { try { child.kill('SIGKILL') } catch { /* mar halott */ } }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  let buf = ''
  const pickText = makeCliTextFilter()
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf-8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const ev = textFromStreamLine(line)
      if (!ev) continue
      if (ev.text) {
        const text = pickText(ev)
        if (text) { sawText = true; push({ kind: 'text', text }) }
      } else if (ev.limit) push({ kind: 'error', code: 'limit', detail: 'the provider reported its usage limit' })
      else if (ev.error) push({ kind: 'error', code: 'failed', detail: ev.error })
    }
  })
  child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr += d.toString('utf-8') })
  child.on('error', (e: Error) => { push({ kind: 'error', code: 'failed', detail: e.message }); finish() })
  child.on('close', () => {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onAbort)
    try { rmSync(cwd, { recursive: true, force: true }) } catch { /* mar nincs */ }
    if (sawText) push({ kind: 'done', model, via })
    // SOSE talalgatjuk az okot: ami a stderr-ben all, azt adjuk tovabb.
    else push({ kind: 'error', code: 'no_answer', detail: stderr.trim().slice(0, 500) || 'the provider produced no output' })
    finish()
  })
  child.stdin?.end(renderConversation(req))

  while (true) {
    while (queue.length) {
      const c = queue.shift() as AIChunk
      yield c
      if (c.kind === 'done' || c.kind === 'error') { if (finished && !queue.length) return }
    }
    if (finished) return
    await new Promise<void>((r) => { resolveWait = r })
  }
}

export const anthropicProvider: AIProvider = {
  id: 'anthropic',

  model(): string { return workbenchModel() },

  availability(): AIAvailability {
    const dir = loggedInConfigDir()
    if (dir || workbenchAccounts().length) return { available: true, detail: 'signed-in Claude account' }
    return { available: false, reason: 'not_configured', detail: 'no signed-in Claude account' }
  },

  stream(req: AICallRequest): AsyncIterable<AIChunk> {
    const model = workbenchModel()
    const account = String(req.account || '').trim() || MAIN_AGENT_ID
    const dir = loggedInConfigDir(account)
    if (!dir) {
      return (async function* () {
        yield { kind: 'error', code: 'not_configured', detail: 'no signed-in Claude account' } as AIChunk
      })()
    }
    return streamViaCli(req, dir, model, { kind: 'account', account })
  },

  accounts(): string[] {
    return workbenchAccounts()
  },
}
