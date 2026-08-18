// A piszkozat nem kezbesites.
//
// `scripts/gmail-send.py` szandekosan `draft` modban fut: a tenylegles kuldes
// "level2 -- only on explicit Boss instruction". Ezert amikor a WhatsApp
// mind a 4 probalkozason bukik, a fallback legfeljebb egy Gmail-piszkozatot
// hagy maga utan -- a cimzett (Kiss Zoltan) ilyenkor SEMMIT nem kapott.
//
// A `whatsapp-send.py` viszont ezt a piszkozatot sikerkent adta vissza
// (`return send_email_fallback(...)`), tehat a folyamat 0-val lepett ki. Az
// arany-elemzes scheduled task szabalya pedig az volt, hogy "csak akkor szolj
// Bossnak, ha MIND a ketto bukott" -- igy a csendes ag futott le: Bossnak nem
// szolt senki, es az uzenet sem ment el. Ket egyenkent vedheto dontes
// (biztonsagos draft-alapertelmezes + csendes heartbeat) egyutt nemma
// uzenetvesztest adott.
//
// Ez a teszt a forrast rogziti, mert a python script nem fut a vitest alatt.
// A VISELKEDEST a `scripts/whatsapp-send-selftest.py` meri (harom eset, kuldes
// nelkul, kicserelt kuldo-fuggvenyekkel) -- azt kezzel kell futtatni:
//   python3 scripts/whatsapp-send-selftest.py
// Merve 2026-08-16: a javitas elotti kodon az 1. eset megbukik, a javitottal
// mind a harom zold.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = readFileSync(join(root, 'scripts', 'whatsapp-send.py'), 'utf8')
const code = src.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')

describe('whatsapp-send.py: a piszkozat nem kezbesites', () => {
  it('a fallback eredmenyet NEM adja vissza a futas eredmenyekent', () => {
    expect(code).not.toMatch(/return\s+send_email_fallback\(/)
  })

  it('a piszkozat kulon, felreerthetetlen jelzest kap', () => {
    expect(code).toContain('NOT DELIVERED')
  })

  it('a sikeres WhatsApp-kuldes tovabbra is siker', () => {
    // Kontroll: ha ez eltunne, a javitas tulloni a celon -- minden futas
    // hibat jelentene, es a csendes heartbeat ertelmet vesztene.
    expect(code).toMatch(/print\("✓ WhatsApp OK"\)\s*\n\s*return True/)
  })

  // Ez a blokk eredetileg azt orizte, hogy a fallback CSAK piszkozatot keszit
  // ("helper, draft"). Boss 2026-08-16-an kimondta az ellenkezojet:
  //   "nem kuldod el hanem piszkozatba teszed? mert ha errol akkor nem, azt
  //    azonnal el kell kuldeni a cimzettnek."
  // Ez pontosan az a kifejezett utasitas, amire a gmail-send.py level2 szabalya
  // vart, tehat a kuldes mostantol helyes. A regi allitas nem hibat talalt,
  // hanem egy visszavont dontest kert szamon -- de az alatta levo VALODI
  // kockazatot (kimeno level harmadik felnek, illetve piszkozat sikernek
  // alcazva) tovabbra is orizni kell, csak a mai szabaly szerint.
  describe('a fallback level: kuld, de csak a beallitott cimre', () => {
    it('eloszor kuld, es a piszkozat csak vegso menedek', () => {
      const first = code.indexOf('_gmail("send")')
      const last = code.indexOf('_gmail("draft")')
      expect(first, 'nincs kuldesi ag').toBeGreaterThan(-1)
      expect(last, 'nincs piszkozat-ag').toBeGreaterThan(-1)
      expect(first).toBeLessThan(last)
    })

    it('a piszkozat-ag NEM ad vissza sikert', () => {
      // A csendes heartbeat ezen a visszateresi erteken dol el: ha a piszkozat
      // True lenne, Boss megint nem tudna meg, hogy a cimzett semmit nem kapott.
      const draftAt = code.indexOf('_gmail("draft")')
      // Csak a fallback fuggveny farkat nezzuk: a fajl vegen a main() sikeres
      // aga jogosan ad vissza True-t (ott a level ELMENT), az nem tartozik ide.
      const tail = code.slice(draftAt, code.indexOf('def main(', draftAt))
      expect(tail).not.toMatch(/return True/)
      expect(tail).toMatch(/return False/)
    })

    it('a cimzett a beallitasbol jon, sosem a kodbol', () => {
      // Harmadik felnek csak az mehet ki, amit a gazda WHATSAPP_FALLBACK_EMAIL-
      // ben megadott; cim nelkul a fallback meg sem probalkozik.
      expect(code).toMatch(/recipient = recipient or fallback_email\(\)/)
      expect(code).toMatch(/if not recipient:[\s\S]{0,200}return False/)
      expect(code).toContain('WHATSAPP_FALLBACK_EMAIL')
      expect(code, 'beegetett e-mail cim a scriptben').not.toMatch(/["'][\w.+-]+@[\w-]+\.[\w.]+["']/)
    })
  })
})
