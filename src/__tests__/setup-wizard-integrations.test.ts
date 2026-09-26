/**
 * Every paid/keyed third-party service must reach the setup wizard AND the
 * Overview self-check -- not only the screen that happens to use it.
 *
 * #404, Boss 2026-09-26: the (since removed) Brave web-search key was settable
 * only on the Workbench page, so a fresh install was never walked to it and the self-check
 * never asked about it. "figyelj mindenre, hogyha telepit itt a projekten belul
 * itt valamit, vagy fejlesztodik a projekt, azert az onellenorzes ezt mind
 * figyelje, meg a varazslo" -- and the same will hold for the image, video and
 * voice services still to come. So this is a GUARD, not a list to remember: a
 * new secret or *_API_KEY / *_TOKEN setting without a wizard step fails here.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import { SETUP_ITEMS, overrideStoredKeys, writableEnvKeys, type SetupItemState } from '../web/setup-wizard-registry.js'
import { wizardValues, integrationStates } from '../web/setup-wizard-values.js'
import { integrationRows } from '../web/system-health.js'

/**
 * Keyed settings deliberately NOT in the wizard. Every entry needs a reason;
 * "forgot" is not one.
 */
const EXEMPT: Record<string, string> = {
  CODE_BOT_TOKEN:
    'Configured in the Code bridge window, which has its own walk-through and its own self-check rows (code_bridge_*).',
  TOKEN_USAGE_RETENTION_DAYS: 'Not a credential: a retention period that happens to contain the word TOKEN.',
}

const keyedSettings = SETTINGS_REGISTRY.filter(d =>
  d.secret || /(API_KEY|_TOKEN|_SECRET)(_|$)/.test(d.key))

let hu: Record<string, string>
let en: Record<string, string>
beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

describe('keyed services reach the setup wizard', () => {
  it('every secret / API key / token setting has a wizard step or a written exemption', () => {
    const inWizard = writableEnvKeys()
    const missing = keyedSettings
      .map(d => d.key)
      .filter(k => !inWizard.has(k) && !(k in EXEMPT))
    expect(missing, 'add a SETUP_ITEMS entry (group "integrations") or an EXEMPT reason').toEqual([])
  })

  it('has no stale exemptions', () => {
    const keys = new Set(SETTINGS_REGISTRY.map(d => d.key))
    const inWizard = writableEnvKeys()
    for (const k of Object.keys(EXEMPT)) {
      expect(keys.has(k), `${k} is exempted but no longer a setting`).toBe(true)
      expect(inWizard.has(k), `${k} is exempted but is in the wizard`).toBe(false)
    }
  })

  it('stores a settings-registry key through the override store, never .env', () => {
    // An override wins over .env: a wizard writing .env for such a key would
    // be silently shadowed by what the owning screen saved.
    const registry = new Set(SETTINGS_REGISTRY.map(d => d.key))
    for (const item of SETUP_ITEMS.filter(i => i.group === 'integrations')) {
      expect(item.envKey, item.id).toBeTruthy()
      if (registry.has(item.envKey!)) expect(overrideStoredKeys().has(item.envKey!), item.id).toBe(true)
    }
  })

  it('walks the owner through every integration: steps, links, both languages', () => {
    // Empty today (the Workbench web search needs no key since #404); the
    // check bites the moment an image / video / voice service is added.
    for (const item of SETUP_ITEMS.filter(i => i.group === 'integrations')) {
      expect(item.tier, item.id).toBe('extra')
      expect(item.required, item.id).toBe(false)
      expect((item.stepKeys || []).length, `${item.id} steps`).toBeGreaterThan(0)
      expect((item.links || []).length, `${item.id} links`).toBeGreaterThan(0)
      const keys = [item.labelKey, item.descKey, item.helpKey, ...(item.stepKeys || []),
        ...(item.links || []).map(l => l.labelKey), ...(item.exampleKey ? [item.exampleKey] : [])]
      for (const k of keys) {
        expect(hu[k], `hu ${k}`).toBeTruthy()
        expect(en[k], `en ${k}`).toBeTruthy()
      }
    }
  })

  it('no longer asks for a Brave key anywhere', () => {
    expect(SETTINGS_REGISTRY.some(d => d.key === 'BRAVE_SEARCH_API_KEY')).toBe(false)
    expect(SETUP_ITEMS.some(i => i.envKey === 'BRAVE_SEARCH_API_KEY')).toBe(false)
  })
})

const K = new Set(['SOME_SERVICE_API_KEY'])
const fakeItem = (configured: boolean): SetupItemState => ({
  id: 'some-service', group: 'integrations', kind: 'secret', envKey: 'SOME_SERVICE_API_KEY',
  labelKey: 'x', descKey: 'x', helpKey: 'x', required: false, tier: 'extra', configured,
})

describe('wizard values', () => {
  it('takes an override-stored key from the override store', () => {
    expect(wizardValues({}, { SOME_SERVICE_API_KEY: 'k' }, K).SOME_SERVICE_API_KEY).toBe('k')
  })

  it('lets an emptied override win over a stale .env value', () => {
    expect(wizardValues({ SOME_SERVICE_API_KEY: 'old' }, { SOME_SERVICE_API_KEY: '' }, K).SOME_SERVICE_API_KEY).toBe('')
  })

  it('falls back to .env when no override is set', () => {
    expect(wizardValues({ SOME_SERVICE_API_KEY: 'fromenv' }, {}, K).SOME_SERVICE_API_KEY).toBe('fromenv')
  })

  it('leaves keys that are not override-stored alone', () => {
    expect(wizardValues({ OTHER: 'env' }, { OTHER: 'ov' }, K).OTHER).toBe('env')
  })
})

describe('self-check rows for integrations', () => {
  it('reports a missing integration as a neutral warning, never as red', () => {
    const [r] = integrationRows(() => [fakeItem(false)])
    expect(r).toMatchObject({ id: 'integration_missing', status: 'warn', params: { item: 'some-service' } })
  })

  it('reports a set key as ok', () => {
    expect(integrationRows(() => [fakeItem(true)])[0].status).toBe('ok')
  })

  it('stays silent when there is nothing to integrate', () => {
    expect(integrationRows(() => [])).toEqual([])
    expect(integrationStates({})).toEqual(SETUP_ITEMS.filter(i => i.group === 'integrations').map(() => expect.anything()))
  })

  it('says it could not see, instead of "not set up", when reading fails', () => {
    const rows = integrationRows(() => { throw new Error('unreadable') })
    expect(rows).toEqual([{ id: 'integration_blind', status: 'warn', params: {} }])
  })

  it('has both-language texts for every row it can emit', () => {
    for (const id of ['integration_missing', 'integration_ok', 'integration_blind']) {
      for (const k of [`health.${id}`, `health.${id}_action`]) {
        expect(hu[k], `hu ${k}`).toBeTruthy()
        expect(en[k], `en ${k}`).toBeTruthy()
      }
    }
  })
})
