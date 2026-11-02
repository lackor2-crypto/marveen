import { describe, it, expect } from 'vitest'
import { lifePathCacheGet, lifePathCachePut, clearLifePathCache, LIFE_PATH_TTL_MS, realRootCached, REAL_ROOT_TTL_MS } from '../life-path-cache.js'

describe('life path cache (dashboard stall fix)', () => {
  it('returns a remembered answer within the TTL and forgets it after', () => {
    clearLifePathCache()
    lifePathCachePut('a/b', '/root', '/root/a/b', 1000)
    expect(lifePathCacheGet('a/b', '/root', 1000 + LIFE_PATH_TTL_MS - 1)?.value).toBe('/root/a/b')
    expect(lifePathCacheGet('a/b', '/root', 1000 + LIFE_PATH_TTL_MS + 1)).toBeUndefined()
  })
  it('does not answer for another root and clears on demand', () => {
    clearLifePathCache()
    lifePathCachePut('x', '/r1', '/r1/x', 5)
    expect(lifePathCacheGet('x', '/r2', 6)).toBeUndefined()
    lifePathCachePut('x', '/r1', '/r1/x', 5)
    clearLifePathCache()
    expect(lifePathCacheGet('x', '/r1', 6)).toBeUndefined()
  })
  it('remembers the real root for a while, per root, and not a failure', () => {
    clearLifePathCache()
    let calls = 0
    const f = (r: string) => { calls++; return r + '/real' }
    expect(realRootCached('/r', f, 100)).toBe('/r/real')
    expect(realRootCached('/r', f, 100 + REAL_ROOT_TTL_MS - 1)).toBe('/r/real')
    expect(calls).toBe(1)
    expect(realRootCached('/other', f, 200)).toBe('/other/real')
    expect(calls).toBe(2)
    clearLifePathCache()
    expect(() => realRootCached('/gone', () => { throw new Error('ENOENT') }, 300)).toThrow()
    expect(realRootCached('/gone', f, 301)).toBe('/gone/real')
  })
})
