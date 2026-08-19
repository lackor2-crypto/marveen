// Boss, 2026-08-19: "az elso oszlop es masodik oszlop sem toltodik be hamar.
// sokat kell varni ra." A meres szerint nem az email-vegpontok voltak lassuak
// magukban: mikozben a hatterben futott a kapocs-vizsgalat (uzenetenkent egy
// kulon himalaya-processz, sajat IMAP-bejelentkezessel), az EGESZ dashboard
// beragadt -- /api/overview 11,5 mp, /api/settings 7,9 mp. Ezert amit egyszer
// megneztunk, azt tartosan eltesszuk: egy uzenet csatolmanya sose valtozik.
//
// Sandbox KENYSZERITVE, nem feltetelezve (lasd settings-store.test.ts, 2026-07-27
// eset): a STORE_PATH import-idoben rogzul, ezert a config mockja elobb kell.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'email-flag-store-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})

const {
  readAttachmentFlags,
  saveAttachmentFlags,
  flushAttachmentFlags,
  resetAttachmentFlagCache,
} = await import('../web/email-attachment-flag-store.js')

const FILE = join(SANDBOX, 'store', 'email-attachment-flags.json')

beforeEach(() => {
  resetAttachmentFlagCache()
  try { rmSync(FILE) } catch { /* nem letezik */ }
})

afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('tartos kapocs-cache', () => {
  it('ismeretlen levelrol nem allit semmit', () => {
    expect(readAttachmentFlags(['<a@pelda.example>'])).toEqual({})
  })

  it('a megnezett levelet legkozelebb mar tudja', () => {
    saveAttachmentFlags({ '<a@pelda.example>': true, '<b@pelda.example>': false })
    const known = readAttachmentFlags(['<a@pelda.example>', '<b@pelda.example>', '<c@pelda.example>'])
    expect(known).toEqual({ '<a@pelda.example>': true, '<b@pelda.example>': false })
    expect('<c@pelda.example>' in known, 'amit meg nem neztunk meg, az nem "nincs csatolmany"').toBe(false)
  })

  it('ujraindulas utan is tudja -- kulonben minden telepites ujra vegigskennelne', () => {
    saveAttachmentFlags({ '<a@pelda.example>': true })
    flushAttachmentFlags()
    expect(existsSync(FILE), 'a cache-nek lemezre kell kerulnie').toBe(true)
    resetAttachmentFlagCache()
    expect(readAttachmentFlags(['<a@pelda.example>'])).toEqual({ '<a@pelda.example>': true })
  })

  it('ures Message-ID-t nem tarol -- az nem azonositana levelet', () => {
    saveAttachmentFlags({ '': true })
    flushAttachmentFlags()
    const onDisk = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf-8')) : {}
    expect(Object.keys(onDisk)).toEqual([])
    expect(readAttachmentFlags([''])).toEqual({})
  })

  it('serult vagy idegen fajlra nem borul fel, csak ujratanul', () => {
    mkdirSync(join(SANDBOX, 'store'), { recursive: true })
    writeFileSync(FILE, 'ez nem json')
    resetAttachmentFlagCache()
    expect(readAttachmentFlags(['<a@pelda.example>'])).toEqual({})
    saveAttachmentFlags({ '<a@pelda.example>': true })
    expect(readAttachmentFlags(['<a@pelda.example>'])).toEqual({ '<a@pelda.example>': true })
  })

  it('nem-logikai ertekeket kiszurja a fajlbol', () => {
    mkdirSync(join(SANDBOX, 'store'), { recursive: true })
    writeFileSync(FILE, JSON.stringify({ '<a@pelda.example>': true, '<b@pelda.example>': 'igen', '<c@pelda.example>': null }))
    resetAttachmentFlagCache()
    const known = readAttachmentFlags(['<a@pelda.example>', '<b@pelda.example>', '<c@pelda.example>'])
    expect(known).toEqual({ '<a@pelda.example>': true })
  })

  it('a valtozatlan ertek nem ir ki fajlt feleslegesen', () => {
    saveAttachmentFlags({ '<a@pelda.example>': true })
    flushAttachmentFlags()
    const first = readFileSync(FILE, 'utf-8')
    rmSync(FILE)
    saveAttachmentFlags({ '<a@pelda.example>': true })
    flushAttachmentFlags()
    expect(existsSync(FILE), 'ugyanazt nem irjuk ki ujra').toBe(false)
    expect(JSON.parse(first)).toEqual({ '<a@pelda.example>': true })
  })

  it('kesleltetve, kotegelve ir -- egy oldalnyi level egy fajlirast jelent', () => {
    vi.useFakeTimers()
    saveAttachmentFlags({ '<a@pelda.example>': true })
    saveAttachmentFlags({ '<b@pelda.example>': false })
    expect(existsSync(FILE), 'azonnal meg nem ir').toBe(false)
    vi.advanceTimersByTime(2000)
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toEqual({ '<a@pelda.example>': true, '<b@pelda.example>': false })
    vi.useRealTimers()
  })
})
