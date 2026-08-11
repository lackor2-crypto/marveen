// Email translation service -- translates incoming emails (DE/EN -> HU) using
// OpenRouter free models. Caches translations to avoid re-translating the same
// content. Pure logic with I/O only at the API boundary.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'

// Cache directory (per-install, gitignored like himalaya config)
const TRANSLATION_CACHE_DIR = join(homedir(), '.local', 'share', 'marveen-email', 'translation-cache')
const CACHE_MAX_ENTRIES = 5000
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

// Cheap PAID model for translation (Boss 2026-08-10). The former :free model
// shared OpenRouter's account-wide free-tier daily quota (1000/day), which is
// routinely exhausted by the fleet -- once it is, every translate 429s and the
// feature "stops working". A paid model at fractions of a cent per email is
// independent of that quota, so Translate is always available. gpt-4o-mini was
// picked over gemini-flash on a side-by-side: it rendered idiomatic Hungarian
// where flash mistranslated ("shipped" -> "feladtuk").
const TRANSLATION_MODEL = 'openai/gpt-4o-mini'
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Language detection patterns (simple, fast, no external deps)
const HUNGARIAN_PATTERNS = [
  /\b(a|az|egy|és|vagy|de|hogy|mint|nem|van|volt|lesz|lenne|kell|kellene|lehet|szokott)\b/i,
  /\b(en|te|ő|mi|ti|ők|magam|magad|maga|magunk|magatok|maguk)\b/i,
  /\b(ezt|azt|ezt|amit|ami|aki|ahol|amikor|miért|hogyan|mennyi)\b/i,
  /[áéíóőúűÁÉÍÓŐÚŰ]/, // Hungarian-specific: ő, ű (not ö, ü which are also German)
]

const GERMAN_PATTERNS = [
  /\b(der|die|das|und|oder|aber|dass|als|wie|wenn|wo|warum|wieviel|wer|was)\b/i,
  /\b(ich|du|er|sie|es|wir|ihr|sie|mir|dir|ihm|ihr|uns|euch|ihnen)\b/i,
  /\b(ein|eine|einen|einem|eines|mein|dein|sein|ihr|unser|euer|ihr)\b/i,
  /[äöüßÄÖÜẞ]/,
]

const ENGLISH_PATTERNS = [
  /\b(the|and|or|but|that|as|if|when|where|why|how|who|what|which)\b/i,
  /\b(i|you|he|she|it|we|they|me|him|her|us|them|my|your|his|her|its|our|their)\b/i,
  /\b(a|an|is|are|was|were|been|be|have|has|had|do|does|did|will|would|could|should)\b/i,
]

function detectLanguage(text: string): 'hu' | 'de' | 'en' | 'unknown' {
  const sample = text.slice(0, 2000).toLowerCase()
  let huScore = 0, deScore = 0, enScore = 0

  for (const re of HUNGARIAN_PATTERNS) {
    const matches = sample.match(re)
    if (matches) huScore += matches.length
  }
  for (const re of GERMAN_PATTERNS) {
    const matches = sample.match(re)
    if (matches) deScore += matches.length
  }
  for (const re of ENGLISH_PATTERNS) {
    const matches = sample.match(re)
    if (matches) enScore += matches.length
  }

  // Hungarian-specific chars (ő, ű) - not ö, ü which are also German
  if (/[őűŐŰ]/.test(sample)) huScore += 5
  // German-specific chars (ä, ö, ü, ß)
  if (/[äöüßÄÖÜẞ]/.test(sample)) deScore += 5

  const max = Math.max(huScore, deScore, enScore)
  if (max === 0) return 'unknown'
  if (max === huScore) return 'hu'
  if (max === deScore) return 'de'
  return 'en'
}

// The cache key is per (source language, target language, content). Target must
// be in the key so HU and ES results do not collide; SOURCE must be too, or an
// explicit "this is German" request would be answered by an earlier auto-detect
// run that gave up as "unknown" and returned the text barely changed (Boss
// 2026-08-10: picked Nemet -> Magyar, still saw "ismeretlen" and no translation).
function cacheKey(text: string, sourceLang: string, targetLang: string): string {
  return createHash('sha256').update(`${sourceLang}>${targetLang} ${text}`).digest('hex').slice(0, 32)
}

function cachePaths(key: string): { data: string; meta: string } {
  return {
    data: join(TRANSLATION_CACHE_DIR, `${key}.txt`),
    meta: join(TRANSLATION_CACHE_DIR, `${key}.json`),
  }
}

interface CacheMeta {
  sourceLang: string
  sourceLength: number
  createdAt: number
  model: string
}

function ensureCacheDir(): void {
  if (!existsSync(TRANSLATION_CACHE_DIR)) {
    mkdirSync(TRANSLATION_CACHE_DIR, { recursive: true, mode: 0o700 })
  }
}

function readCache(key: string): { translation: string; meta: CacheMeta } | null {
  ensureCacheDir()
  const paths = cachePaths(key)
  if (!existsSync(paths.data) || !existsSync(paths.meta)) return null
  try {
    const meta = JSON.parse(readFileSync(paths.meta, 'utf-8')) as CacheMeta
    // Age check
    if (Date.now() - meta.createdAt > CACHE_MAX_AGE_MS) return null
    const translation = readFileSync(paths.data, 'utf-8')
    return { translation, meta }
  } catch {
    return null
  }
}

function writeCache(key: string, translation: string, meta: CacheMeta): void {
  ensureCacheDir()
  const paths = cachePaths(key)
  try {
    writeFileSync(paths.data, translation, { mode: 0o600 })
    writeFileSync(paths.meta, JSON.stringify(meta), { mode: 0o600 })
    pruneCache()
  } catch (e) {
    logger.warn(`[email-translate] cache write failed: ${e instanceof Error ? e.message : e}`)
  }
}

function pruneCache(): void {
  try {
    const files = readdirSync(TRANSLATION_CACHE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const metaPath = join(TRANSLATION_CACHE_DIR, f)
        const stat = statSync(metaPath)
        let meta: CacheMeta | null = null
        try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')) } catch { /* ignore */ }
        return { metaPath, dataPath: join(TRANSLATION_CACHE_DIR, f.replace(/\.json$/, '.txt')), mtime: stat.mtimeMs, meta }
      })
      .filter(f => f.meta !== null)
      .sort((a, b) => a.mtime - b.mtime)

    // Remove oldest if over limit
    while (files.length > CACHE_MAX_ENTRIES) {
      const oldest = files.shift()
      if (oldest) {
        rmSync(oldest.metaPath, { force: true })
        rmSync(oldest.dataPath, { force: true })
      }
    }
  } catch { /* best-effort */ }
}

// Strip HTML tags for translation (preserve structure markers)
function stripHtmlForTranslation(html: string): string {
  // Remove style and script blocks entirely (including their content)
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    // Replace block elements with newlines
    .replace(/<\/(div|p|br|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    // Collapse only horizontal whitespace, and keep the newlines that the block
    // elements above turned into paragraph breaks. The old `/\s+/ -> ' '` erased
    // exactly those newlines, so the model received one endless line and gave one
    // endless blob back (Boss 2026-08-10: "egy omlesztett valami"). The reader
    // renders the result with white-space: pre-wrap, so these breaks survive to
    // the screen and the translation keeps the original's paragraph shape.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}

// Languages the translator offers, with English names for the model prompt.
// The frontend mirrors this list with localized labels -- keep the codes in
// sync. English names in the prompt because this is open-source and the pair
// is arbitrary (Boss 2026-08-10: an English speaker may need Spanish, or the
// reverse) -- "always to Hungarian" was too narrow.
export const SUPPORTED_TRANSLATION_LANGS: Record<string, string> = {
  hu: 'Hungarian', en: 'English', de: 'German', es: 'Spanish', fr: 'French',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ro: 'Romanian',
  ru: 'Russian', uk: 'Ukrainian', zh: 'Chinese', ja: 'Japanese', tr: 'Turkish',
  ar: 'Arabic',
}

export const DEFAULT_TARGET_LANG = 'hu'

/** Coerce a requested target code to a supported one, defaulting to Hungarian. */
export function resolveTargetLang(code: string | null | undefined): string {
  return code && SUPPORTED_TRANSLATION_LANGS[code] ? code : DEFAULT_TARGET_LANG
}

/** A source override is honored only if it names a language we know. */
function resolveSourceLang(code: string | null | undefined): string {
  return code && SUPPORTED_TRANSLATION_LANGS[code] ? code : 'unknown'
}

// Build translation prompt. The old version ended with "If the text is already
// in X, return it unchanged" -- which made the model lazy on a lone compound or
// a one-word subject and hand the source straight back (Boss 2026-08-10:
// "Einwurf-Einschreiben" came back untranslated). Dropping that clause and
// demanding EVERYTHING be translated makes the same input render reliably.
function buildTranslationPrompt(sourceText: string, sourceLang: string, targetLang: string): string {
  const targetName = SUPPORTED_TRANSLATION_LANGS[targetLang] || 'Hungarian'
  const sourceName = SUPPORTED_TRANSLATION_LANGS[sourceLang]
  const fromClause = sourceName ? `from ${sourceName} ` : ''
  return `You are a professional translator. Translate the email content below ${fromClause}into ${targetName}. Translate EVERYTHING, including single words, compound terms and subject lines; never leave any text in the source language. Output ONLY the ${targetName} translation, with no preamble, no explanation, and no code fences. Preserve line breaks and paragraph structure.

--- BEGIN ---
${sourceText}
--- END ---`
}

// Call OpenRouter API for translation
async function callTranslationApi(prompt: string, apiKey: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)

  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://marveen.local',
        'X-Title': 'Marveen Email Translation',
      },
      body: JSON.stringify({
        model: TRANSLATION_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 4000,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`)
    }

    const data = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('Empty translation response')
    return content.trim()
  } catch (e) {
    clearTimeout(timeout)
    throw e
  }
}

// Main translation function
export async function translateEmailContent(
  text: string,
  html: string,
  apiKey: string,
  opts: { targetLang?: string; sourceLang?: string } = {}
): Promise<{ translation: string; sourceLang: string; targetLang: string; fromCache: boolean }> {
  const targetLang = resolveTargetLang(opts.targetLang)
  // Use HTML if available (richer), otherwise text
  const sourceContent = html && html.trim() ? stripHtmlForTranslation(html) : (text || '').trim()
  if (!sourceContent) {
    return { translation: '', sourceLang: 'unknown', targetLang, fromCache: false }
  }

  // Source language: an explicit override (from the picker) wins over
  // auto-detection; 'auto' or an unknown code falls back to detection.
  const override = opts.sourceLang && opts.sourceLang !== 'auto' ? resolveSourceLang(opts.sourceLang) : null
  const sourceLang = override && override !== 'unknown' ? override : detectLanguage(sourceContent)
  if (sourceLang === targetLang) {
    // Already in the target language -- return original (HTML preferred for display)
    return { translation: html && html.trim() ? html : text, sourceLang, targetLang, fromCache: false }
  }

  // Check cache
  const key = cacheKey(sourceContent, sourceLang, targetLang)
  const cached = readCache(key)
  if (cached) {
    return { translation: cached.translation, sourceLang: cached.meta.sourceLang, targetLang, fromCache: true }
  }

  // Translate
  const prompt = buildTranslationPrompt(sourceContent, sourceLang, targetLang)
  let translation: string
  try {
    translation = await callTranslationApi(prompt, apiKey)
    // One retry when the model handed the source straight back: a firmer nudge
    // reliably gets a real translation for lone terms and one-word subjects.
    if (translation.trim() === sourceContent.trim()) {
      const targetName = SUPPORTED_TRANSLATION_LANGS[targetLang] || 'the target language'
      const retry = await callTranslationApi(
        `${prompt}\n\nThe previous attempt returned the text unchanged. It is NOT ${targetName}; translate it in full now.`,
        apiKey,
      )
      if (retry.trim() && retry.trim() !== sourceContent.trim()) translation = retry
    }
  } catch (e) {
    logger.warn(`[email-translate] translation failed: ${e instanceof Error ? e.message : e}`)
    // Fallback: return original with note. Deliberately NOT cached -- a failure
    // is transient (a 429, a timeout), and caching the error string used to
    // poison that email permanently: every later attempt returned the cached
    // "[Fordítás sikertelen]" instead of retrying once the cause cleared.
    return {
      translation: `[Fordítás sikertelen: ${e instanceof Error ? e.message : 'ismeretlen hiba'}]\n\n${sourceContent}`,
      sourceLang,
      targetLang,
      fromCache: false,
    }
  }

  // A result identical to the input is the model declining to translate -- a
  // lone compound term, a proper noun, a one-word subject -- not a real
  // translation. Return it, but do NOT cache it: caching a no-op pinned the
  // email as permanently untranslated, and a retry (the model is not fully
  // deterministic, and more context often helps) could still succeed (Boss
  // 2026-08-10: "elraktarozta a nemet verziot ... most nem akarja").
  const changed = translation.trim() !== sourceContent.trim()
  if (changed) {
    writeCache(key, translation, {
      sourceLang,
      sourceLength: sourceContent.length,
      createdAt: Date.now(),
      model: TRANSLATION_MODEL,
    })
  }

  return { translation, sourceLang, targetLang, fromCache: false }
}

// For testing: expose internals
export const _internal = { detectLanguage, stripHtmlForTranslation, buildTranslationPrompt, cacheKey, readCache, writeCache, pruneCache }