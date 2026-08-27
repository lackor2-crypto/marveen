// Per-agent admin rights (Boss, 2026-08-27, Telegram 593 + 595).
//
// What this test is for: "may THIS agent act on its own?" now has two inputs
// that can each be got wrong silently -- the per-agent switch, and the
// per-category level the owner set by hand. Both directions are pinned here:
// nobody is held back for running a cheap model, and nobody runs above the
// number the owner can see on the dashboard.
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
  it('a tulajdonos altal beallitott szint az igazsag -- az admin sem lep folebe', () => {
    // Boss, 2026-08-27 (Telegram 611): "amik ott be voltak allitva azokat
    // allitsd vissza!". A dial he set to 2 must BEHAVE as 2; an earlier
    // version lifted admins to maxLevel, which made the number on the
    // dashboard a decoration. That is what this pins.
    expect(effectiveLevel(cat(2, 3), 'agent-paid', cfg())).toBe(2)
    expect(effectiveLevel(cat(1, 3), 'agent-paid', cfg())).toBe(1)
    expect(effectiveLevel(cat(3, 3), 'agent-free', cfg())).toBe(3)
  })

  it('a maxLevel a csuszka plafonja, nem egy agensnek adott jog', () => {
    // maxLevel caps how high the OWNER may turn the category up (the POST
    // handler rejects more). It must never raise anyone by itself.
    for (const max of [1, 2, 3]) {
      expect(effectiveLevel(cat(2, max), 'agent-paid', cfg())).toBe(2)
    }
  })

  it('a kezzel visszafogott agens sehol nem cselekszik onalloan, de kerdezhet', () => {
    // The dashboard button says "Alap: jovahagyast ker" -- so basic means
    // capped at 2 (ask first), not 1 (report and stop). The label and the
    // behaviour have to be the same thing.
    const held = cfg({ 'agent-free': false })
    expect(effectiveLevel(cat(3, 3), 'agent-free', held)).toBe(2)
    expect(effectiveLevel(cat(2, 3), 'agent-free', held)).toBe(2)
    expect(effectiveLevel(cat(1, 3), 'agent-free', held)).toBe(1)
    // ...while everyone else is unaffected by that one switch.
    expect(effectiveLevel(cat(3, 3), 'agent-paid', held)).toBe(3)
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

  it('egy nullarol telepitett Marveen ugyanazokat a szinteket kapja, es minden agens admin', () => {
    // Boss, 2026-08-27 (Telegram 604): "Ezek ugy legyenek megcsinalva hogy ha
    // barki alapbol a nullarol ujratelepiti a marveent akkor nala is igy
    // mukodjon!!! globalisan". A fresh install reads seed-config, so this file
    // -- not the live store/ copy on this one machine -- is what has to say it.
    //
    // What "igy" means was narrowed by Telegram 611: the per-category dials are
    // the owner's, so this does NOT assert that everything is 3. It asserts
    // that a fresh install is self-consistent -- every agent, free or paid,
    // runs each category at exactly the level written in the file.
    expect(seed.categories.length).toBeGreaterThan(0)
    for (const c of seed.categories) {
      expect([1, 2, 3], `${c.key} ervenytelen szint`).toContain(c.level)
      expect(c.level, `${c.key} a sajat plafonja folott van`).toBeLessThanOrEqual(c.maxLevel)
      for (const who of ['agent-free', 'agent-paid', 'agent-created-tomorrow']) {
        expect(effectiveLevel(c, who, cfg()), `${c.key} / ${who}`).toBe(c.locked ? 1 : c.level)
      }
    }
  })

  it('a seed-config szintjei megegyeznek a szallitott alapertelmezessel', () => {
    // Guards the actual regression of 2026-08-27: a blanket rewrite of every
    // level. These four are the ones that must stay gated out of the box --
    // the owner's money, a message to a real recipient, an irreversible
    // delete, and root. If a later change wants them open, it has to say so
    // here, in a diff somebody reads.
    const byKey = Object.fromEntries(seed.categories.map((c: { key: string }) => [c.key, c]))
    for (const key of ['payment', 'email_send', 'data_delete', 'privileged_sudo']) {
      expect(byKey[key], `${key} hianyzik a seed-configbol`).toBeTruthy()
      expect(byKey[key].level, `${key} szintje megvaltozott a seed-configban`).toBe(2)
    }
  })
})
