// #796: ONE road for the AI text calls -- OpenRouter's chat endpoint, the local model (Ollama) and the owner's engine
// order. Before, five OpenRouter clients and three Ollama clients each did their own fetch, timeout and error text, so the
// #772 fix (a 402 "can only afford N tokens" answer retried with what the account can afford, a sentence a person can act
// on, the owner's engine order) reached only the email translation. Every caller goes through here now: a fix here is a fix
// everywhere. A source test (ai-call-one-road.test.ts) keeps new direct calls out.
//
// Not here, on purpose: the Workbench assistant's providers run the Claude program against a base URL (the program does
// its own HTTP), the video generation talks to OpenRouter's /videos job API, and the OpenRouter overview reads the
// account endpoints (credits, activity) -- none of them is a chat call.

import { OLLAMA_URL, APP_LANG } from './config.js'

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
/** Below this a 402 retry cannot hold a useful answer: the credit sentence is shown instead. */
export const MIN_RETRY_TOKENS = 300

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean; status: number; text?(): Promise<string>; json?(): Promise<unknown>
}>

/** The answer's body as text, whichever of text() / json() the response offers. */
async function bodyOf(res: { text?(): Promise<string>; json?(): Promise<unknown> }): Promise<string> {
  if (typeof res.text === 'function') return res.text()
  if (typeof res.json === 'function') return JSON.stringify(await res.json())
  return ''
}

let fetchImpl: FetchFn = (url, init) => fetch(url, init)
/** Tests only: replace the network. `null` restores it. */
export function setAiFetch(f: FetchFn | null): void { fetchImpl = f || ((url, init) => fetch(url, init)) }

// ---- errors a person can act on -------------------------------------------------------------------

const ERRORS = {
  credit: { hu: 'az OpenRouter-fiók krediteje elfogyott vagy kevés, töltsd fel: https://openrouter.ai/settings/credits', en: 'the OpenRouter account is out of credit or nearly so, top it up: https://openrouter.ai/settings/credits' },
  nokey: { hu: 'nincs OpenRouter-kulcs megadva', en: 'no OpenRouter key is set' },
  key: { hu: 'az OpenRouter kulcs érvénytelen, ellenőrizd a Beállításokban', en: 'the OpenRouter key is invalid, check it in Settings' },
  busy: { hu: 'az OpenRouter most túlterhelt, próbáld újra egy perc múlva', en: 'OpenRouter is busy right now, try again in a minute' },
  timeout: { hu: 'az OpenRouter nem válaszolt időben', en: 'OpenRouter did not answer in time' },
  empty: { hu: 'az OpenRouter üres választ adott', en: 'OpenRouter gave an empty answer' },
}

/**
 * OpenRouter answers 402 "... You requested up to 4000 tokens, but can only afford 1368" when the account credit is
 * nearly spent. Returns the affordable token count, or null when the text is not that message.
 */
export function affordableTokens(errText: string): number | null {
  const m = /can only afford (\d+)/i.exec(errText)
  return m ? Number(m[1]) : null
}

/** A sentence a person can act on, instead of the raw provider JSON. */
export function openRouterErrorMessage(status: number, errText: string, lang: string = APP_LANG, kind?: 'nokey'): string {
  const pick = (m: { hu: string; en: string }) => (lang === 'hu' ? m.hu : m.en)
  if (kind === 'nokey') return pick(ERRORS.nokey)
  if (status === 402) return pick(ERRORS.credit)
  if (status === 401 || status === 403) return pick(ERRORS.key)
  if (status === 429) return pick(ERRORS.busy)
  return `OpenRouter ${status}: ${errText.slice(0, 120)}`
}

// ---- OpenRouter chat --------------------------------------------------------------------------------

export interface OpenRouterChatInput {
  apiKey: string
  model: string
  prompt: string
  /** A system message before the prompt (none when empty). */
  system?: string
  /** The answer's token ceiling. Without one OpenRouter uses the model's own (a 402 retry then sets one). */
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  /** Shown on OpenRouter's activity page ("Marveen Email Translation"). */
  title: string
  /** This call's network function (a caller's own test double); default: the module's (setAiFetch). */
  fetch?: FetchFn
  /** More request fields (plugins, reasoning, ...). */
  extra?: Record<string, unknown>
  lang?: string
}

export type OpenRouterChatResult =
  | { ok: true; text: string; model: string; tokensIn: number | null; tokensOut: number | null; cost: number | null }
  | { ok: false; status: number; code: 'nokey' | 'credit' | 'key' | 'busy' | 'timeout' | 'network' | 'http'; message: string; detail: string }

/**
 * One chat answer from OpenRouter. A 402 "can only afford N" answer is retried ONCE with that ceiling (when it can still
 * hold a useful answer); every failure comes back as a person-readable `message` plus the raw `detail`.
 */
export async function openRouterChat(input: OpenRouterChatInput): Promise<OpenRouterChatResult> {
  const lang = input.lang ?? APP_LANG
  if (!input.apiKey) return { ok: false, status: 0, code: 'nokey', message: openRouterErrorMessage(0, '', lang, 'nokey'), detail: '' }
  const ask = async (maxTokens: number | undefined, retried: boolean): Promise<OpenRouterChatResult> => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 60_000)
    let status = 0
    let body = ''
    try {
      const res = await (input.fetch ?? fetchImpl)(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
          'HTTP-Referer': 'https://marveen.local',
          'X-Title': input.title,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), { role: 'user', content: input.prompt }],
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(input.extra || {}),
        }),
        signal: ctl.signal,
      })
      status = res.status
      body = await bodyOf(res).catch(() => '')
      if (!res.ok) {
        // Nearly out of credit: refused for the token CEILING, not the text. Once more with what the account can afford.
        const afford = res.status === 402 && !retried ? affordableTokens(body) : null
        if (afford !== null && afford >= MIN_RETRY_TOKENS && (maxTokens === undefined || afford < maxTokens)) {
          clearTimeout(timer)
          return ask(afford - 16, true)
        }
        let raw = body
        try { const j = JSON.parse(body) as { error?: { message?: string } | string }; raw = typeof j.error === 'string' ? j.error : j.error?.message || body } catch { /* not JSON */ }
        const code = res.status === 402 ? 'credit' : res.status === 401 || res.status === 403 ? 'key' : res.status === 429 ? 'busy' : 'http'
        return { ok: false, status: res.status, code, message: openRouterErrorMessage(res.status, raw, lang), detail: raw.slice(0, 500) }
      }
      const data = JSON.parse(body) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } }
      return {
        ok: true,
        text: (data.choices?.[0]?.message?.content ?? '').trim(),
        model: data.model || input.model,
        tokensIn: data.usage?.prompt_tokens ?? null,
        tokensOut: data.usage?.completion_tokens ?? null,
        cost: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
      }
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') return { ok: false, status, code: 'timeout', message: lang === 'hu' ? ERRORS.timeout.hu : ERRORS.timeout.en, detail: `timeout after ${input.timeoutMs ?? 60_000}ms` }
      if (err instanceof SyntaxError) return { ok: false, status, code: 'http', message: openRouterErrorMessage(status, body, lang), detail: body.slice(0, 500) }
      return { ok: false, status, code: 'network', message: `OpenRouter: ${err.message}`, detail: String(err.message || err) }
    } finally {
      clearTimeout(timer)
    }
  }
  return ask(input.maxTokens, false)
}

/** The empty-answer sentence (a 200 with no text), in the owner's language. */
export function openRouterEmptyMessage(lang: string = APP_LANG): string {
  return lang === 'hu' ? ERRORS.empty.hu : ERRORS.empty.en
}

// ---- the local model (Ollama) -----------------------------------------------------------------------

export interface OllamaGenerateInput {
  model: string
  prompt: string
  system?: string
  /** 'json' asks the model for a JSON answer. */
  format?: 'json'
  options?: Record<string, unknown>
  timeoutMs?: number
}

/** One answer from the local model; null when it does not answer (not running, timed out, broken answer). */
export async function ollamaGenerate(input: OllamaGenerateInput): Promise<{ text: string; model: string } | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 90_000)
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model, prompt: input.prompt, stream: false,
        ...(input.system ? { system: input.system } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.options ? { options: input.options } : {}),
      }),
      signal: ctl.signal,
    })
    if (!res.ok) return null
    const j = JSON.parse(await bodyOf(res)) as { response?: unknown }
    return typeof j.response === 'string' ? { text: j.response, model: input.model } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The names of the installed local models; [] when the local model server does not answer. */
export async function ollamaModelNames(timeoutMs = 3000): Promise<string[]> {
  const models = await ollamaModels(timeoutMs)
  return models.map((m) => m.name)
}

/** The installed local models with their size; [] when the local model server does not answer. */
export async function ollamaModels(timeoutMs = 3000): Promise<{ name: string; size?: number }[]> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctl.signal })
    if (!res.ok) return []
    const j = await res.json() as { models?: { name?: unknown; size?: unknown }[] }
    return (j.models || []).filter((m) => typeof m.name === 'string').map((m) => ({ name: m.name as string, size: typeof m.size === 'number' ? m.size : undefined }))
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ---- the owner's engine order --------------------------------------------------------------------------

export type AiEngine = 'openrouter' | 'claude' | 'ollama'
export const DEFAULT_ENGINE_ORDER: AiEngine[] = ['openrouter', 'claude', 'ollama']

/** The owner's engine order (TRANSLATE_ENGINE_ORDER), unknown names dropped, missing ones appended: every engine stays reachable. */
export function parseEngineOrder(raw: string | undefined | null): AiEngine[] {
  const seen: AiEngine[] = []
  for (const part of String(raw ?? '').split(',')) {
    const e = part.trim().toLowerCase()
    if ((e === 'openrouter' || e === 'claude' || e === 'ollama') && !seen.includes(e)) seen.push(e)
  }
  for (const e of DEFAULT_ENGINE_ORDER) if (!seen.includes(e)) seen.push(e)
  return seen
}
