import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest } from '../web/routes/static.js'

// Repo root = two levels up from src/__tests__/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Replicate web/app.js t()'s token substitution (same regex + fallback) so the
// i18n default-identity proof needs no browser. The brand tokens are merged in
// app.js before params; here we pass the already-merged token map directly.
function substitute(str: string, tokens: Record<string, string>): string {
  return str.replace(/\{(\w+)\}/g, (_, k) => (tokens[k] != null ? tokens[k] : `{${k}}`))
}

// Stock defaults (BRAND_NAME == BOT_NAME == 'Marveen', slug 'marveen') and a
// distinct brand/agent split, to prove both that a default install is unchanged
// and that a renamed install carries its own names on every touched string.
const DEFAULT_TOKENS = { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen', owner: 'Owner' }
const BRANDED_TOKENS = { brand: 'Acme', bot: 'Nova', agentId: 'nova', owner: 'Geza' }

// Load a real dashboard lang file. The files assign to a `window` global with
// no exports, so shim it, import for the side effect, and read the table back.
async function loadLang(lang: 'en' | 'hu'): Promise<Record<string, string>> {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {}
  await import(/* @vite-ignore */ `../../web/lang/${lang}.js`)
  return (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n[lang]
}

describe('buildManifest brands the PWA manifest, default unchanged', () => {
  const raw = readFileSync(join(REPO_ROOT, 'web', 'manifest.json'), 'utf-8')

  it('keeps the stock name/short_name with the default brand', () => {
    const m = JSON.parse(buildManifest(raw, 'Marveen'))
    expect(m.name).toBe('Marveen Dashboard')
    expect(m.short_name).toBe('Marveen')
  })

  it('serves byte-for-byte the shipped file when brand is the default', () => {
    // The stock default brand must not alter a single byte of the served
    // manifest (guards the trailing-newline / whitespace-reflow regression that
    // a JSON.parse+stringify round-trip would introduce).
    expect(buildManifest(raw, 'Marveen')).toBe(raw)
  })

  it('preserves every non-brand field', () => {
    const m = JSON.parse(buildManifest(raw, 'Marveen'))
    expect(m.description).toBe('AI fleet management dashboard')
    expect(m.start_url).toBe('/')
    expect(m.icons).toHaveLength(2)
  })

  it('substitutes a custom brand into name + short_name only', () => {
    const m = JSON.parse(buildManifest(raw, 'Acme'))
    expect(m.name).toBe('Acme Dashboard')
    expect(m.short_name).toBe('Acme')
    expect(m.description).toBe('AI fleet management dashboard')
  })

  it('leaves input without name/short_name keys untouched', () => {
    expect(buildManifest('{ "other": 1 }', 'Acme')).toBe('{ "other": 1 }')
  })
})

describe('i18n brand tokens keep a stock install byte-identical (en)', () => {
  it('renders the original English strings with default tokens', async () => {
    const en = await loadLang('en')
    expect(substitute(en['updates.brand_subtitle'], DEFAULT_TOKENS)).toBe('Marveen version check')
    expect(substitute(en['agents.marveen_boss'], DEFAULT_TOKENS)).toBe('Marveen & Owner')
    expect(substitute(en['agents.toast.marveen_restarted'], DEFAULT_TOKENS)).toBe('Marveen channels restarted')
    expect(substitute(en['agents.confirm.hard_restart'], DEFAULT_TOKENS)).toBe(
      'Hard restart the marveen-channels session. The ongoing Marveen conversation will be lost (memory is preserved). Continue?',
    )
    expect(substitute(en['settings.desc.DASHBOARD_PUBLIC_URL'], DEFAULT_TOKENS)).toContain('https://marveen.example.com')
    expect(substitute(en['connectors.builtin.computer_use_html'], DEFAULT_TOKENS)).toContain('not by Marveen.')
    expect(substitute(en['connectors.builtin.chrome_html'], DEFAULT_TOKENS)).toContain('Marveen sub-agent launches')
  })

  it('carries the brand/agent names with non-default tokens and drops Marveen', async () => {
    const en = await loadLang('en')
    expect(substitute(en['agents.marveen_boss'], BRANDED_TOKENS)).toBe('Nova & Geza')
    expect(substitute(en['updates.brand_subtitle'], BRANDED_TOKENS)).toBe('Acme version check')
    const restart = substitute(en['agents.confirm.hard_restart'], BRANDED_TOKENS)
    expect(restart).toContain('nova-channels')
    expect(restart).toContain('Nova conversation')
    expect(restart).not.toMatch(/marveen/i)
    expect(substitute(en['connectors.builtin.computer_use_html'], BRANDED_TOKENS)).not.toMatch(/marveen/i)
    expect(substitute(en['settings.desc.DASHBOARD_PUBLIC_URL'], BRANDED_TOKENS)).toContain('https://nova.example.com')
  })
})

describe('i18n brand tokens keep a stock install byte-identical (hu)', () => {
  it('renders the original Hungarian strings with default tokens', async () => {
    const hu = await loadLang('hu')
    expect(substitute(hu['updates.brand_subtitle'], DEFAULT_TOKENS)).toBe('Marveen verzió ellenőrzés')
    expect(substitute(hu['agents.marveen_boss'], DEFAULT_TOKENS)).toBe('Marveen & Owner')
    expect(substitute(hu['agents.toast.marveen_restarted'], DEFAULT_TOKENS)).toBe('Marveen channels újraindítva')
    expect(substitute(hu['agents.confirm.hard_restart'], DEFAULT_TOKENS)).toBe(
      'Hard restart a marveen-channels session-ön. A folyamatban lévő Marveen beszélgetés elveszik (memória megmarad). Folytatod?',
    )
  })

  it('carries the brand/agent names with non-default tokens and drops Marveen', async () => {
    const hu = await loadLang('hu')
    expect(substitute(hu['agents.marveen_boss'], BRANDED_TOKENS)).toBe('Nova & Geza')
    expect(substitute(hu['updates.brand_subtitle'], BRANDED_TOKENS)).toBe('Acme verzió ellenőrzés')
    expect(substitute(hu['agents.confirm.hard_restart'], BRANDED_TOKENS)).not.toMatch(/marveen/i)
  })
})
