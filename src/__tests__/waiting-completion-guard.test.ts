import { describe, it, expect } from 'vitest'
import { checkWaitingMove } from '../web/waiting-completion-guard.js'

const base = { prevStatus: 'in_progress', newStatus: 'waiting', agentCaller: true, allPointsDone: true, confirmOpenParts: undefined, children: [] as { seq?: number; title: string; status: string }[] }

describe('waiting completion guard (#464)', () => {
  it('lets a finished card through', () => {
    expect(checkWaitingMove(base)).toBeNull()
  })
  it('ignores moves that are not into waiting, and cards already in waiting', () => {
    expect(checkWaitingMove({ ...base, newStatus: 'in_progress', allPointsDone: undefined })).toBeNull()
    expect(checkWaitingMove({ ...base, prevStatus: 'waiting', allPointsDone: undefined })).toBeNull()
  })
  it('refuses an agent that did not state all_points_done', () => {
    const r = checkWaitingMove({ ...base, allPointsDone: undefined })
    expect(r?.error).toBe('completion_unconfirmed')
    expect(r?.message).toContain('all_points_done')
  })
  it('does not accept a truthy string as the statement', () => {
    expect(checkWaitingMove({ ...base, allPointsDone: 'true' })?.error).toBe('completion_unconfirmed')
  })
  it('does not ask a browser session for the statement', () => {
    expect(checkWaitingMove({ ...base, agentCaller: false, allPointsDone: undefined })).toBeNull()
  })
  it('refuses while a sub-card is open, even for an agent that states done', () => {
    const r = checkWaitingMove({ ...base, children: [{ seq: 465, title: 'step 2', status: 'in_progress' }, { seq: 466, title: 'step 1', status: 'waiting' }] })
    expect(r?.error).toBe('open_subtasks')
    expect(r?.open).toHaveLength(1)
    expect(r?.message).toContain('#465')
    expect(r?.message).not.toContain('#466')
  })
  it('sub-cards in waiting or done count as finished', () => {
    expect(checkWaitingMove({ ...base, children: [{ seq: 1, title: 'a', status: 'waiting' }, { seq: 2, title: 'b', status: 'done' }] })).toBeNull()
  })
  it('lets the person confirm that open sub-cards may stay open', () => {
    expect(checkWaitingMove({ ...base, agentCaller: false, allPointsDone: undefined, confirmOpenParts: true, children: [{ seq: 3, title: 'c', status: 'planned' }] })).toBeNull()
  })
})
