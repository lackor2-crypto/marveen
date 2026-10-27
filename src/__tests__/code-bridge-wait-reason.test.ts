// #812 (Boss TG 4492): the VS Code card said "working (waiting to start)" and never said WHAT it waits for.
// The server now names the reason, the card shows it in the badge label and tooltip.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initDatabase } from '../db.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, recordCodeWorkerSeen, recordCodeCandidates,
  _resetCodeCandidates, enqueueCodeTask, claimNextCodeTask,
  codeBridgeActivity, codeBridgeProjectDisplayStates, codeProjectWaitReason,
} from '../web/code-bridge-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

const MARVEEN = { project: 'marveen', workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
const TMP = { project: 'tmp', workspacePath: 'C:\\Users\\boss\\tmp', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  _resetCodeCandidates()
  upsertCodeSession(MARVEEN)
  upsertCodeSession(TMP)
  recordCodeWorkerSeen('windows', 'discovery', 1)
  recordCodeCandidates('windows', [])
})

const enqueue = (project: string, prompt = 'Feladat') => {
  const r = enqueueCodeTask({ project, prompt, origin: 'api' })
  expect('task' in r).toBe(true)
}

describe('#812: why a queued task has not started', () => {
  it('no queued task, no reason', () => {
    expect(codeProjectWaitReason('marveen')).toBeNull()
  })

  it('the single worker is busy with another project: the reason names that project', () => {
    enqueue('tmp')
    expect(claimNextCodeTask('windows')).not.toBeNull()
    enqueue('marveen', 'Elso')
    enqueue('marveen', 'Masodik')
    const r = codeProjectWaitReason('marveen')
    expect(r).toMatchObject({ kind: 'busy_elsewhere', project: 'tmp', queued: 2 })

    // The per-project display state carries it, only for the project that waits.
    const per = codeBridgeProjectDisplayStates(codeBridgeActivity(), true)
    expect(per.marveen).toMatchObject({ state: 'working', queuedOnly: true })
    expect(per.marveen?.waitReason).toMatchObject({ kind: 'busy_elsewhere', project: 'tmp' })
    expect(per.tmp?.queuedOnly).toBe(false)
    expect(per.tmp?.waitReason).toBeNull()
  })

  it('a task of the same project runs: the reason says so', () => {
    enqueue('marveen', 'Fut')
    expect(claimNextCodeTask('windows')).not.toBeNull()
    enqueue('marveen', 'Var')
    expect(codeProjectWaitReason('marveen')).toMatchObject({ kind: 'same_project', project: 'marveen' })
  })

  it('a live idle worker and nothing in the way: it starts shortly', () => {
    enqueue('marveen')
    expect(codeProjectWaitReason('marveen')).toMatchObject({ kind: 'starting', queued: 1 })
  })

  it('no live worker at all: the reason says nothing can start it', () => {
    enqueue('marveen')
    const later = Date.now() + 60 * 60 * 1000
    const r = codeProjectWaitReason('marveen', later)
    expect(r).toMatchObject({ kind: 'no_worker' })
    expect(r?.waitedMin).toBeGreaterThanOrEqual(59)
  })
})

describe('#812: the card shows the reason', () => {
  it('the badge refresh uses the reason for label and tooltip, and every kind has HU and EN text', () => {
    expect(app).toContain('cbWaitReasonText(cbState.waitReason)')
    for (const k of ['topic', 'no_session', 'limit', 'same_project', 'busy_elsewhere', 'no_worker', 'starting']) {
      for (const [name, src] of [['hu', hu], ['en', en]] as const) {
        expect(src, `${name} wait ${k}`).toContain(`'activity.wait.${k}'`)
      }
    }
    expect(app).toContain('data-cb-wait-why')
  })
})
