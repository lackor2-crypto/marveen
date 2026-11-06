// #860: the watcher is now one non-recursive fs.watch per directory (found by an async walk), so an event is
// delivered to the callback of the directory it happened in, with the bare file name. `emit(rel)` below does that.
// WHY THIS FILE EXISTS: on Linux, Node's recursive fs.watch emitted a 'rename'
// event for every directory it walked while it set itself up. scanStore()
// only puts FILES into knownFiles, so each of those directory events used to
// pass the "not known yet" check and be logged as a newly created file -- on
// every boot, for every directory under store/ (one measured start wrote
// 26 527 audit rows, the same directory 22 times across restarts, and the
// synchronous INSERTs held the event loop for ~20 s before the port answered).
// The directory test fails if the isDirectory() skip is removed; the file test
// is the positive control that the watcher still records a real new file.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR || '/tmp'}/marveen-store-watcher-dir-test-${process.pid}`,
  cbs: new Map<string, (eventType: string, filename: string | null) => void>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  const watch = ((dir: string, _opts: unknown, cb: (e: string, f: string | null) => void) => {
    h.cbs.set(dir, cb)
    const w = new EventEmitter() as any
    w.close = () => {}
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
import { logStoreFileEvent } from '../db.js'

beforeAll(() => {
  // A leftover tree from an interrupted run (same pid reused) would put the
  // "new" files into knownFiles at start and break the positive control.
  rmSync(h.dir, { recursive: true, force: true })
  mkdirSync(`${h.dir}/existing-dir/nested`, { recursive: true })
  writeFileSync(`${h.dir}/existing-dir/known.txt`, 'x')
})

afterAll(() => {
  rmSync(h.dir, { recursive: true, force: true })
})

/** The event the OS would deliver to the watcher of the directory that holds `rel`. */
function emit(eventType: string, rel: string): void {
  const cut = rel.lastIndexOf('/')
  const dir = cut < 0 ? h.dir : `${h.dir}/${rel.slice(0, cut)}`
  const cb = h.cbs.get(dir)
  if (!cb) throw new Error(`no watcher on ${dir}`)
  cb(eventType, cut < 0 ? rel : rel.slice(cut + 1))
}

beforeEach(async () => {
  vi.mocked(logStoreFileEvent).mockClear()
  h.cbs.clear()
  startStoreWatcher()
  await storeWatcherReady()
})

afterEach(() => {
  stopStoreWatcher()
})

describe('store-watcher: directories are not logged as created files', () => {
  it('ignores the rename events the recursive watcher emits for existing directories', () => {
    emit('rename', 'existing-dir')
    emit('rename', 'existing-dir/nested')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })

  it('ignores a directory created after start', () => {
    mkdirSync(`${h.dir}/new-dir`, { recursive: true })
    emit('rename', 'new-dir')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })

  it('still logs a file created after start (positive control)', () => {
    writeFileSync(`${h.dir}/existing-dir/agent-made.txt`, 'hello')
    emit('rename', 'existing-dir/agent-made.txt')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('existing-dir/agent-made.txt')
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][3]).toBe(5)
  })

  it('still logs a new symlink that points to a directory', () => {
    symlinkSync(`${h.dir}/existing-dir/nested`, `${h.dir}/link-to-dir`)
    emit('rename', 'link-to-dir')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('link-to-dir')
  })

  it('logs a file again after a known file was replaced by a directory and back', async () => {
    writeFileSync(`${h.dir}/swap`, 'a')
    stopStoreWatcher()
    startStoreWatcher() // swap is now a known file
    await storeWatcherReady()
    rmSync(`${h.dir}/swap`)
    mkdirSync(`${h.dir}/swap`)
    emit('rename', 'swap')
    rmSync(`${h.dir}/swap`, { recursive: true })
    writeFileSync(`${h.dir}/swap`, 'bb')
    emit('rename', 'swap')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('swap')
  })

  it('does not log a file that was already there at start', () => {
    emit('rename', 'existing-dir/known.txt')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })
})

describe('store-watcher: every directory is watched, new ones as they appear', () => {
  it('watches the root and every nested directory that exists at start', () => {
    expect([...h.cbs.keys()]).toEqual(expect.arrayContaining([h.dir, `${h.dir}/existing-dir`, `${h.dir}/existing-dir/nested`]))
  })

  it('adopts a directory created after start and catches up the files already inside it', async () => {
    mkdirSync(`${h.dir}/fresh/deep`, { recursive: true })
    writeFileSync(`${h.dir}/fresh/deep/early.txt`, 'abc')
    emit('rename', 'fresh')
    await vi.waitFor(() => expect(h.cbs.has(`${h.dir}/fresh/deep`)).toBe(true))
    await vi.waitFor(() => expect(logStoreFileEvent).toHaveBeenCalledTimes(1))
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('fresh/deep/early.txt')
    // a file created later in the new directory is seen through its own watcher
    writeFileSync(`${h.dir}/fresh/deep/late.txt`, 'x')
    emit('rename', 'fresh/deep/late.txt')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(2)
  })

  it('the walk does not read the tree with a synchronous readdir (the 3.3 s stall of #860)', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../store-watcher.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('readdirSync')
    expect(src).not.toContain('recursive: true')
  })
})
