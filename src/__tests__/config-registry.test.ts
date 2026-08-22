import { describe, it, expect } from 'vitest'
import { SETTINGS_REGISTRY, getSettingDefinition, listSettingModules, validateSettingValue } from '../config-registry.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('config-registry', () => {
  it('registers the kanban WIP keys as non-secret, hot-reloadable, module=kanban', () => {
    // Robust to later registry growth (system/heartbeat/ideabox modules etc.):
    // assert the kanban WIP subset's invariants, not the registry's exact size.
    const kanban = SETTINGS_REGISTRY.filter((s) => s.module === 'kanban')
    // the original v1 kanban WIP keys must all still be present
    expect(kanban.length).toBeGreaterThanOrEqual(9)
    // kanban WIP settings are user-tunable: never secret, hot-reloadable (no restart)
    expect(kanban.every((s) => s.secret === false)).toBe(true)
    expect(kanban.every((s) => s.requiresRestart === false)).toBe(true)
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.module).toBe('kanban')
  })

  it('keeps every secret registry entry out of the generic settings surface', () => {
    // This replaces an older line that asserted the registry contains NO secret
    // at all. That was a snapshot of v1, not a rule -- routes/settings.ts was
    // written expecting a secret to appear one day ("a future registry entry
    // marked secret must never be settable through this generic route"), and
    // CODE_BOT_TOKEN is that entry. What actually matters is pinned here: a
    // secret is not merely absent from the UI, it is unreachable through it.
    const src = readFileSync(join(process.cwd(), 'src/web/routes/settings.ts'), 'utf8')
    // GET: the whole ROW is dropped, not just the value -- a masked row would
    // still tell a reader the key exists and is set.
    expect(src).toContain('SETTINGS_REGISTRY.filter((def) => !def.secret)')
    // POST: refused outright, so a secret can never be written (or logged into
    // the change log) through the generic route.
    expect(src).toContain('Secret settings cannot be changed via this endpoint')

    // And every secret entry must have a dedicated, non-echoing way in --
    // otherwise marking a key secret would simply make it unconfigurable.
    const secrets = SETTINGS_REGISTRY.filter((s) => s.secret)
    for (const def of secrets) {
      expect(def.key).toBe('CODE_BOT_TOKEN')
    }
    const codeRoute = readFileSync(join(process.cwd(), 'src/web/routes/code.ts'), 'utf8')
    expect(codeRoute).toContain("botConfigured: String(getEffectiveSettingValue('CODE_BOT_TOKEN')).length > 0")
    // The value itself is never returned by its own route either.
    expect(codeRoute).not.toContain("CODE_BOT_TOKEN: String(getEffectiveSettingValue('CODE_BOT_TOKEN'))")
  })

  it('getSettingDefinition finds a known key and returns undefined for unknown', () => {
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.type).toBe('int')
    expect(getSettingDefinition('NOT_A_REAL_KEY')).toBeUndefined()
  })

  it('listSettingModules returns the distinct modules present in the registry', () => {
    // Robust: derive the expected module set from the registry rather than
    // pinning a hard-coded list, so it survives new modules being added.
    const mods = listSettingModules()
    expect(new Set(mods).size).toBe(mods.length) // distinct, no duplicates
    expect(new Set(mods)).toEqual(new Set(SETTINGS_REGISTRY.map((s) => s.module)))
    expect(mods).toContain('kanban')
  })

  describe('validateSettingValue', () => {
    it('accepts a valid int within bounds', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      const result = validateSettingValue(def, '5')
      expect(result).toEqual({ ok: true, value: 5 })
    })

    it('rejects a non-integer', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, 'abc').ok).toBe(false)
    })

    it('rejects below min', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, -1).ok).toBe(false)
    })

    it('rejects 0 for WARN_PCT (min 1, meaningless at 0)', () => {
      const def = getSettingDefinition('KANBAN_WIP_WARN_PCT')!
      expect(validateSettingValue(def, 0).ok).toBe(false)
    })

    it('rejects WARN_PCT above 100', () => {
      const def = getSettingDefinition('KANBAN_WIP_WARN_PCT')!
      expect(validateSettingValue(def, 101).ok).toBe(false)
    })

    it('accepts a valid hex color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      expect(validateSettingValue(def, '#123abc')).toEqual({ ok: true, value: '#123abc' })
    })

    it('rejects a malformed color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      expect(validateSettingValue(def, 'red').ok).toBe(false)
      expect(validateSettingValue(def, '#fff').ok).toBe(false)
    })

    it('enforces an explicit valueSet over type-based validation', () => {
      const def = { key: 'X', type: 'string' as const, default: 'a', description: '', module: 'm', secret: false, requiresRestart: false, valueSet: ['a', 'b'] }
      expect(validateSettingValue(def, 'a').ok).toBe(true)
      expect(validateSettingValue(def, 'c').ok).toBe(false)
    })
  })
})
