// Per-agent admin rights (Boss, 2026-08-27, Telegram 593 + 595).
//
// What this test is for: the fleet used to be uniform, so nobody could get the
// answer to "may THIS agent act on its own?" wrong -- there was only one
// answer. Now there are two, derived from the model, and a mistake in either
// direction is silent: a free agent quietly acting alone, or a paid agent
// still waking the owner for every step. So both directions are pinned here.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MODELS: Record<string, string> = {
  'agent-paid': 'claude-opus-5',
  'agent-cheap': 'z-ai/glm-5v-turbo',
  'agent-free': 'nvidia/nemotron-3-nano-30b-a3b:free',
}

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/nonexistent-project-root',
  STORE_DIR: '/nonexistent-project-root/store',
  MAIN_AGENT_ID: 'main-agent',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentModel: (name: string) => MODELS[name] ?? 'claude-opus-5',
  listAgentNames: () => Object.keys(MODELS),
  DEFAULT_MODEL: 'claude-opus-5',
}))

const {
  isAdminAgent, derivedAdmin, isFreeAgent, effectiveLevel,
  setAgentAdminOverride, listAgentAutonomy, MARVEEN_SELFDEV_KEY,
} = await import('../autonomy.js')

type Cfg = Parameters<typeof isAdminAgent>[1]

function cfg(overrides?: Record<string, boolean>): Cfg {
  return {
    version: 1,
    updated_at: 0,
    agent_admin_overrides: overrides,
    categories: [],
  } as Cfg
}

const cat = (level: number, maxLevel: number, locked = false) => ({
  key: 'k', label: 'K', level, maxLevel, locked,
})

describe('ki kap admin jogot', () => {
  it('MINDEN agens admin alapbol, az ingyenes modellen futo is', () => {
    // Boss, 2026-08-27 (Telegram 604): "az osszes ai en vagyok ... mitol
    // rosszabb mondjuk most a masik fiok mint marvin". The model is his
    // choice, so it cannot be what decides trust. This test exists to stop
    // the free/paid split from creeping back in as a "sensible default".
    expect(derivedAdmin('agent-paid')).toBe(true)
    expect(derivedAdmin('agent-cheap')).toBe(true)
    expect(derivedAdmin('agent-free')).toBe(true)
    expect(isAdminAgent('agent-free', cfg())).toBe(true)
  })

  it('a modellt tovabbra is meg tudjuk mondani -- de csak kijelzesre', () => {
    expect(isFreeAgent('agent-free')).toBe(true)
    expect(isFreeAgent('agent-paid')).toBe(false)
    expect(isFreeAgent('agent-cheap')).toBe(false)
    // ...and it changes nothing about the rights.
    expect(isAdminAgent('agent-free', cfg())).toBe(isAdminAgent('agent-paid', cfg()))
  })

  it('egy ismeretlen (kesobb letrehozott) agens is admin', () => {
    // An agent created after the setting was made still gets an answer, not a
    // blank -- the default is a rule, not a stored roster.
    expect(isAdminAgent('agent-created-tomorrow', cfg())).toBe(true)
  })

  it('a kezi felulirás el tudja venni a jogot', () => {
    // The switch now runs the other way: the default gives everything, and the
    // override is how a future owner takes something back.
    expect(isAdminAgent('agent-paid', cfg({ 'agent-paid': false }))).toBe(false)
    expect(isAdminAgent('agent-free', cfg({ 'agent-free': true }))).toBe(true)
  })

  it('a felulirás torlese visszaadja az alapertelmezest', () => {
    const c = setAgentAdminOverride(cfg({ 'agent-free': false }), 'agent-free', null)
    expect(c.agent_admin_overrides).not.toHaveProperty('agent-free')
    expect(isAdminAgent('agent-free', c)).toBe(true)
  })

  it('a lista megmondja, hogy a jog alapertelmezesbol vagy kezbol jon', () => {
    const rows = listAgentAutonomy(cfg({ 'agent-free': false }))
    const free = rows.find(r => r.name === 'agent-free')!
    expect(free.admin).toBe(false)
    expect(free.overridden).toBe(true)
    const paid = rows.find(r => r.name === 'agent-paid')!
    expect(paid.admin).toBe(true)
    expect(paid.overridden).toBe(false)
    // The main agent has no agents/ directory; it must still be listed.
    expect(rows.some(r => r.name === 'main-agent')).toBe(true)
  })
})

describe('milyen szintet kap egy kategorian', () => {
  it('az admin a kategoria sajat plafonjaig emel, nem tovabb', () => {
    expect(effectiveLevel(cat(2, 3), 'agent-paid', cfg())).toBe(3)
    // A ceiling still means something, for whoever sets one later.
    expect(effectiveLevel(cat(2, 2), 'agent-paid', cfg())).toBe(2)
  })

  it('a kezzel visszafogott agens a flotta szintjet kapja', () => {
    const held = cfg({ 'agent-free': false })
    expect(effectiveLevel(cat(2, 3), 'agent-free', held)).toBe(2)
    expect(effectiveLevel(cat(3, 3), 'agent-free', held)).toBe(3)
  })

  it('a biztonsagi zar az adminra is vonatkozik', () => {
    expect(effectiveLevel(cat(1, 3, true), 'agent-paid', cfg())).toBe(1)
  })
})

describe('friss telepites', () => {
  const seed = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'seed-config', 'autonomy-config.json'), 'utf-8'),
  )

  it('a seed-config tartalmazza a marveen_selfdev kategoriat, 3-as szinten', () => {
    const c = seed.categories.find((x: { key: string }) => x.key === MARVEEN_SELFDEV_KEY)
    expect(c, 'marveen_selfdev hianyzik a seed-configbol').toBeTruthy()
    expect(c.level).toBe(3)
    expect(c.maxLevel).toBe(3)
    expect(c.locked).toBe(false)
    expect(effectiveLevel(c, 'agent-free', cfg())).toBe(3)
  })

  it('egy nullarol telepitett Marveenben EGYETLEN kategoria sem ker jovahagyast', () => {
    // Boss, 2026-08-27 (Telegram 604): "Ezek ugy legyenek megcsinalva hogy ha
    // barki alapbol a nullarol ujratelepiti a marveent akkor nala is igy
    // mukodjon!!! globalisan". A fresh install reads seed-config, so this file
    // -- not the live store/ copy on this one machine -- is what has to say it.
    expect(seed.categories.length).toBeGreaterThan(0)
    for (const c of seed.categories) {
      expect(c.level, `${c.key} nem 3-as szinten van a seed-configban`).toBe(3)
      expect(c.maxLevel, `${c.key} meg plafonozva van a seed-configban`).toBe(3)
      expect(c.locked, `${c.key} zarolva van a seed-configban`).toBe(false)
      expect(effectiveLevel(c, 'agent-free', cfg())).toBe(3)
    }
  })
})
