// #971: a phone backup is overwritten on the Drive under the same name. The collect walk sees the change
// from the Drive's modified time / size and brings the new state down as a DATED copy; the old file stays;
// a copy whose size differs from the Drive's is not kept.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectChanged, datedVersionName, restoreWalk, type RestoreEntry } from '../web/routes/drive-sync.js'

describe('datedVersionName', () => {
  it('puts the Drive change date before the extension; same-day second change adds the time; both taken -> null', () => {
    const none = () => false
    expect(datedVersionName('sms.xml', '2026-11-20T08:15:00.000Z', none)).toBe('sms (2026-11-20).xml')
    expect(datedVersionName('backup', '2026-11-20T08:15:00.000Z', none)).toBe('backup (2026-11-20)')
    const taken = new Set(['sms (2026-11-20).xml'])
    expect(datedVersionName('sms.xml', '2026-11-20T08:15:00.000Z', (n) => taken.has(n))).toBe('sms (2026-11-20 08-15).xml')
    taken.add('sms (2026-11-20 08-15).xml')
    expect(datedVersionName('sms.xml', '2026-11-20T08:15:00.000Z', (n) => taken.has(n))).toBeNull()
  })
})

describe('collectChanged', () => {
  const seen = { f1: { path: 'sms.xml', modifiedTime: '2026-11-19T10:00:00.000Z', size: 5, localMtimeMs: 0 } }
  it('changed size or modified time = changed; same = not; never recorded = not (nothing guessed)', () => {
    const c = collectChanged(seen)
    expect(c({ id: 'f1', name: 'sms.xml', size: '9', modifiedTime: '2026-11-19T10:00:00.000Z' })).toBe(true)
    expect(c({ id: 'f1', name: 'sms.xml', size: '5', modifiedTime: '2026-11-20T10:00:00.000Z' })).toBe(true)
    expect(c({ id: 'f1', name: 'sms.xml', size: '5', modifiedTime: '2026-11-19T10:00:00.000Z' })).toBe(false)
    expect(c({ id: 'other', name: 'sms.xml', size: '9', modifiedTime: '2026-11-20T10:00:00.000Z' })).toBe(false)
  })
})

describe('restoreWalk with a changed file (#971)', () => {
  const entry = (over: Partial<RestoreEntry> = {}): RestoreEntry => ({ id: 'f1', name: 'sms.xml', size: '9', modifiedTime: '2026-11-20T08:15:00.000Z', ...over })
  const walk = async (base: string, e: RestoreEntry, write = (n: number) => 'x'.repeat(n)) => restoreWalk({
    rootId: 'root', base, dryRun: false,
    list: async () => [e],
    download: async (f, dest) => { writeFileSync(dest, write(Number(f.size))); return Number(f.size) },
    changed: collectChanged({ f1: { path: 'sms.xml', modifiedTime: '2026-11-19T10:00:00.000Z', size: 5, localMtimeMs: 0 } }),
  })
  it('keeps the old file and writes the new state as a dated copy; the state points at the dated copy', async () => {
    const base = mkdtempSync(join(tmpdir(), 'c971-'))
    writeFileSync(join(base, 'sms.xml'), 'OLD05')
    const r = await walk(base, entry())
    expect(readFileSync(join(base, 'sms.xml'), 'utf8')).toBe('OLD05')
    expect(readdirSync(base).sort()).toEqual(['sms (2026-11-20).xml', 'sms.xml'])
    expect(r.versions).toBe(1)
    expect(r.state['f1']!.path).toBe('sms (2026-11-20).xml')
    // run again against the new state: nothing more comes down
    const again = await restoreWalk({ rootId: 'root', base, dryRun: false, list: async () => [entry()], download: async () => 0, changed: collectChanged(r.state) })
    expect(again.downloaded).toBe(0)
    expect(again.present).toBe(1)
    rmSync(base, { recursive: true, force: true })
  })
  it('a downloaded copy with the wrong size is removed and reported, not kept', async () => {
    const base = mkdtempSync(join(tmpdir(), 'c971-'))
    writeFileSync(join(base, 'sms.xml'), 'OLD05')
    const r = await walk(base, entry(), () => 'short')
    expect(readdirSync(base)).toEqual(['sms.xml'])
    expect(r.failed.length).toBe(1)
    expect(r.failed[0]!.reason).toMatch(/nem egyezik/)
    expect(r.versions).toBe(0)
    rmSync(base, { recursive: true, force: true })
  })
})

import { planVerifiedTrash } from '../web/routes/drive-sync.js'
describe('planVerifiedTrash (#971)', () => {
  it('only a Life-tree copy with the exact Drive size may leave the Drive', () => {
    const state = {
      a: { path: 'ok.xml', modifiedTime: '', size: 9, localMtimeMs: 0 },
      b: { path: 'missing.xml', modifiedTime: '', size: 9, localMtimeMs: 0 },
      c: { path: 'short.xml', modifiedTime: '', size: 9, localMtimeMs: 0 },
    }
    const sizes: Record<string, number> = { 'ok.xml': 9, 'short.xml': 4 }
    const p = planVerifiedTrash(state, (rel) => (rel in sizes ? sizes[rel]! : null))
    expect(p.ok).toEqual([{ driveId: 'a', path: 'ok.xml' }])
    expect(p.kept.map((k) => k.path).sort()).toEqual(['missing.xml', 'short.xml'])
  })
})
