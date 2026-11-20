import { describe, it, expect, vi, beforeEach } from 'vitest'

const resolveCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../life-explorer.js', () => ({ resolveLifePath: (rel: string) => { resolveCalls.n++; return rel ? null : null } }))
vi.mock('../projects.js', () => ({ getProject: () => ({ folder_path: 'P' }) }))
vi.mock('../project-places.js', () => ({ listProjectPlaces: () => ['A/B'] }))
vi.mock('../workbench-doc-links.js', () => ({ listProjectDocs: () => ({ docs: [], attachments: [] }) }))
vi.mock('../workbench-docannex.js', () => ({ listAnnexes: () => [] }))
vi.mock('../workbench-assets.js', () => ({ ensureAssetTables: () => {}, findWorkItemsBox: () => '', PROJECT_ROOT_PLACE: '' }))
vi.mock('../db.js', () => ({ getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) }) }))

import { projectPlacesView, clearProjectPlacesCache, PLACES_TTL_MS } from '../project-places-auto.js'

// #949: the places view asked the slow Windows mount thousands of times per answer and froze the dashboard for 10+ s.
describe('projectPlacesView remembers its answer (#949)', () => {
  beforeEach(() => { clearProjectPlacesCache(); resolveCalls.n = 0 })
  it('a repeat within the TTL touches the file system zero times', () => {
    const t0 = 1_000_000
    projectPlacesView('p1', { now: t0 })
    const first = resolveCalls.n
    expect(first).toBeGreaterThan(0)
    projectPlacesView('p1', { now: t0 + 1000 })
    expect(resolveCalls.n).toBe(first)
  })
  it('after the TTL, or when asked for fresh, it measures again', () => {
    const t0 = 1_000_000
    projectPlacesView('p1', { now: t0 })
    const first = resolveCalls.n
    projectPlacesView('p1', { now: t0 + PLACES_TTL_MS + 1 })
    expect(resolveCalls.n).toBe(first * 2)
    projectPlacesView('p1', { now: t0 + PLACES_TTL_MS + 2, fresh: true })
    expect(resolveCalls.n).toBe(first * 3)
  })
  it('the cache is per project', () => {
    projectPlacesView('p1', { now: 5 })
    const first = resolveCalls.n
    projectPlacesView('p2', { now: 6 })
    expect(resolveCalls.n).toBe(first * 2)
  })
})

describe('every write drops the remembered view (#949)', () => {
  it('web.ts clears it before any non-GET /api/ request', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/method !== 'GET' && path\.startsWith\('\/api\/'\)\) \{ clearProjectPlacesCache\(\); clearProjectItemFilesCache\(\) \}/)
  })
})
