// Kartya acc07213: a "Commit es Push Most" dispatch tiszta logikaja.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { modelSmartnessRank, pickSmartestAgent, buildCommitPushPrompt, type AgentPick } from '../web/commit-push-dispatch.js'

describe('modell-okossag rangsor (Boss: opus 5 > ... > haiku > free)', () => {
  it('tier sorrend: opus > sonnet > haiku > openrouter/free', () => {
    expect(modelSmartnessRank('claude-opus-5')).toBeGreaterThan(modelSmartnessRank('claude-sonnet-5'))
    expect(modelSmartnessRank('claude-sonnet-5')).toBeGreaterThan(modelSmartnessRank('claude-haiku-4-5'))
    expect(modelSmartnessRank('claude-haiku-4-5')).toBeGreaterThan(modelSmartnessRank('z-ai/glm-5v-turbo'))
    expect(modelSmartnessRank('claude-haiku-4-5')).toBeGreaterThan(modelSmartnessRank('poolside/laguna-s-2.1:free'))
  })
  it('azonos tier-en belul a magasabb verzio nyer', () => {
    expect(modelSmartnessRank('claude-opus-5')).toBeGreaterThan(modelSmartnessRank('claude-opus-4-8'))
    expect(modelSmartnessRank('opus-4.8')).toBeGreaterThan(modelSmartnessRank('opus-4'))
  })
  it('ismeretlen/ures -> legalul', () => {
    expect(modelSmartnessRank('')).toBeLessThan(modelSmartnessRank('claude-haiku-4-5'))
    expect(modelSmartnessRank(null)).toBeLessThan(modelSmartnessRank('claude-haiku-4-5'))
  })
})

const A = (agent: string, running: boolean, usedPct: number | null, model: string): AgentPick =>
  ({ agent, running, usedPct, model, rank: modelSmartnessRank(model) })

describe('legokosabb ELO, token-nel biro agens valasztasa', () => {
  it('a legokosabb elo, nem kritikus agenst valasztja', () => {
    const pick = pickSmartestAgent([
      A('gyenge', true, 10, 'poolside/laguna-xs-2.1:free'),
      A('opus', true, 20, 'claude-opus-5'),
      A('sonnet', true, 5, 'claude-sonnet-5'),
    ])
    expect(pick?.agent).toBe('opus')
  })
  it('a nem futo agenst kihagyja, meg ha okosabb is', () => {
    const pick = pickSmartestAgent([
      A('opus_offline', false, 10, 'claude-opus-5'),
      A('sonnet_live', true, 10, 'claude-sonnet-5'),
    ])
    expect(pick?.agent).toBe('sonnet_live')
  })
  it('a kimerult keretu (kritikus, usedPct>=95) agenst kihagyja', () => {
    const pick = pickSmartestAgent([
      A('opus_full', true, 97, 'claude-opus-5'),
      A('haiku_ok', true, 30, 'claude-haiku-4-5'),
    ])
    expect(pick?.agent).toBe('haiku_ok')
  })
  it('ha senki nem elerheto -> null (a hivo a fo agensre esik vissza)', () => {
    expect(pickSmartestAgent([
      A('a', false, null, 'claude-opus-5'),
      A('b', true, 99, 'claude-sonnet-5'),
    ])).toBeNull()
    expect(pickSmartestAgent([])).toBeNull()
  })
  it('azonos rangnal a tobb szabad kerettel (kisebb usedPct) nyer', () => {
    const pick = pickSmartestAgent([
      A('a', true, 80, 'claude-opus-5'),
      A('b', true, 10, 'claude-opus-5'),
    ])
    expect(pick?.agent).toBe('b')
  })
})

describe('feladat-szoveg', () => {
  it('felsorolja a tarolókat es a commit/push lepeseket', () => {
    const p = buildCommitPushPrompt([
      { rel: 'Fejlesztés/GIT_REPOS/foo', account: 'GIT_01', abs: '/x/foo', dirty: 3, ahead: 0, hasUpstream: true },
      { rel: 'Fejlesztés/GIT_REPOS/bar', account: 'GIT_01', abs: '/x/bar', dirty: 0, ahead: 2, hasUpstream: false },
    ])
    expect(p).toContain('Fejlesztés/GIT_REPOS/foo')
    expect(p).toContain('3 commitolatlan fajl')
    expect(p).toContain('2 fel nem toltott commit')
    expect(p).toContain('[nincs upstream]')
    expect(p).toContain('git push')
  })
})

describe('bekotes', () => {
  const root = process.cwd()
  it('a route regisztralva van a storages-ben', () => {
    const s = readFileSync(join(root, 'src/web/routes/storages.ts'), 'utf8')
    expect(s).toContain("'/api/storages/git-commit-push'")
    expect(s).toContain('dispatchCommitPush')
  })
  it('a gomb es a kezelo a feluleten van', () => {
    const html = readFileSync(join(root, 'web/index.html'), 'utf8')
    const app = readFileSync(join(root, 'web/app.js'), 'utf8')
    expect(html).toContain('id="storagesGitCommitPushBtn"')
    expect(app).toContain("_depoPost('/api/storages/git-commit-push'")
  })
  it('findOutstandingRepos exportalt a git-sync-bol', () => {
    const g = readFileSync(join(root, 'src/git-sync.ts'), 'utf8')
    expect(g).toContain('export async function findOutstandingRepos')
  })
})
