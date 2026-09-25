/**
 * #396 Phase 4 -- the rules before a restore may start: the automatic
 * pre-restore backup must succeed (only a fresh install, with nothing to
 * protect, may go on without it); an install that cannot restart itself
 * refuses; the plan file carries the paused DB tasks.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup } from '../backup/create.js'
import { generateRecoveryKey } from '../backup/crypto.js'
import { openPreview, startRestore, RestoreError } from '../backup/restore-service.js'
import { populatedInstall, emptyInstall, makeDb } from './backup-fixture.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const key = generateRecoveryKey()

const A = populatedInstall('start-a'); roots.push(A.root)
const made = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, encrypt: { kdfN: 1024 }, appVersion: '1.29.0', appCommit: 't' })

async function preview(B: ReturnType<typeof emptyInstall>) {
  const ctx = { projectRoot: B.projectRoot, storeDir: B.storeDir, home: B.home }
  const p = await openPreview({ file: made.file!, uploaded: false, key, ctx, appVersion: '1.29.0', currentDb: join(B.storeDir, 'claudeclaw.db') })
  return { ctx, p }
}

describe('startRestore', () => {
  it('a failed pre-restore backup stops the restore on an install with data', async () => {
    const B = emptyInstall('start-b1'); roots.push(B.root)
    makeDb(join(B.storeDir, 'claudeclaw.db'), 3, 3)
    const { ctx, p } = await preview(B)
    let launched = ''
    await expect(startRestore(p.id, [], { ctx, unit: 'x.service', preBackup: async () => ({ ok: false, error: 'io_error', detail: 'disk full' }), launch: (f) => { launched = f } }))
      .rejects.toMatchObject({ code: 'pre_backup_failed' })
    expect(launched).toBe('')
  })

  it('on a fresh install it goes on without one, and writes the plan', async () => {
    const B = emptyInstall('start-b2'); roots.push(B.root)
    makeDb(join(B.storeDir, 'claudeclaw.db'), 0, 0)
    const { ctx, p } = await preview(B)
    let launched = ''
    const r = await startRestore(p.id, ['skills'], { ctx, unit: 'marveen-dashboard.service', preBackup: async () => ({ ok: false, error: 'io_error' }), launch: (f) => { launched = f } })
    expect(r.preBackup).toBe('skipped_fresh')
    const plan = JSON.parse(readFileSync(launched, 'utf8'))
    expect(plan.unit).toBe('marveen-dashboard.service')
    expect(plan.excluded).toEqual(['skills'])
    expect(plan.items.some((i: any) => i.category === 'skills')).toBe(false)
    expect(existsSync(plan.stagingDir)).toBe(true)
  })

  it('an install that cannot restart itself refuses with the reason', async () => {
    const B = emptyInstall('start-b3'); roots.push(B.root)
    const { ctx, p } = await preview(B)
    const err = await startRestore(p.id, [], { ctx, unit: null, unitReason: 'not a service', preBackup: async () => ({ ok: true }), launch: () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(RestoreError)
    expect(err.code).toBe('cannot_restart')
  })

  it('an unknown preview is "expired", not a crash', async () => {
    const B = emptyInstall('start-b4'); roots.push(B.root)
    await expect(startRestore('nope', [], { ctx: { projectRoot: B.projectRoot, storeDir: B.storeDir, home: B.home }, unit: 'x', preBackup: async () => ({ ok: true }), launch: () => {} }))
      .rejects.toMatchObject({ code: 'preview_expired' })
  })
})
