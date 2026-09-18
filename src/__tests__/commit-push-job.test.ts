// A "Commit es Push Most" diszpecser: felmer, valaszt, kiad.
//
// Amit itt biztosra kell tudni: (1) a munkacsomag ONMAGABAN teljes es
// ovatossagra int (nincs force-push, titok-ellenorzes), (2) a NULLA ket
// jelentese (nincs elmaradas vs. nem lattam oda) KULON valaszt kap, (3) ha
// egy agens sem tud dolgozni, azt megmondja -- nem kuld a semmibe.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-cpstore-'))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const createAgentMessage = vi.fn(() => ({ id: 4242 }))
vi.mock('../db.js', () => ({ createAgentMessage }))

const { buildWorkPackage, dispatchCommitPush } = await import('../web/commit-push-job.js')
import type { CommitPushRepo } from '../git-sync.js'
import type { WorkerCandidate } from '../web/smartest-worker.js'

const NOW = 1_000_000_000_000

function repo(over: Partial<CommitPushRepo>): CommitPushRepo {
  return { rel: 'Munka/proba', abs: '/depo/Munka/proba', account: 'boss', dirty: 2, ahead: 0, diverged: false, hasUpstream: true, ...over }
}
function cand(over: Partial<WorkerCandidate>): WorkerCandidate {
  return { agent: 'usalackor', model: 'claude-opus-5', running: true, fiveHourPct: 20, usageAt: NOW, ...over }
}

beforeEach(() => createAgentMessage.mockClear())

describe('buildWorkPackage', () => {
  it('felsorolja a tarolok tenyleges utjat es a mentetlen munka jelleget', () => {
    const msg = buildWorkPackage([
      repo({ abs: '/depo/a', dirty: 3, ahead: 0 }),
      repo({ abs: '/depo/b', dirty: 0, ahead: 2, account: 'ceg' }),
    ])
    expect(msg).toContain('/depo/a')
    expect(msg).toContain('/depo/b')
    expect(msg).toContain('3 helyben módosított')
    expect(msg).toContain('2 fel nem töltött commit')
    expect(msg).toContain('[fiók: ceg]')
  })

  it('a szetvalt (diverged) repohoz OVATOSSAGOT ir es tiltja a force-push-t', () => {
    const msg = buildWorkPackage([repo({ diverged: true })])
    expect(msg).toContain('szétvált')
    expect(msg.toLowerCase()).toContain('force')
  })

  it('emlekeztet a titok-ellenorzesre es a Telegram kesz-jelzesre', () => {
    const msg = buildWorkPackage([repo({})])
    expect(msg.toLowerCase()).toContain('titok')
    expect(msg).toContain('Telegram')
  })
})

describe('dispatchCommitPush', () => {
  it('root_error: a NULLA itt "nem lattam oda", nem "minden feltoltve"', async () => {
    const out = await dispatchCommitPush({ scan: { repos: [], rootError: 'Input/output error' }, candidates: [] })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('root_error')
    expect(createAgentMessage).not.toHaveBeenCalled()
  })

  it('nothing: nincs elmaradt tarolo -> nem kuld senkinek', async () => {
    const out = await dispatchCommitPush({ scan: { repos: [], rootError: '' }, candidates: [cand({})] })
    expect(out.ok).toBe(true)
    expect(out.kind).toBe('nothing')
    expect(createAgentMessage).not.toHaveBeenCalled()
  })

  it('no_agent: van elmaradas, de egy agens sem el -> nem kuld a semmibe', async () => {
    const out = await dispatchCommitPush({
      scan: { repos: [repo({})], rootError: '' },
      candidates: [cand({ running: false })],
      now: NOW,
    })
    expect(out.ok).toBe(false)
    expect(out.kind).toBe('no_agent')
    expect(createAgentMessage).not.toHaveBeenCalled()
  })

  it('dispatched: a legokosabb elo agensnek kuldi ki a munkacsomagot', async () => {
    const out = await dispatchCommitPush({
      scan: { repos: [repo({}), repo({ abs: '/depo/x' })], rootError: '' },
      candidates: [
        cand({ agent: 'segedmunkas', model: 'claude-haiku-4-5-20251001', fiveHourPct: 1 }),
        cand({ agent: 'usalackor', model: 'claude-opus-5', fiveHourPct: 55 }),
      ],
      now: NOW,
    })
    expect(out.ok).toBe(true)
    expect(out.kind).toBe('dispatched')
    if (out.kind === 'dispatched') {
      expect(out.agent).toBe('usalackor')
      expect(out.repoCount).toBe(2)
      expect(out.messageId).toBe(4242)
    }
    expect(createAgentMessage).toHaveBeenCalledTimes(1)
    // A cimzett a valasztott agens, a tartalom a munkacsomag.
    const args = createAgentMessage.mock.calls[0]
    expect(args[1]).toBe('usalackor')
    expect(String(args[2])).toContain('/depo/x')
  })
})
