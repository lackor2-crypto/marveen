// #927: a vanished entry used to make closeDirTree scan EVERY directory watcher (files included), so deleting thousands of
// files on a store with thousands of watched directories was quadratic work in one synchronous call: the stall sampler
// caught the dashboard frozen 3.7 s with closeDirTree on top of the stack. The fix indexes watchers by parent and walks
// only the vanished subtree. These tests pin the behaviour (right watchers closed, prefix siblings untouched) and the
// shape (no scan over the whole watcher map).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR || '/tmp'}/marveen-store-watcher-close-927-${process.pid}`,
  cbs: new Map<string, (eventType: string, filename: string | null) => void>(),
  closed: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  const watch = ((dir: string, _opts: unknown, cb: (e: string, f: string | null) => void) => {
    h.cbs.set(dir, cb)
    const w = new EventEmitter() as any
    w.close = () => { h.closed.push(dir) }
    return w
  }) as unknown as typeof actual.watch
  return { ...actual, watch, default: { ...actual, watch } }
})

vi.mock('../config.js', () => ({ STORE_DIR: h.dir }))
vi.mock('../db.js', () => ({ logStoreFileEvent: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { startStoreWatcher, stopStoreWatcher, storeWatcherReady } from '../store-watcher.js'

beforeAll(() => {
  rmSync(h.dir, { recursive: true, force: true })
  mkdirSync(`${h.dir}/proj/sub/deep`, { recursive: true })
  mkdirSync(`${h.dir}/proj/other`, { recursive: true })
  mkdirSync(`${h.dir}/proja`, { recursive: true })
  writeFileSync(`${h.dir}/proj/sub/f.txt`, 'x')
})
afterAll(() => { rmSync(h.dir, { recursive: true, force: true }) })

beforeEach(async () => {
  h.closed.length = 0
  h.cbs.clear()
  startStoreWatcher()
  await storeWatcherReady()
  h.closed.length = 0
})
afterEach(() => { stopStoreWatcher() })

describe('store-watcher closeDirTree (#927)', () => {
  it('a vanished directory closes exactly its own subtree, not a prefix-named sibling', () => {
    rmSync(`${h.dir}/proj`, { recursive: true, force: true })
    try {
      h.cbs.get(h.dir)!('rename', 'proj')
      expect([...h.closed].sort()).toEqual([
        `${h.dir}/proj`, `${h.dir}/proj/other`, `${h.dir}/proj/sub`, `${h.dir}/proj/sub/deep`,
      ])
      expect(h.closed).not.toContain(`${h.dir}/proja`)
    } finally {
      mkdirSync(`${h.dir}/proj/sub/deep`, { recursive: true })
      mkdirSync(`${h.dir}/proj/other`, { recursive: true })
      writeFileSync(`${h.dir}/proj/sub/f.txt`, 'x')
    }
  })

  it('a vanished file closes nothing', () => {
    h.cbs.get(`${h.dir}/proj/sub`)!('rename', 'gone.txt')
    expect(h.closed).toEqual([])
  })

  it('a vanished mid-level directory closes its descendants and leaves its parent watched', () => {
    rmSync(`${h.dir}/proj/sub`, { recursive: true, force: true })
    try {
      h.cbs.get(`${h.dir}/proj`)!('rename', 'sub')
      expect([...h.closed].sort()).toEqual([`${h.dir}/proj/sub`, `${h.dir}/proj/sub/deep`])
    } finally {
      mkdirSync(`${h.dir}/proj/sub/deep`, { recursive: true })
      writeFileSync(`${h.dir}/proj/sub/f.txt`, 'x')
    }
  })
})

describe('store-watcher closeDirTree shape (#927)', () => {
  it('does not scan every directory watcher for a vanished entry', () => {
    const src = readFileSync(join(__dirname, '..', 'store-watcher.ts'), 'utf8')
    const body = src.slice(src.indexOf('function closeDirTree'), src.indexOf('async function walkTree'))
    expect(body.length).toBeGreaterThan(50)
    expect(body).not.toMatch(/of dirWatchers\b/)
  })
})
