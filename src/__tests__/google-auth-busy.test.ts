// "Mar fut egy Google-bejelentkeztetes (X). Fejezd be, vagy szakitsd meg."
//
// Boss, 2026-08-15: "Mar fut egy Google-bejelentkeztetes (freeberischeaper).
// Fejezd be, vagy szakitsd meg. ha ilyen van mit tegyek?"
//
// A mondat IGAZ volt es HASZNALHATATLAN: az oldalon, ahol megjelent, semmivel
// nem lehetett befejezni vagy megszakitani azt a masik folyamatot -- a nevet
// meg csak magyar mondatba agyazva kapta meg a felulet. Ket dolgot javitunk:
//   1. a "foglalt" allapot GEPI kodkent utazik (`code: 'busy'` + a fiok neve),
//      nem magyar szovegkent, amit a bongeszonek kellene visszafejtenie;
//   2. van egy nevesitett kiut: force = szakitsd meg azt, es inditsd ezt.
//
// A `force` SOSEM lehet alapertelmezes: a script fix loopback-portot foglal es
// egyetlen fajlban tartja a folyamatban levo `state`-et, tehat ket egyidejü
// folyamat egymast rontja el. Ezert csak a felhasznalo kifejezett igenjere.
//
// Valodi viselkedes-teszt: a modul VALODI startGoogleAuth-jat hivjuk, csak a
// folyamat-inditas es a kliens-fajl letezese van kicserelve. Semmi nem beszel
// a Google-lel, es egyetlen igazi folyamat sem indul.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Egy fuggveny torzse, zarojel-parositassal (a hazi minta). */
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  let depth = 0
  for (let j = src.indexOf('{', start.index); j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start.index, j + 1) }
  }
  throw new Error(`nem zarodik: ${name}`)
}

/** Minden elinditott al-folyamat, hogy lassuk, kit lottek ki es mivel. */
const spawned: { args: string[]; killed: string[]; child: EventEmitter }[] = []

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  return {
    ...actual,
    // A fiok-lista lekerdezese: ures valasz, nincs bekotott fiok. Eleg: itt a
    // folyamat-inditas szabalyait merjuk, nem a listat.
    execFileSync: () => '',
    execFile: (_f: string, _a: string[], cb?: (e: Error | null, o: string, s: string) => void) => {
      cb?.(null, '', '')
      return new EventEmitter()
    },
    spawn: (_file: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; kill: (s: string) => void
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      const rec = { args, killed: [] as string[], child }
      child.kill = (sig: string) => { rec.killed.push(sig) }
      spawned.push(rec)
      return child
    },
  }
})

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    // Ugy teszunk, mintha az OAuth kliens-fajl a helyen lenne -- e nelkul a
    // fuggveny mar az elso sorban visszafordulna, es sosem jutnank a lenyeghez.
    existsSync: (p: unknown) =>
      String(p).endsWith('google-oauth-client.json') ? true : actual.existsSync(p as string),
  }
})

const { startGoogleAuth, googleAuthStatus, cancelGoogleAuth } = await import('../web/google-auth-runner.js')

/** Tiszta lap: a modul-szintu folyamat elengedese ket futas kozott. */
function reset(): void {
  cancelGoogleAuth()
  googleAuthStatus()
  spawned.length = 0
}

beforeEach(reset)

describe('egyszerre csak egy bejelentkeztetes futhat', () => {
  it('az elso elindul', () => {
    expect(startGoogleAuth('elso')).toEqual({ ok: true })
    expect(spawned.length).toBe(1)
    expect(spawned[0].args).toContain('auth')
    expect(spawned[0].args).toContain('elso')
  })

  it('a masodikat visszautasitja -- GEPI koddal es a fiok NEVEVEL', () => {
    startGoogleAuth('freeberischeaper')
    const r = startGoogleAuth('lackor2')
    expect(r.ok).toBe(false)
    expect(r.code, 'a felulet ne magyar mondatot fejtsen vissza').toBe('busy')
    expect(r.busyAccountId, 'a MASIK fiok neve, hogy megnevezhessuk').toBe('freeberischeaper')
    expect(r.error, 'ember-olvashato mondat is legyen').toContain('freeberischeaper')
    expect(spawned.length, 'nem indulhatott masodik folyamat').toBe(1)
  })

  it('a visszautasitott inditas NEM lovi ki a futot', () => {
    startGoogleAuth('freeberischeaper')
    startGoogleAuth('lackor2')
    expect(spawned[0].killed, 'a jogosan futo folyamat maradjon eletben').toEqual([])
    expect(googleAuthStatus().accountId).toBe('freeberischeaper')
  })
})

describe('a nevesitett kiut: force', () => {
  it('force-szal elindul, es a regit megszakitja', () => {
    startGoogleAuth('freeberischeaper')
    const r = startGoogleAuth('lackor2', { force: true })
    expect(r).toEqual({ ok: true })
    expect(spawned[0].killed, 'a regit le kell allitani, kulonben a portot fogja').toEqual(['SIGTERM'])
    expect(spawned.length).toBe(2)
    expect(spawned[1].args).toContain('lackor2')
    expect(googleAuthStatus().accountId).toBe('lackor2')
  })

  it('force NELKUL sosem lop portot -- ez a lenyeg, nem stilus', () => {
    startGoogleAuth('elso')
    startGoogleAuth('masodik', {})
    startGoogleAuth('harmadik')
    expect(spawned.length).toBe(1)
  })

  it('a force csak SZIGORUAN igaz erteknel hat', () => {
    // A rutin, ahogy ez elromlik: a felulet valami igaz-szeru erteket kuld
    // (egy Event, egy "false" sztring), es minden elso kattintas kiloni valaki
    // mas folyamatat. A route `b.force === true`-t nez -- ezt itt kotjuk le.
    const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf-8')
    // A minta a SZIGORU osszehasonlitast koti le, nem a hivas teljes alakjat:
    // az opciok bovulhetnek (pl. `hint`), a `b.force === true` viszont nem
    // lazulhat `b.force`-ra vagy `!!b.force`-ra.
    expect(route).toMatch(/startGoogleAuth\(id, \{ force: b\.force === true[,}]/)
  })

  it('a valasz gepi mezoi eljutnak a bongeszoig', () => {
    const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf-8')
    expect(route).toMatch(/code: result\.code \?\? null/)
    expect(route).toMatch(/busyAccountId: result\.busyAccountId \?\? null/)
  })
})

describe('a felulet a foglaltsagot kerdessel oldja fel, nem zsakutcaval', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
  const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
  const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')

  it('MINDKET inditasi pont kezeli a foglaltsagot', () => {
    // Fotok-oldal es Kapcsolatok-oldal. Ket helyen jelenhet meg, es egyik sem
    // maradhat zsakutca.
    const hits = [...app.matchAll(/data\.code === 'busy' && !forced/g)]
    expect(hits.length, 'mindket inditasi pontban').toBe(2)
  })

  it('a kerdes MEGNEVEZI a masik fiokot', () => {
    expect(app).toMatch(/t\('photos\.consent_busy', \{ who, me: account \}\)/)
    expect(app).toMatch(/t\('photos\.consent_busy', \{ who, me: name \}\)/)
    expect(hu).toMatch(/'photos\.consent_busy':/)
    expect(hu, 'a szoveg hasznalja is a ket nevet').toMatch(/photos\.consent_busy[^\n]*\{who\}[^\n]*\{me\}/)
    expect(en).toMatch(/'photos\.consent_busy':[^\n]*\{who\}/)
  })

  it('igen eseten UJRA inditja, force-szal', () => {
    expect(app).toMatch(/_photosConsentStart\(true\)/)
    expect(app).toMatch(/_gconnStartAuth\(name, true\)/)
  })

  it('a click-Event nem valhat force-sza', () => {
    // Ket vedelem: a gomb nyilas fuggvenyt kap, es a fuggveny szigoruan
    // hasonlit. Barmelyik egyedul is eleg lenne -- egyutt olcso.
    expect(app).toMatch(/photosConsentBtn'\)\?\.addEventListener\('click', \(\) => _photosConsentStart\(\)\)/)
    expect(app).not.toMatch(/addEventListener\('click', _photosConsentStart\)/)
  })

  it('MINDKET fuggveny szigoruan hasonlit -- fuggvenyenkent merve', () => {
    // Szabotazs-proba tanulsaga: a fajl-szintu keres atengedte, ha az EGYIK
    // fuggvenyben `!!force`-ra lazult, mert a masikban meg megvolt a szigoru
    // alak. Ezert most kulon-kulon nezzuk mind a kettot.
    for (const fn of ['_photosConsentStart', '_gconnStartAuth']) {
      expect(extractFn(app, fn), fn).toMatch(/const forced = force === true/)
      expect(extractFn(app, fn), `${fn}: laza igazsag-vizsgalat`).not.toMatch(/const forced = !!force/)
    }
  })

  it('a kerdes elott becsukja a sajat folyamat-dobozat', () => {
    // Kulonben ott maradna egy link nelkuli doboz, aminek a "Megse" gombja a
    // MASIK, jogosan futo folyamatot loné ki.
    const start = app.indexOf("if (data.code === 'busy' && !forced)")
    const ask = app.indexOf("t('photos.consent_busy'", start)
    expect(app.slice(start, ask)).toMatch(/_photosConsentReset\(\)/)
  })
})
