/**
 * The Settings-side setup wizard.
 *
 * It exists because the portability sweep created a second failure mode: once a
 * value moves out of the source and into .env, the feature stops being wrong on
 * other machines and starts being silently inert instead, with nothing telling
 * the operator it exists. Boss, 2026-08-11: "vajon a marveen rendszer szolni
 * fog hogy ez nincs beallitva es hogy itt alitsd be? [...] mindent amit tud a
 * marveen de meg nincs beallitva!"
 *
 * These tests pin the two properties that make it trustworthy: it classifies
 * this install honestly, and it never leaks a secret back to the browser.
 */

import { describe, it, expect } from 'vitest'
import { SETUP_ITEMS, buildSetupSummary, writableEnvKeys } from '../web/setup-wizard-registry.js'

const NOTHING_EXTERNAL: Record<string, boolean> = {}

describe('setup registry', () => {
  it('gives every item a stable id and both i18n keys', () => {
    for (const item of SETUP_ITEMS) {
      expect(item.id, 'id').toBeTruthy()
      expect(item.labelKey, `${item.id} labelKey`).toMatch(/^wizard\.item\./)
      expect(item.descKey, `${item.id} descKey`).toMatch(/^wizard\.item\./)
    }
  })

  it('gives every item a plain-language explanation', () => {
    // The user is not a programmer: a label and an empty box is not a setting
    // anyone can fill in. See the user-is-not-a-programmer skill.
    for (const item of SETUP_ITEMS) {
      expect(item.helpKey, `${item.id} needs a plain-language helpKey`).toMatch(/^wizard\.item\./)
    }
  })

  it('tells the operator where to get the value when it comes from elsewhere', () => {
    // Anything obtained from a website or another program must carry steps AND
    // a real link. "See the description" with nothing to click is the failure
    // this replaces.
    for (const item of SETUP_ITEMS) {
      if (!item.stepKeys?.length) continue
      const needsLink = ['claude-auth', 'telegram-token', 'google-oauth', 'drive-folder', 'window-backup-repo', 'github-push-account', 'ollama-url', 'calendar-id']
      if (needsLink.includes(item.id)) {
        expect(item.links?.length, `${item.id} sends the user somewhere but links nowhere`).toBeGreaterThan(0)
      }
    }
  })

  it('gives every writable item a concrete example of what to type', () => {
    for (const item of SETUP_ITEMS) {
      if (item.kind === 'external') continue
      expect(item.exampleKey || item.placeholder, `${item.id} shows no example value`).toBeTruthy()
    }
  })

  it('assigns every item a priority tier', () => {
    for (const item of SETUP_ITEMS) {
      expect(['essential', 'recommended', 'extra']).toContain(item.tier)
    }
  })

  it('never marks a required item as an extra', () => {
    // The two would contradict each other: required means the install is
    // broken without it, extra means it is safe to ignore.
    for (const item of SETUP_ITEMS) {
      if (item.required) expect(item.tier, `${item.id}`).toBe('essential')
    }
  })

  it('has no duplicate ids or env keys', () => {
    const ids = SETUP_ITEMS.map(i => i.id)
    expect(new Set(ids).size, 'duplicate id').toBe(ids.length)
    const keys = SETUP_ITEMS.filter(i => i.envKey).map(i => i.envKey)
    expect(new Set(keys).size, 'duplicate envKey').toBe(keys.length)
  })

  it('backs every writable item with an env key, and no external one', () => {
    for (const item of SETUP_ITEMS) {
      if (item.kind === 'external') expect(item.envKey, `${item.id}`).toBeUndefined()
      else expect(item.envKey, `${item.id}`).toBeTruthy()
    }
  })

  it('covers the settings the portability sweep made configurable', () => {
    // These are the ones that had been hardcoded. If a later edit drops them
    // from the wizard they become invisible again, which is the whole bug.
    const keys = SETUP_ITEMS.map(i => i.envKey)
    expect(keys).toContain('WINDOW_BACKUP_REPO_URL')
    expect(keys).toContain('GITHUB_PUSH_ACCOUNT')
    expect(keys).toContain('OWNER_NAME')
  })

  it('lets the route write exactly the declared env keys', () => {
    const writable = writableEnvKeys()
    expect(writable.has('WINDOW_BACKUP_REPO_URL')).toBe(true)
    // Not in the registry -> the endpoint must refuse it. .env holds every
    // credential the install owns, so this is an allowlist, not a filter.
    expect(writable.has('DATABASE_URL')).toBe(false)
    expect(writable.has('PATH')).toBe(false)
  })
})

describe('classifying an install', () => {
  it('reports a bare install as missing its required settings', () => {
    const s = buildSetupSummary({}, NOTHING_EXTERNAL)
    expect(s.missingRequired).toBeGreaterThan(0)
    expect(s.items.every(i => !i.configured)).toBe(true)
  })

  it('counts a filled key as configured and hands back its value', () => {
    const s = buildSetupSummary({ OWNER_NAME: 'Géza' }, NOTHING_EXTERNAL)
    const owner = s.items.find(i => i.id === 'owner-name')!
    expect(owner.configured).toBe(true)
    expect(owner.value).toBe('Géza')
  })

  it('treats a whitespace-only value as not configured', () => {
    // "   " in .env is a half-finished edit, not a setting. Counting it as done
    // would tell the operator the install is ready when it is not.
    const s = buildSetupSummary({ OWNER_NAME: '   ' }, NOTHING_EXTERNAL)
    expect(s.items.find(i => i.id === 'owner-name')!.configured).toBe(false)
  })

  it('never returns a secret value, only whether one is set', () => {
    const s = buildSetupSummary({ TELEGRAM_BOT_TOKEN: '123456:REAL-SECRET' }, NOTHING_EXTERNAL)
    const token = s.items.find(i => i.id === 'telegram-token')!
    expect(token.configured).toBe(true)
    expect(token.value, 'a secret must not travel to the browser').toBeUndefined()
    expect(JSON.stringify(s)).not.toContain('REAL-SECRET')
  })

  it('reads external capabilities from the caller, not from .env', () => {
    const s = buildSetupSummary({}, { 'claude-auth': true })
    expect(s.items.find(i => i.id === 'claude-auth')!.configured).toBe(true)
    expect(s.items.find(i => i.id === 'google-oauth')!.configured).toBe(false)
  })

  it('separates "install is broken" from "capability unused"', () => {
    // The distinction is the point: a wizard that nags equally about a missing
    // Claude login and an unset Ollama URL trains the operator to ignore it.
    const s = buildSetupSummary({}, NOTHING_EXTERNAL)
    const required = s.items.filter(i => i.required)
    const optional = s.items.filter(i => !i.required)
    expect(required.length).toBeGreaterThan(0)
    expect(optional.length).toBeGreaterThan(0)
    expect(s.missingRequired).toBe(required.length)
    expect(s.availableUnused).toBe(optional.length)
  })

  it('reports a fully configured install as done', () => {
    const env: Record<string, string> = {}
    for (const item of SETUP_ITEMS) if (item.envKey) env[item.envKey] = 'x'
    const ext: Record<string, boolean> = {}
    for (const item of SETUP_ITEMS) if (item.kind === 'external') ext[item.id] = true
    const s = buildSetupSummary(env, ext)
    expect(s.missingRequired).toBe(0)
    expect(s.availableUnused).toBe(0)
  })

  it('never lets a missing EXTRA raise the alarm level', () => {
    // The regression Boss caught: three unset extras painted the Overview
    // blood-red, which reads as "the system is broken". worstTier is what the
    // UI colours by, so an extras-only gap must stay 'extra'.
    const env: Record<string, string> = {}
    const ext: Record<string, boolean> = {}
    for (const item of SETUP_ITEMS) {
      if (item.tier === 'extra') continue
      if (item.envKey) env[item.envKey] = 'x'
      if (item.kind === 'external') ext[item.id] = true
    }
    const s = buildSetupSummary(env, ext)
    expect(s.missingByTier.essential).toBe(0)
    expect(s.missingByTier.recommended).toBe(0)
    expect(s.missingByTier.extra).toBeGreaterThan(0)
    expect(s.worstTier).toBe('extra')
  })

  it('raises the alarm to essential when a basic setting is missing', () => {
    const s = buildSetupSummary({}, {})
    expect(s.worstTier).toBe('essential')
  })

  it('reports no tier at all once everything is configured', () => {
    const env: Record<string, string> = {}
    const ext: Record<string, boolean> = {}
    for (const item of SETUP_ITEMS) {
      if (item.envKey) env[item.envKey] = 'x'
      if (item.kind === 'external') ext[item.id] = true
    }
    expect(buildSetupSummary(env, ext).worstTier).toBe('none')
  })
})
