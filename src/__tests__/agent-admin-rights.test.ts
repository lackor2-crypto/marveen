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
  it('a fizetos modellen futo agens alapbol admin, az ingyenes nem', () => {
    expect(isFreeAgent('agent-free')).toBe(true)
    expect(isFreeAgent('agent-paid')).toBe(false)
    // Cheap is not free: Boss's word was "ingyenes", and the measurable
    // property behind it is the `:free` suffix, not the price.
    expect(isFreeAgent('agent-cheap')).toBe(false)

    expect(derivedAdmin('agent-paid')).toBe(true)
    expect(derivedAdmin('agent-cheap')).toBe(true)
    expect(derivedAdmin('agent-free')).toBe(false)
  })

  it('egy ismeretlen (kesobb letrehozott) agens nem esik ki a szabaly alol', () => {
    // The whole reason the default is derived and not a stored roster: an agent
    // created after the setting was made still gets an answer, not a blank.
    expect(isAdminAgent('agent-created-tomorrow', cfg())).toBe(true)
  })

  it('a kezi felulirás mindket iranyban eros', () => {
    expect(isAdminAgent('agent-free', cfg({ 'agent-free': true }))).toBe(true)
    expect(isAdminAgent('agent-paid', cfg({ 'agent-paid': false }))).toBe(false)
  })

  it('a felulirás torlese visszaadja az alapszabalyt', () => {
    const c = setAgentAdminOverride(cfg({ 'agent-paid': false }), 'agent-paid', null)
    expect(c.agent_admin_overrides).not.toHaveProperty('agent-paid')
    expect(isAdminAgent('agent-paid', c)).toBe(true)
  })

  it('a lista megmondja, hogy a jog szabalybol vagy kezbol jon', () => {
    const rows = listAgentAutonomy(cfg({ 'agent-free': true }))
    const free = rows.find(r => r.name === 'agent-free')!
    expect(free.admin).toBe(true)
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
    // maxLevel 2 = the config itself says a human decides. Admin does not
    // break that open; that is what keeps money and outgoing mail gated.
    expect(effectiveLevel(cat(2, 2), 'agent-paid', cfg())).toBe(2)
  })

  it('a nem-admin agens a flotta szintjet kapja', () => {
    expect(effectiveLevel(cat(2, 3), 'agent-free', cfg())).toBe(2)
    expect(effectiveLevel(cat(3, 3), 'agent-free', cfg())).toBe(3)
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
    // Boss 593: modifying Marveen must never need his approval, from ANY agent
    // -- the free ones included. That is only true if the base level is 3, not
    // if admin lifts it, because free agents are not admin.
    const c = seed.categories.find((x: { key: string }) => x.key === MARVEEN_SELFDEV_KEY)
    expect(c, 'marveen_selfdev hianyzik a seed-configbol').toBeTruthy()
    expect(c.level).toBe(3)
    expect(c.maxLevel).toBe(3)
    expect(c.locked).toBe(false)
    expect(effectiveLevel(c, 'agent-free', cfg())).toBe(3)
  })

  it('a penz es a kifele meno uzenet a friss telepitesen is jovahagyashoz kotott', () => {
    for (const key of ['payment', 'email_send', 'external_message', 'publish_content', 'data_delete']) {
      const c = seed.categories.find((x: { key: string }) => x.key === key)
      expect(c, `${key} hianyzik a seed-configbol`).toBeTruthy()
      expect(c.maxLevel, `${key} maxLevel megvaltozott`).toBe(2)
      expect(effectiveLevel(c, 'agent-paid', cfg())).toBeLessThan(3)
    }
  })
})
