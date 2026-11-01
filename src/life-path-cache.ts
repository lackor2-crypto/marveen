/**
 * Short-lived cache for resolveLifePath (#stall). On the 9p depot mount one realpath / existsSync costs ~7 ms and
 * resolveLifePath does three of them per call; the background sweeps call it hundreds of times in a row, which froze
 * the dashboard for ~3.7 s. Within a few seconds the answer for the same path does not change, so remember it.
 * Anything that changes where a path leads (a mount saved) clears it.
 */
export const LIFE_PATH_TTL_MS = 3000
const MAX_ENTRIES = 5000
const cache = new Map<string, { at: number; value: string | null; root: string }>()

export function lifePathCacheGet(rel: string, root: string, now = Date.now()): { value: string | null } | undefined {
  const hit = cache.get(rel)
  if (!hit) return undefined
  if (hit.root !== root || now - hit.at > LIFE_PATH_TTL_MS) { cache.delete(rel); return undefined }
  return { value: hit.value }
}

export function lifePathCachePut(rel: string, root: string, value: string | null, now = Date.now()): void {
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(rel, { at: now, value, root })
}

export function clearLifePathCache(): void { cache.clear() }
