import { describe, expect, it } from 'vitest'
import { sanitizeParosHiba } from '../web/routes/drive-sync.js'

/**
 * BUG (Boss 2026-09-17): a canadalackor mentés-páros lastResult mezőjében nyers
 * Python-Traceback állt (a google-auth.py stderr-je) magyar mondat helyett -- ezt
 * látta a felhasználó a felületen. A lastResult EMBERI mondat kell legyen, a nyers
 * részlet a Hibák dobozba tartozik. Ez a mérő ezt kényszeríti ki.
 */
describe('elhasalt mentés-páros: emberi mondat a felületre, nyers részlet a Hibák dobozba', () => {
  const TRACEBACK = [
    'Traceback (most recent call last):',
    '  File "/usr/lib/python3.12/urllib/request.py", line 1344, in do_open',
    '    h.request(req.get_method(), req.selector, req.data, headers,',
    'urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>',
  ].join('\n')

  it('a felhasználónak látott üzenet EMBERI mondat, nem tartalmaz nyers hibát', () => {
    const { uzenet } = sanitizeParosHiba(new Error(TRACEBACK))
    expect(uzenet).not.toContain('Traceback')
    expect(uzenet).not.toContain('urllib')
    expect(uzenet).not.toContain('File "')
    // Rövid magyar mondat, ami a Hibák dobozhoz irányít (a részletért).
    expect(uzenet).toContain('Hibák dobozban')
    expect(uzenet.length).toBeLessThanOrEqual(80)
  })

  it('a nyers részlet MEGMARAD a Hibák doboznak', () => {
    const { reszlet } = sanitizeParosHiba(new Error(TRACEBACK))
    expect(reszlet).toContain('Traceback')
    expect(reszlet).toContain('urllib.error.URLError')
  })

  it('a nyers részlet 300 karakterre van vágva (nem önti el a Hibák dobozt)', () => {
    const hosszu = 'x'.repeat(5000)
    const { reszlet } = sanitizeParosHiba(new Error(hosszu))
    expect(reszlet.length).toBe(300)
  })

  it('nem-Error értékkel (sima string, null) sem hasal el, és sosem ad nyers üzenetet', () => {
    expect(sanitizeParosHiba('nincs access_token').reszlet).toBe('nincs access_token')
    expect(sanitizeParosHiba('nincs access_token').uzenet).toContain('Hibák dobozban')
    // null/undefined: üres részlet, de a mondat akkor is emberi
    expect(sanitizeParosHiba(null).uzenet).toContain('Hibák dobozban')
    expect(sanitizeParosHiba(null).reszlet).toBe('')
    expect(sanitizeParosHiba(undefined).reszlet).toBe('')
  })
})
