// Boss (2026-11-03): a Versicherungsnummer "89 220275 K 006" nem K6 melleklet-hivatkozas (a levelet megis "K6 hianyzik"-nak jelolte).
import { describe, it, expect } from 'vitest'
import { annexRefs } from '../workbench-docannex.js'

const S = { annex_scheme: 'k', annex_prefix: 'K' } as const

describe('a K utan nullaval kezdodo szam, vagy szamjegy utani K nem melleklet-hivatkozas', () => {
  it('the insurance number is not a reference', () => {
    expect(annexRefs('Versicherungsnummer: 89 220275 K 006', S)).toEqual([])
    expect(annexRefs('89 220275 K 006 es K1', S)).toEqual([1])
  })
  it('real references still count', () => {
    expect(annexRefs('lasd K1, K 2 es K10', S)).toEqual([1, 2, 10])
    expect(annexRefs('K1–K3', S)).toEqual([1, 2, 3])
    expect(annexRefs('Anlage K4', { annex_scheme: 'anlage', annex_prefix: 'K' })).toEqual([4])
  })
})
