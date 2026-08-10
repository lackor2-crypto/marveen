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

// Free model to use for translation (Nemotron 3 Ultra - this agent's model)
const TRANSLATION_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Language detection patterns (simple, fast, no external deps)
const HUNGARIAN_PATTERNS = [
  /\b(a|az|egy|és|vagy|de|hogy|mint|nem|van|volt|lesz|lenne|kell|kellene|lehet|szokott)\b/i,
  /\b(en|te|ő|mi|ti|ők|magam|magad|maga|magunk|magatok|maguk)\b/i,
  /\b(ezt|azt|ezt|amit|ami|aki|ahol|amikor|miért|hogyan|mennyi)\b/i,
  /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/,
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

  // Hungarian has distinctive chars, give it a boost
  if (/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(sample)) huScore += 5
  if (/[äöüßÄÖÜẞ]/.test(sample)) deScore += 5

  const max = Math.max(huScore, deScore, enScore)
  if (max === 0) return 'unknown'
  if (max === huScore) return 'hu'
  if (max === deScore) return 'de'
  return 'en'
}

function cacheKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
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
  // Replace block elements with newlines
  let text = html
    .replace(/<\/(div|p|br|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

// Build translation prompt
function buildTranslationPrompt(sourceText: string, sourceLang: string): string {
  const langNames: Record<string, string> = { de: 'német', en: 'angol', unknown: 'ismeretlen' }
  const sourceLangName = langNames[sourceLang] || sourceLang
  return `Fordítsd le az alábbi ${sourceLangName} nyelvű e-mail tartalmát magyarra. Csak a fordítást add vissza, semmi mást (nincs bevezető, nincs magyarázat, nincs formázás). Ha a szöveg már magyar, írd vissza változatlanul.

--- KEZDET ---
${sourceText}
--- VÉGE ---`
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
  apiKey: string
): Promise<{ translation: string; sourceLang: string; fromCache: boolean }> {
  // Use HTML if available (richer), otherwise text
  const sourceContent = html && html.trim() ? stripHtmlForTranslation(html) : (text || '').trim()
  if (!sourceContent) {
    return { translation: '', sourceLang: 'unknown', fromCache: false }
  }

  // Detect language
  const sourceLang = detectLanguage(sourceContent)
  if (sourceLang === 'hu') {
    // Already Hungarian -- return original (HTML preferred for display)
    return { translation: html && html.trim() ? html : text, sourceLang: 'hu', fromCache: false }
  }

  // Check cache
  const key = cacheKey(sourceContent)
  const cached = readCache(key)
  if (cached) {
    return { translation: cached.translation, sourceLang: cached.meta.sourceLang, fromCache: true }
  }

  // Translate
  const prompt = buildTranslationPrompt(sourceContent, sourceLang)
  let translation: string
  try {
    translation = await callTranslationApi(prompt, apiKey)
  } catch (e) {
    logger.warn(`[email-translate] translation failed: ${e instanceof Error ? e.message : e}`)
    // Fallback: return original with note
    translation = `[Fordítás sikertelen: ${e instanceof Error ? e.message : 'ismeretlen hiba'}]\n\n${sourceContent}`
  }

  // Cache result
  writeCache(key, translation, {
    sourceLang,
    sourceLength: sourceContent.length,
    createdAt: Date.now(),
    model: TRANSLATION_MODEL,
  })

  return { translation, sourceLang, fromCache: false }
}

// For testing: expose internals
export const _internal = { detectLanguage, stripHtmlForTranslation, buildTranslationPrompt, cacheKey, readCache, writeCache, pruneCache }