// #824: the live browser suite boots a disposable server that writes into THIS checkout's store/. Measured 2026-11-14: its teardown
// removed only the database and the token, so the leftover store/rate-limit-status/ made the next full `vitest run` in the same
// checkout red (code-bridge-limit-hold, 2 tests: the wake-phase hold read the leftover usage history). The teardown must remove
// everything the suite's server created, keep what store/ held before, and never touch a store it does not own.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error -- a Playwright-suite helper outside tsconfig's rootDir; vitest resolves it fine
import { prepareStore, cleanStore, MARKER_NAME } from '../../tests/browser-live/store-guard.ts'

let store: string
beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'live-store-test-')) })
afterEach(() => { fs.rmSync(store, { recursive: true, force: true }) })

function serverWrites(): void {
  fs.writeFileSync(path.join(store, 'claudeclaw.db'), 'x')
  fs.writeFileSync(path.join(store, 'claudeclaw.db-wal'), 'x')
  fs.writeFileSync(path.join(store, '.dashboard-token'), 't')
  fs.mkdirSync(path.join(store, 'rate-limit-status'), { recursive: true })
  fs.writeFileSync(path.join(store, 'rate-limit-status', 'history-marveen.jsonl'), '{}')
  fs.mkdirSync(path.join(store, 'locks'), { recursive: true })
  fs.writeFileSync(path.join(store, 'event-loop-stalls.jsonl'), '{}')
}

describe('#824 live browser suite store cleanup', () => {
  it('removes everything the server created (not only the database and the token), and keeps what was there before', () => {
    fs.writeFileSync(path.join(store, 'config-overrides.json'), '{}')
    fs.mkdirSync(path.join(store, 'photos'))
    expect(prepareStore(store).refuse).toBeUndefined()
    serverWrites()
    cleanStore(store)
    expect(fs.readdirSync(store).sort()).toEqual(['config-overrides.json', 'photos'])
  })

  it('refuses a store that holds a database the suite did not create, and leaves it untouched', () => {
    fs.writeFileSync(path.join(store, 'claudeclaw.db'), 'live data')
    fs.writeFileSync(path.join(store, '.dashboard-token'), 'secret')
    expect(prepareStore(store).refuse).toMatch(/REFUSING/)
    cleanStore(store) // no marker: nothing of this store is ours
    expect(fs.readdirSync(store).sort()).toEqual(['.dashboard-token', 'claudeclaw.db'])
  })

  it('after a crashed run the leftovers are cleaned and the original snapshot stays the truth', () => {
    fs.writeFileSync(path.join(store, 'config-overrides.json'), '{}')
    prepareStore(store)
    serverWrites() // the run crashed: no teardown
    expect(prepareStore(store).refuse).toBeUndefined()
    expect(fs.readdirSync(store).filter((f) => f !== MARKER_NAME)).toEqual(['config-overrides.json'])
    serverWrites()
    cleanStore(store)
    expect(fs.readdirSync(store)).toEqual(['config-overrides.json'])
  })

  it('a legacy marker (a bare timestamp) removes only the database and the token, never the rest', () => {
    fs.writeFileSync(path.join(store, 'config-overrides.json'), '{}')
    fs.writeFileSync(path.join(store, MARKER_NAME), String(Date.now()))
    serverWrites()
    cleanStore(store)
    expect(fs.readdirSync(store).sort()).toEqual(['config-overrides.json', 'event-loop-stalls.jsonl', 'locks', 'rate-limit-status'])
  })
})
