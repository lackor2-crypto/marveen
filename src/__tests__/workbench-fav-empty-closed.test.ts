// TG 3131: the Favorites folder starts closed while it is empty and open once it holds something.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf8')

describe('Favorites default state', () => {
  it('is decided by the number of visible favourites, not fixed open', () => {
    expect(js).toContain('if (key === FAV_KEY) return !(favs && favs.length)')
    expect(js).not.toMatch(/key === ROOT_KEY \|\| key === FAV_KEY/)
  })
  it('an explicit click still wins over the default', () => {
    const i = js.indexOf('function isShut(key)')
    const body = js.slice(i, i + 400)
    expect(body.indexOf('if (v !== undefined) return !!v')).toBeGreaterThan(-1)
    expect(body.indexOf('if (v !== undefined)')).toBeLessThan(body.indexOf('FAV_KEY'))
  })
})
