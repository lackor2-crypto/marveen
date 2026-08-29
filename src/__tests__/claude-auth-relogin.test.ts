/**
 * A KIJELENTKEZETT FIOK NEM UJ FIOK.
 *
 * Boss, 2026-08-29: a bejelentkezes-varazslot ugy akarta kiprobalni, hogy egy
 * meglevo fiokot kijelentkeztet, majd a varazsloval visszahozza. Merve
 * (2026-08-29 11:30, `claude auth status` + store/claude-plans.json):
 *
 *   - a `planIdFromLabel` MINDEN regisztralt tervet foglaltnak vett, tehat
 *     ugyanazt a nevet ujra beirva `usalackor-2` nevu MASODIK konyvtar nyilt,
 *   - az agens viszont a REGI konyvtarhoz van kotve (CLAUDE_CONFIG_DIR),
 *   - vagyis a varazslo sikert jelentett volna, mikozben az agens kijelentkezve
 *     marad. Nema hiba, pontosan az a fajta, amit a `fresh-install-usable`
 *     szabaly tilt: a beallitas egyszer elvegezheto, utana nincs ut vissza.
 *
 * Amit ez a teszt oriz: egy KIJELENTKEZETT terv nem foglalja a sajat nevet
 * (tehat javithato), egy BEJELENTKEZETT viszont igen (tehat nem irhato felul).
 */
import { describe, it, expect } from 'vitest'
import { idsBlockingReuse, planIdFromLabel } from '../claude-auth.js'

describe('idsBlockingReuse', () => {
  it('a bejelentkezett terv foglalja a nevet', () => {
    expect(idsBlockingReuse([{ id: 'usalackor', loggedIn: true }])).toEqual(['usalackor'])
  })

  it('a kijelentkezett terv NEM foglalja a nevet -- ez a javitas utja', () => {
    expect(idsBlockingReuse([{ id: 'usalackor', loggedIn: false }])).toEqual([])
  })

  it('vegyes listabol csak a bejelentkezettek maradnak', () => {
    expect(idsBlockingReuse([
      { id: 'usalackor', loggedIn: false },
      { id: 'lackor3', loggedIn: true },
    ])).toEqual(['lackor3'])
  })

  it('ures lista ures -- friss telepitesen semmi nem foglal nevet', () => {
    expect(idsBlockingReuse([])).toEqual([])
  })
})

describe('a nev feloldasa a ket allapotban', () => {
  const plans = (loggedIn: boolean) => [
    { id: 'usalackor', loggedIn },
    { id: 'lackor3', loggedIn: true },
  ]

  it('kijelentkezett fiok neve UGYANARRA az id-re oldodik fel (nincs -2)', () => {
    const taken = idsBlockingReuse(plans(false))
    expect(planIdFromLabel('Usalackor', taken)).toBe('usalackor')
  })

  it('bejelentkezett fiok neve tovabbra is felreteszi magat (-2)', () => {
    const taken = idsBlockingReuse(plans(true))
    expect(planIdFromLabel('Usalackor', taken)).toBe('usalackor-2')
  })

  it('egy masik terv bejelentkezett allapota nem szol bele', () => {
    const taken = idsBlockingReuse(plans(false))
    expect(planIdFromLabel('Lackor3', taken)).toBe('lackor3-2')
  })
})
