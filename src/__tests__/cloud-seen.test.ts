// WHAT A CLOUD FOLDER HELD BEFORE STAYS ON THE PAGE, MARKED (#511, MEGA).
//
// MEGA's rubbish bin cannot be listed, so the page remembers a folder's last
// complete listing. An item that was there and is not any more is "gone" until
// the owner dismisses it -- and what he himself does on the page is forgotten
// at once, so his own rename never comes back as "deleted in the cloud".
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-cloudseen-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { reconcileFolder, rememberListing, forgetSeen, forgetAccount } = await import('../cloud-seen.js')
const file = join(store, 'cloud-seen.json')
const f = (name: string, size: number | null = 1, isDir = false) => ({ name, isDir, size })
const T1 = new Date('2026-10-01T10:00:00Z')
const T2 = new Date('2026-10-02T10:00:00Z')
const T3 = new Date('2026-10-03T10:00:00Z')

beforeEach(() => rmSync(file, { force: true }))
afterAll(() => rmSync(store, { recursive: true, force: true }))

describe('reconcileFolder (pure)', () => {
  it('a first look remembers everything and reports nothing gone', () => {
    const r = reconcileFolder({}, [f('a'), f('b')], 'T1')
    expect(r.gone).toEqual([])
    expect(Object.keys(r.after).sort()).toEqual(['a', 'b'])
    expect(r.changed).toBe(true)
  })
  it('an unchanged folder changes nothing (no rewrite on every page load)', () => {
    const one = reconcileFolder({}, [f('a')], 'T1')
    const two = reconcileFolder(one.after, [f('a')], 'T2')
    expect(two.changed).toBe(false)
    expect(two.after.a.seenAt).toBe('T1')
  })
  it('a missing item is gone, keeps its first goneAt, and comes back clean', () => {
    const one = reconcileFolder({}, [f('a'), f('b', 7)], 'T1')
    const two = reconcileFolder(one.after, [f('a')], 'T2')
    expect(two.gone).toEqual([{ name: 'b', isDir: false, size: 7, seenAt: 'T1', goneAt: 'T2' }])
    const three = reconcileFolder(two.after, [f('a')], 'T3')
    expect(three.gone[0].goneAt).toBe('T2')
    expect(three.changed).toBe(false)
    const back = reconcileFolder(three.after, [f('a'), f('b', 7)], 'T4')
    expect(back.gone).toEqual([])
    expect(back.after.b).toEqual({ isDir: false, size: 7, seenAt: 'T4' })
  })
})

describe('rememberListing / forgetSeen (on disk)', () => {
  it('a fresh install has no file and a first listing reports nothing gone', () => {
    expect(existsSync(file)).toBe(false)
    expect(rememberListing('mega', 'acc', 'Docs', [f('a.pdf'), f('Sub', null, true)], T1)).toEqual([])
    expect(existsSync(file)).toBe(true)
  })
  it('what vanished from the folder is returned with its path, per account and folder', () => {
    rememberListing('mega', 'acc', 'Docs', [f('a.pdf', 5), f('b.pdf', 6)], T1)
    rememberListing('mega', 'other', 'Docs', [f('a.pdf', 5)], T1)
    rememberListing('mega', 'acc', '', [f('root.txt')], T1)
    const gone = rememberListing('mega', 'acc', 'Docs', [f('a.pdf', 5)], T2)
    expect(gone).toEqual([{ name: 'b.pdf', path: 'Docs/b.pdf', isDir: false, size: 6, seenAt: T1.toISOString(), goneAt: T2.toISOString() }])
    expect(rememberListing('mega', 'other', 'Docs', [f('a.pdf', 5)], T2)).toEqual([])
    expect(rememberListing('mega', 'acc', '', [], T2).map((g) => g.path)).toEqual(['root.txt'])
  })
  it('the file is not rewritten when nothing changed', () => {
    rememberListing('mega', 'acc', 'Docs', [f('a.pdf')], T1)
    const before = statSync(file).mtimeMs
    const raw = readFileSync(file, 'utf8')
    rememberListing('mega', 'acc', 'Docs', [f('a.pdf')], T2)
    expect(readFileSync(file, 'utf8')).toBe(raw)
    expect(statSync(file).mtimeMs).toBe(before)
  })
  it('a dismissed item does not come back; forgetting a folder forgets what is under it', () => {
    rememberListing('mega', 'acc', 'Docs', [f('a.pdf'), f('Sub', null, true)], T1)
    rememberListing('mega', 'acc', 'Docs/Sub', [f('deep.txt')], T1)
    rememberListing('mega', 'acc', 'Docs/Sub/More', [f('x')], T1)
    expect(rememberListing('mega', 'acc', 'Docs', [], T2).map((g) => g.name)).toEqual(['a.pdf', 'Sub'])
    expect(forgetSeen('mega', 'acc', 'Docs/a.pdf')).toBe(true)
    expect(forgetSeen('mega', 'acc', '/Docs/Sub/')).toBe(true)
    expect(rememberListing('mega', 'acc', 'Docs', [], T3)).toEqual([])
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw['mega:acc']).toEqual({})
    expect(forgetSeen('mega', 'acc', 'Docs/a.pdf')).toBe(false)
    expect(forgetSeen('mega', 'acc', '')).toBe(false)
  })
  it("the owner's own rename on the page is not 'deleted in the cloud'", () => {
    rememberListing('mega', 'acc', 'Docs', [f('regi.pdf')], T1)
    forgetSeen('mega', 'acc', 'Docs/regi.pdf')
    expect(rememberListing('mega', 'acc', 'Docs', [f('uj.pdf')], T2)).toEqual([])
  })
  it('taking an account off forgets it; a broken file reads as empty, never throws', async () => {
    rememberListing('mega', 'acc', 'Docs', [f('a')], T1)
    forgetAccount('mega', 'acc')
    expect(rememberListing('mega', 'acc', 'Docs', [], T2)).toEqual([])
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{not json', 'utf8')
    expect(rememberListing('mega', 'acc', 'Docs', [f('a')], T3)).toEqual([])
  })
})
