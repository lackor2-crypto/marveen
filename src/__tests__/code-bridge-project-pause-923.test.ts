// #923: pausing ONE project must stop only that project (its queued commands wait, nothing is lost) and
// leave every other project alone; switching the whole bridge off must not make the project cards vanish.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { PROJECT_ROOT } from '../config.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, claimNextCodeTask,
  setCodeProjectPaused, getCodeSession,
} from '../web/code-bridge-store.js'

const A = { project: 'marvin', workspacePath: 'C:\\ws\\marvin', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001' }
const B = { project: 'tozsde', workspacePath: 'C:\\ws\\tozsde', sessionId: 'bbbbbbbb-0000-4000-8000-000000000002' }

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
  upsertCodeSession(A)
  upsertCodeSession(B)
})

const queue = (project: string, prompt: string) => {
  const out = enqueueCodeTask({ project, prompt, origin: 'telegram' })
  if ('error' in out) throw new Error(out.error)
  return out.task.id
}

describe('per-project pause (#923)', () => {
  it('a paused project keeps its task queued while another project still gets its own', () => {
    const idA = queue('marvin', 'a-task')
    const idB = queue('tozsde', 'b-task')
    expect(setCodeProjectPaused('marvin', true)).toBe(true)
    const claimed = claimNextCodeTask('DESKTOP-A')
    expect(claimed?.id).toBe(idB)
    // nothing else is handed out: the paused project's task is still waiting, not cancelled
    expect(claimNextCodeTask('DESKTOP-A')).toBeNull()
    expect(idA).toBeTruthy()
  })

  it('Resume hands the waiting task out again', () => {
    const idA = queue('marvin', 'a-task')
    setCodeProjectPaused('marvin', true)
    expect(claimNextCodeTask('DESKTOP-A')).toBeNull()
    setCodeProjectPaused('marvin', false)
    expect(claimNextCodeTask('DESKTOP-A')?.id).toBe(idA)
  })

  it('survives a discovery refresh of the same session and rejects an unknown project', () => {
    setCodeProjectPaused('marvin', true)
    upsertCodeSession(A)
    expect(getCodeSession('marvin')?.paused).toBe(true)
    expect(getCodeSession('tozsde')?.paused).toBe(false)
    expect(setCodeProjectPaused('nincs-ilyen', true)).toBe(false)
  })
})

describe('whole-bridge stop no longer hides the project cards (#923)', () => {
  const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
  const code = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf8')
  const hu = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf8')
  const en = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf8')

  it('the card list does not drop the projects when the bridge is off', () => {
    expect(app).not.toContain('const rows = off ? [] : codeBridgeCards.projects')
    expect(app).toContain('const rows = codeBridgeCards.projects')
  })

  it('the project list endpoint answers while the bridge is off, and the pause route exists', () => {
    expect(code).toContain("path === '/api/code/projects' && method === 'GET'")
    expect(code).toContain('/pause$/')
    expect(code).toContain('setCodeProjectPaused(')
  })

  it('has the card button wired and every key in both languages', () => {
    expect(app).toContain('cb-pause-btn')
    expect(app).toContain('cbPauseProject(')
    for (const k of ['cb.card.pause', 'cb.card.pause_help', 'cb.card.resume', 'cb.card.resume_help', 'cb.card.paused_note', 'cb.toast.paused', 'cb.toast.resumed', 'cb.toast.pause_failed']) {
      expect(hu).toContain(`'${k}'`)
      expect(en).toContain(`'${k}'`)
    }
  })
})
