import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brakeAlertText, planRemoteDeletions, VESZFEK_KUSZOB } from '../drive-remote-delete.js'

const all = () => true

describe('planRemoteDeletions (backup pair, remote delete)', () => {
  it('queues a file deleted remotely but still on disk, and marks it', () => {
    const r = planRemoteDeletions({ a: { path: 'x/a.txt', size: 3 }, b: { path: 'b.txt' } }, new Set(['b']), true, all)
    expect(r.queue).toEqual([{ driveId: 'a', relPath: 'x/a.txt', size: 3 }])
    expect(r.newlyMarked).toEqual(['a'])
    expect(r.brake).toBe(false)
  })
  it('an incomplete scan concludes nothing', () => {
    const r = planRemoteDeletions({ a: { path: 'a' } }, new Set(), false, all)
    expect(r.queue).toEqual([])
    expect(r.newlyMarked).toEqual([])
  })
  it('an already marked file stays queued but does not count toward the brake again', () => {
    const r = planRemoteDeletions({ a: { path: 'a', remoteDeleted: true } }, new Set(), true, all)
    expect(r.queue.length).toBe(1)
    expect(r.newlyMarked).toEqual([])
  })
  it('gone on both sides -> entry dropped, nothing queued', () => {
    const r = planRemoteDeletions({ a: { path: 'a' } }, new Set(), true, () => false)
    expect(r.dropped).toEqual(['a'])
    expect(r.queue).toEqual([])
  })
  it('restored remotely -> marker cleared', () => {
    const r = planRemoteDeletions({ a: { path: 'a', remoteDeleted: true } }, new Set(['a']), true, all)
    expect(r.cleared).toEqual(['a'])
  })
  it('more than the threshold vanishing at once pulls the brake', () => {
    const st: Record<string, { path: string }> = {}
    for (let i = 0; i <= VESZFEK_KUSZOB; i++) st['f' + i] = { path: 'f' + i }
    expect(planRemoteDeletions(st, new Set(), true, all).brake).toBe(true)
    delete st.f0
    expect(planRemoteDeletions(st, new Set(), true, all).brake).toBe(false)
  })
  it('alert text in both languages says nothing was deleted', () => {
    expect(brakeAlertText('hu', 60, 'X')).toContain('semmit nem töröltem')
    expect(brakeAlertText('en', 60, 'X')).toContain('nothing was deleted')
  })
})

describe('drive-sync wiring', () => {
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'drive-sync.ts'), 'utf8')
  it('upload phase skips remote-deleted files (no endless re-upload)', () => {
    expect(route).toContain('if (known?.remoteDeleted) continue')
  })
  it('backup pairs run the remote-delete plan and alert on the brake', () => {
    expect(route).toContain('planRemoteDeletions(state, latottIdk')
    expect(route).toContain('sendMarveenAlert(brakeAlertText(')
  })
  it('reupload action + bulk endpoint exist', () => {
    expect(route).toContain("data.action === 'reupload'")
    expect(route).toContain("path === '/api/drive/sync/deletions/reupload-pair'")
  })
})
