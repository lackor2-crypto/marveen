// Card #409 (owner, TG 6572/6575, 2026-09-26): the installed phone app showed
// only its launch icon when the phone could not reach this machine. The
// service worker now shows a stored offline page in that one case. The earlier
// caching worker broke iOS loads (respondWith null on a cache miss, 6fc6afc2)
// and a kill-switch caused a reload loop (dc7f2962), so these tests pin the
// rules that keep this worker out of both failures. sw.js is RUN here, not
// just read.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const SW = readFileSync(join(root, 'web', 'sw.js'), 'utf8')
const OFFLINE = readFileSync(join(root, 'web', 'offline.html'), 'utf8')
const INDEX = readFileSync(join(root, 'web', 'index.html'), 'utf8')
const STATIC = readFileSync(join(root, 'src', 'web', 'routes', 'static.ts'), 'utf8')

const ORIGIN = 'https://box.example.ts.net'
const ERROR = { type: 'error' }

type Listener = (ev: any) => void

function loadWorker(opts: { fetch: (req: any) => Promise<any>; cached?: any; cacheKeys?: string[] }) {
  const listeners: Record<string, Listener> = {}
  const deleted: string[] = []
  const added: string[] = []
  const calls = { reload: 0, claim: 0 }
  const caches = {
    open: async () => ({ add: async (r: any) => { added.push(typeof r === 'string' ? r : r.url) } }),
    match: async () => opts.cached,
    keys: async () => opts.cacheKeys || [],
    delete: async (k: string) => { deleted.push(k); return true },
  }
  const self: any = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: Listener) => { listeners[t] = fn },
    skipWaiting: () => {},
    clients: { claim: () => { calls.claim++ } },
  }
  class Req { url: string; cache?: string; constructor(u: string, i: any = {}) { this.url = u; this.cache = i.cache } }
  const ctx = vm.createContext({
    self, caches, fetch: opts.fetch, Request: Req, URL,
    Response: { error: () => ERROR }, setTimeout, clearTimeout, Promise,
  })
  vm.runInContext(SW, ctx)
  return { listeners, deleted, added, calls }
}

function fetchEvent(url: string, mode = 'navigate', method = 'GET') {
  const ev: any = { request: { url: ORIGIN + url, mode, method }, responded: null }
  ev.respondWith = (p: Promise<any>) => { ev.responded = p }
  return ev
}

describe('offline service worker (#409)', () => {
  it('app page loads normally: the network answer is passed through untouched', async () => {
    const page = { status: 200 }
    const w = loadWorker({ fetch: async () => page })
    const ev = fetchEvent('/')
    w.listeners.fetch(ev)
    expect(await ev.responded).toBe(page)
  })

  it('an HTTP error answer is NOT replaced by the offline page (the machine did answer)', async () => {
    const err = { status: 502 }
    const w = loadWorker({ fetch: async () => err, cached: { offline: true } })
    const ev = fetchEvent('/index.html')
    w.listeners.fetch(ev)
    expect(await ev.responded).toBe(err)
  })

  it('machine unreachable: the stored offline page is shown', async () => {
    const offline = { offline: true }
    const w = loadWorker({ fetch: async () => { throw new TypeError('Failed to fetch') }, cached: offline })
    const ev = fetchEvent('/?x=1')
    w.listeners.fetch(ev)
    expect(await ev.responded).toBe(offline)
  })

  it('offline page not stored: Response.error(), NEVER null (the old iOS failure)', async () => {
    const w = loadWorker({ fetch: async () => { throw new TypeError('Failed to fetch') }, cached: undefined })
    const ev = fetchEvent('/')
    w.listeners.fetch(ev)
    expect(await ev.responded).toBe(ERROR)
  })

  it('/api, downloads, scripts and foreign origins are not touched at all', () => {
    const w = loadWorker({ fetch: async () => ({}) })
    for (const ev of [
      fetchEvent('/api/overview', 'cors'),
      fetchEvent('/api/workbench/items/w1/handoff.zip'), // a navigate-mode download
      fetchEvent('/app.js', 'no-cors'),
      fetchEvent('/', 'navigate', 'POST'),
    ]) {
      w.listeners.fetch(ev)
      expect(ev.responded).toBeNull()
    }
    const foreign: any = { request: { url: 'https://other.example/', mode: 'navigate', method: 'GET' }, responded: null, respondWith(p: any) { this.responded = p } }
    w.listeners.fetch(foreign)
    expect(foreign.responded).toBeNull()
  })

  it('install stores ONLY the offline page; activate purges the old app-shell caches', async () => {
    const w = loadWorker({ fetch: async () => ({}), cacheKeys: ['marveen-shell-v2', 'marveen-offline-v1'] })
    let p: Promise<unknown> | null = null
    w.listeners.install({ waitUntil: (x: Promise<unknown>) => { p = x } })
    await p
    expect(w.added).toEqual(['/offline.html'])
    w.listeners.activate({ waitUntil: (x: Promise<unknown>) => { p = x } })
    await p
    expect(w.deleted).toEqual(['marveen-shell-v2'])
  })

  it('never reloads, claims or navigates pages (the old reload loop)', () => {
    const code = SW.replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\.reload\(|clients\.claim|\.navigate\(|matchAll/)
  })
})

describe('offline page (#409)', () => {
  it('stands alone: no external script, stylesheet or image', () => {
    expect(OFFLINE).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|<img\s/)
  })

  it('says it in both languages, with what to do, and retries only on a click', () => {
    expect(OFFLINE).toContain('data-lang="hu"')
    expect(OFFLINE).toContain('data-lang="en"')
    expect(OFFLINE).toContain('Tailscale')
    expect(OFFLINE).toContain('Újra próbálom')
    expect(OFFLINE).toContain('Try again')
    const script = OFFLINE.slice(OFFLINE.lastIndexOf('<script>'))
    expect(script.match(/location\.reload\(\)/g)?.length).toBe(1)
    expect(script).toMatch(/addEventListener\('click'/)
    expect(script).not.toMatch(/setTimeout|setInterval/)
  })
})

describe('wiring (#409)', () => {
  it('index.html registers /sw.js and no longer unregisters every worker', () => {
    expect(INDEX).toMatch(/register\('\/sw\.js'/)
    expect(INDEX).not.toMatch(/regs\.forEach\(\(r\) => r\.unregister\(\)\)/)
    expect(INDEX).not.toMatch(/addEventListener\(['"]controllerchange/)
  })

  it('the server serves /offline.html and /sw.js', () => {
    expect(STATIC).toContain("path === '/offline.html'")
    expect(STATIC).toContain("path === '/sw.js'")
  })
})
