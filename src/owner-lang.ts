// The owner's language on the channel (Telegram etc.) follows the INSTALL
// language, never a literal. Owner, 2026-09-27: "hogyha egy angol ember
// tölti le a Marvin-t és telepíti frissen, újonnan, annak nehogy magyar
// nyelvű üzenet menjen a telegramra, hanem annak menjen angol."
//
// Every text that goes to the owner's channel from server code is written as
// ol(hu, en). The guard test (owner-alert-language.test.ts) rejects a bare
// string literal handed to an owner-notify function.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { APP_LANG, PROJECT_ROOT } from './config.js'

export type OwnerLang = 'hu' | 'en'

/** 'en' for an English install ("en", "en-US"), otherwise 'hu' -- the same
 *  rule as readInstallLang()'s hook-side twin (_norm_lang). */
export function ownerLang(raw: string = APP_LANG): OwnerLang {
  return raw.trim().toLowerCase().startsWith('en') ? 'en' : 'hu'
}

/** Pick the owner-facing text in this install's language. */
export function ol(hu: string, en: string, lang: OwnerLang = ownerLang()): string {
  return lang === 'en' ? en : hu
}

// --- UI strings for server-side replies ------------------------------------
// Errors that carry an `errorKey` (CodeBridgeError and friends) already have a
// translated sentence in web/lang/<lang>.js, because the dashboard shows them.
// A channel reply (Telegram) must use the SAME sentence in the install
// language instead of the raw English `error` -- otherwise a Hungarian owner
// gets English on Telegram and an English owner gets a half-Hungarian one.
const uiTables: Partial<Record<OwnerLang, Record<string, string> | null>> = {}

function uiTable(lang: OwnerLang): Record<string, string> | null {
  if (lang in uiTables) return uiTables[lang] ?? null
  let table: Record<string, string> | null = null
  try {
    const src = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
    const sandbox: { window: { _i18n?: Record<string, Record<string, string>> } } = { window: {} }
    runInNewContext(src, sandbox, { timeout: 1000 })
    table = sandbox.window._i18n?.[lang] ?? null
  } catch {
    table = null
  }
  uiTables[lang] = table
  return table
}

/** The dashboard's own translation of `key` in the owner's language, with
 *  `{name}` params filled in; `fallback` when the key (or the lang file) is
 *  missing -- never an empty string. */
export function uiString(
  key: string | undefined,
  params: Record<string, string | number> | undefined,
  fallback: string,
  lang: OwnerLang = ownerLang(),
): string {
  const tpl = key ? uiTable(lang)?.[key] : undefined
  if (!tpl) return fallback
  return tpl.replace(/\{(\w+)\}/g, (m, name: string) =>
    params && name in params ? String(params[name]) : m)
}
