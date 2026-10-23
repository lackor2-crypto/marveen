/**
 * #765: the minimum a video needs reaches the setup wizard AND the Overview self-check, on a fresh install.
 * Pins: the value rules, that a check never leaks the key or turns "could not ask" into "key is bad", that the
 * wizard rows exist with plain steps in both languages, and that the self-check says what is missing.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BUFFER_FREE_SERVICES, checkBuffer, checkCloudinary, checkOpenRouter, judgeBufferChannels,
  normalizeCloudinaryInput, normalizePlainKey,
} from '../video-requirements.js'
import { SETUP_ITEMS, buildSetupSummary, writableEnvKeys, writableVaultItems } from '../web/setup-wizard-registry.js'
import { integrationStates, vaultConfigured } from '../web/setup-wizard-values.js'
import { integrationRows } from '../web/system-health.js'

const SECRET = 'SuperSecretValue123'
const KEY = 'sk-or-v1-' + SECRET
const CLOUD = `cloudinary://111222333:${SECRET}@my-cloud`
const ch = (service: string, extra: Partial<{ isDisconnected: boolean; isLocked: boolean }> = {}) =>
  ({ id: service, name: service, service, type: null, isLocked: false, isDisconnected: false, timezone: null, ...extra })
const fakeFetch = (status: number, seen: string[] = []) => (async (url: string, init?: { headers?: Record<string, string> }) => {
  seen.push(url + ' ' + JSON.stringify(init?.headers ?? {}))
  return { ok: status < 300, status, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
}) as never

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

describe('value rules', () => {
  it('takes a plain Cloudinary address, strips the CLOUDINARY_URL= prefix and quotes', () => {
    expect(normalizeCloudinaryInput(CLOUD)).toEqual({ ok: true, value: CLOUD })
    expect(normalizeCloudinaryInput(`CLOUDINARY_URL="${CLOUD}"`)).toEqual({ ok: true, value: CLOUD })
    expect(normalizeCloudinaryInput(`export CLOUDINARY_URL=${CLOUD}`)).toEqual({ ok: true, value: CLOUD })
  })
  it('refuses a leftover placeholder by name, and anything that is not an address', () => {
    expect(normalizeCloudinaryInput('cloudinary://111:<your_api_secret>@my-cloud')).toEqual({ ok: false, code: 'cloudinary_placeholder' })
    expect(normalizeCloudinaryInput('cloudinary://111:your_api_secret@my-cloud')).toEqual({ ok: false, code: 'cloudinary_placeholder' })
    expect(normalizeCloudinaryInput('my-cloud')).toEqual({ ok: false, code: 'cloudinary_format' })
  })
  it('takes a plain key, drops quotes and a Bearer prefix, refuses spaces and empty', () => {
    expect(normalizePlainKey(`"Bearer ${KEY}"`)).toEqual({ ok: true, value: KEY })
    expect(normalizePlainKey('two words')).toEqual({ ok: false, code: 'key_format' })
    expect(normalizePlainKey('  ')).toEqual({ ok: false, code: 'key_empty' })
  })
})

describe('live checks', () => {
  it('OpenRouter: 200 ok, 401 refused, odd status / network failure = could not check, never "bad key"', async () => {
    expect((await checkOpenRouter({ key: KEY, fetchImpl: fakeFetch(200) })).tone).toBe('ok')
    expect(await checkOpenRouter({ key: KEY, fetchImpl: fakeFetch(401) })).toMatchObject({ tone: 'bad', code: 'key_rejected' })
    expect(await checkOpenRouter({ key: KEY, fetchImpl: fakeFetch(503) })).toMatchObject({ tone: 'unknown', code: 'unexpected', params: { status: 503 } })
    const boom = (async () => { throw new Error('ECONNRESET ' + KEY) }) as never
    expect(await checkOpenRouter({ key: KEY, fetchImpl: boom })).toEqual({ tone: 'unknown', code: 'unreachable' })
    expect(await checkOpenRouter({ key: null })).toMatchObject({ tone: 'bad', code: 'no_key' })
  })
  it('Cloudinary: signed ping on the right cloud, secret only in the Authorization header', async () => {
    const seen: string[] = []
    expect((await checkCloudinary({ url: CLOUD, fetchImpl: fakeFetch(200, seen) })).code).toBe('cloudinary_ok')
    expect(seen[0]).toContain('https://api.cloudinary.com/v1_1/my-cloud/ping')
    expect(seen[0]).not.toContain(SECRET) // base64 in the header, not plain
    expect(await checkCloudinary({ url: CLOUD, fetchImpl: fakeFetch(401) })).toMatchObject({ tone: 'bad', code: 'key_rejected' })
    expect(await checkCloudinary({ url: 'nonsense', fetchImpl: fakeFetch(200) })).toMatchObject({ code: 'cloudinary_format' })
  })
  it('answers never carry the key', async () => {
    const results = [
      await checkOpenRouter({ key: KEY, fetchImpl: fakeFetch(401) }),
      await checkCloudinary({ url: CLOUD, fetchImpl: fakeFetch(403) }),
      await checkOpenRouter({ key: KEY, fetchImpl: (async () => { throw new Error(KEY) }) as never }),
    ]
    expect(JSON.stringify(results)).not.toContain(SECRET)
  })
  it('Buffer: names the connected and the missing free-plan channels, flags a broken one', () => {
    expect(BUFFER_FREE_SERVICES).toEqual(['facebook', 'instagram', 'tiktok'])
    expect(judgeBufferChannels([ch('facebook'), ch('instagram'), ch('tiktok')])).toMatchObject({ tone: 'ok', code: 'buffer_ok' })
    expect(judgeBufferChannels([ch('facebook'), ch('instagram')])).toMatchObject({ tone: 'warn', code: 'buffer_partial', params: { missing: 'TikTok' } })
    expect(judgeBufferChannels([ch('facebook'), ch('instagram'), ch('tiktok', { isDisconnected: true })])).toMatchObject({ code: 'buffer_broken', params: { broken: 'TikTok' } })
    expect(judgeBufferChannels([])).toMatchObject({ tone: 'warn', code: 'buffer_no_channel' })
    expect(judgeBufferChannels([ch('linkedin')])).toMatchObject({ code: 'buffer_partial', params: { missing: 'Facebook, Instagram, TikTok' } }) // LinkedIn is out of the free-plan set
  })
  it('Buffer: a refused key is "bad", a network failure is "could not check"', async () => {
    const mk = (status: number) => (async () => ({ ok: status < 300, status, text: async () => '{}' })) as never
    expect(await checkBuffer({ key: KEY, fetchImpl: mk(401) })).toMatchObject({ tone: 'bad', code: 'key_rejected' })
    expect(await checkBuffer({ key: KEY, fetchImpl: (async () => { throw new Error('x') }) as never })).toMatchObject({ tone: 'unknown', code: 'unreachable' })
    expect(await checkBuffer({ key: null })).toMatchObject({ code: 'no_key' })
  })
})

const VIDEO_IDS = ['video-openrouter', 'video-cloudinary', 'video-buffer']

describe('wizard rows', () => {
  const rows = SETUP_ITEMS.filter(i => VIDEO_IDS.includes(i.id))
  it('has one row per video requirement, writing the Vault id the code reads', () => {
    expect(rows.map(r => r.vaultIds?.[0]).sort()).toEqual(['buffer-api-key', 'cloudinary-url', 'openrouter-fleet-key'])
    for (const r of rows) {
      expect(r.kind).toBe('vault')
      expect(writableVaultItems().get(r.vaultIds![0])?.id).toBe(r.id)
      expect(r.envKey, 'a Vault key must not also be an .env key').toBeUndefined()
    }
    for (const id of writableVaultItems().keys()) expect(writableEnvKeys().has(id)).toBe(false)
  })
  it('is recommended (orange), never essential, never required', () => {
    for (const r of rows) { expect(r.tier).toBe('recommended'); expect(r.required).toBe(false) }
  })
  it('has numbered steps, links, an example, a try-it, a self-check sentence, both languages', () => {
    for (const r of [...rows, ...SETUP_ITEMS.filter(i => i.id === 'voice-toolkit' || i.id === 'openrouter-balance')]) {
      expect((r.stepKeys ?? []).length, r.id).toBeGreaterThanOrEqual(3)
      if (r.id !== 'voice-toolkit') expect((r.links ?? []).length, r.id).toBeGreaterThan(0)
      const keys = [r.labelKey, r.descKey, r.helpKey, ...(r.stepKeys ?? []), ...(r.links ?? []).map(l => l.labelKey),
        ...(r.exampleKey ? [r.exampleKey] : []), ...(r.selfcheckKey ? [r.selfcheckKey] : [])]
      for (const k of keys) { expect(hu[k], `hu ${k}`).toBeTruthy(); expect(en[k], `en ${k}`).toBeTruthy() }
    }
    for (const r of rows) { expect(r.checkId, r.id).toBeTruthy(); expect(r.selfcheckKey, r.id).toBeTruthy() }
  })
  it('every message the check and the save can answer with exists in both languages', () => {
    const codes = ['no_key', 'key_rejected', 'unreachable', 'unexpected', 'vault_unreadable', 'openrouter_ok', 'cloudinary_ok', 'cloudinary_format',
      'cloudinary_placeholder', 'key_empty', 'key_format', 'buffer_ok', 'buffer_partial', 'buffer_broken', 'buffer_no_channel']
    for (const c of codes) { expect(hu['wizard.check.' + c], 'hu ' + c).toBeTruthy(); expect(en['wizard.check.' + c], 'en ' + c).toBeTruthy() }
    for (const c of ['cloudinary_format', 'cloudinary_placeholder', 'key_empty', 'key_format', 'vault_unreadable', 'vault_write_failed']) {
      expect(hu['wizard.invalid.' + c], 'hu ' + c).toBeTruthy(); expect(en['wizard.invalid.' + c], 'en ' + c).toBeTruthy()
    }
    for (const k of ['wizard.saved_live', 'wizard.check.button', 'wizard.check.button_saved', 'wizard.check.running', 'wizard.vault_unreadable',
      'wizard.voice.install', 'wizard.voice.starting', 'wizard.voice.running', 'wizard.voice.done', 'wizard.voice.failed', 'wizard.voice.needs_sudo']) {
      expect(hu[k], 'hu ' + k).toBeTruthy(); expect(en[k], 'en ' + k).toBeTruthy()
    }
  })
  it('a Vault row reports only whether it is set: the value never travels', () => {
    const sum = buildSetupSummary({}, { 'video-openrouter': true })
    const item = sum.items.find(i => i.id === 'video-openrouter')!
    expect(item.configured).toBe(true)
    expect(item).not.toHaveProperty('value')
    expect(sum.items.find(i => i.id === 'video-buffer')!.configured).toBe(false)
  })
  it('a fresh install (empty Vault) shows all three as missing', () => {
    const states = integrationStates({}, () => vaultConfigured(() => null, () => 'missing'))
    for (const id of VIDEO_IDS) expect(states.find(s => s.id === id)?.configured, id).toBe(false)
  })
  it('a Cloudinary value that does not parse counts as missing', () => {
    const v = vaultConfigured((id) => (id === 'cloudinary-url' ? 'garbage' : id === 'buffer-api-key' ? 'k' : null), () => 'ok')
    expect(v['video-cloudinary']).toBe(false)
    expect(v['video-buffer']).toBe(true)
    expect(vaultConfigured(() => CLOUD, () => 'ok')['video-cloudinary']).toBe(true)
  })
  it('an unreadable Vault is "could not look", not "nothing set"', () => {
    expect(() => vaultConfigured(() => null, () => 'unreadable')).toThrow()
    expect(integrationRows(() => integrationStates({}, () => vaultConfigured(() => null, () => 'unreadable')))).toEqual([{ id: 'integration_blind', status: 'warn', params: {} }])
  })
})

describe('self-check rows', () => {
  it('names each missing video requirement as an orange warning with its own "what stops" sentence', () => {
    const states = integrationStates({}, () => vaultConfigured(() => null, () => 'missing')).filter(s => VIDEO_IDS.includes(s.id))
    const out = integrationRows(() => states)
    expect(out).toHaveLength(3)
    for (const r of out) {
      expect(r).toMatchObject({ id: 'integration_missing', status: 'warn' })
      expect(String(r.params?.actionKey)).toMatch(/^wizard\.item\.video_.*_selfcheck$/)
    }
  })
  it('a set key is ok and carries no missing-sentence', () => {
    const [r] = integrationRows(() => integrationStates({}, () => ({ 'video-openrouter': true, 'video-cloudinary': true, 'video-buffer': true, 'openrouter-balance': true })).filter(s => s.id === 'video-openrouter'))
    expect(r).toMatchObject({ id: 'integration_ok', status: 'ok' })
    expect(r.params).not.toHaveProperty('actionKey')
  })
})

describe('wizard page (source contract; the real click-through is in the card comment)', () => {
  const app = readFileSync(resolve(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  const fn = (name: string): string => app.slice(app.indexOf(`async function ${name}(`), app.indexOf(`async function ${name}(`) + 900)

  it('the self-check row actions wait for the Settings page build, or the build repaints the list over the step', () => {
    for (const name of ['openWizardItem', 'openSystemDepsStep', 'openClaudeLoginStep']) {
      expect(fn(name), name).toContain('await _settingsLoadPromise')
    }
    expect(app).toContain('_settingsLoadPromise = loadSettingsInner()')
  })

  it('only the newest wizard render may paint the panel', () => {
    expect(app).toContain('if (seq !== _wizardRenderSeq) return')
  })

  it('says "restart needed" only when the server says so (a Vault key is live at once)', () => {
    expect(app).toContain('restartRequired = out.restartRequired === true')
    expect(app).toContain("restartRequired ? 'wizard.saved' : 'wizard.saved_live'")
  })

  it('a Vault value is stashed under its Vault id and never prefilled', () => {
    expect(app).toContain('function wizardPendingKey(item)')
    expect(app).toContain("isSecretish ? '' :")
  })
})
