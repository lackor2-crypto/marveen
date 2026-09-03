import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A kod-hid (VS Code) hibavalaszai eddig NYERS ANGOL gepi kodot mutattak a
// felulet en (pl. "invalid skill name", "unknown project"), amit a komuves
// nem ert (Boss, 2026-08-23: "a user egy komuves", + ketnyelvusegi szabaly).
// Ez a teszt kikenyszeriti, hogy minden felhasznalonak szant kod-hid hiba egy
// i18n-KULCSOT (`errorKey`) is kuldjon, ES hogy az a kulcs MINDKET nyelvben
// (hu + en) letezzen -- kulonben a felulet ures/hibas mondatot mutatna.

const ROOT = join(__dirname, '..', '..')
const routes = readFileSync(join(ROOT, 'src', 'web', 'routes', 'code.ts'), 'utf-8')
const store = readFileSync(join(ROOT, 'src', 'web', 'code-bridge-store.ts'), 'utf-8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

function errorKeysIn(src: string): string[] {
  const out = new Set<string>()
  for (const m of src.matchAll(/errorKey:\s*'([^']+)'/g)) out.add(m[1]!)
  // A haromagu (?: ) valasztos errorKey-eket is (projects POST) kulon fogjuk meg.
  for (const m of src.matchAll(/'(cb\.err\.[a-z_]+)'/g)) out.add(m[1]!)
  return [...out].filter((k) => k.startsWith('cb.err.'))
}

describe('kod-hid hibavalaszok ketnyelvuek (errorKey + hu/en)', () => {
  const backendKeys = [...new Set([...errorKeysIn(routes), ...errorKeysIn(store)])]

  it('van egyaltalan errorKey a backenden (nem tunt el a bekotes)', () => {
    // Vedelmi also hatar: ha egy atirasnal mind eltunne, ezt eszrevesszuk.
    expect(backendKeys.length).toBeGreaterThanOrEqual(20)
  })

  it('minden backend cb.err.* kulcs LETEZIK hu.js-ben ES en.js-ben', () => {
    const hianyzo: string[] = []
    for (const k of backendKeys) {
      if (!hu.includes(`'${k}'`)) hianyzo.push(`hu.js: ${k}`)
      if (!en.includes(`'${k}'`)) hianyzo.push(`en.js: ${k}`)
    }
    expect(hianyzo, `hianyzo forditas:\n${hianyzo.join('\n')}`).toEqual([])
  })

  it('a felhasznalonak szant nyers hibak errorKey-t is kapnak (nem csak angol kod)', () => {
    // Nehany konkret, korabban PANASZOLT sor -- ezek angol gepi kodja most is
    // ott lehet (naplo/back-compat), de errorKey NELKUL nem maradhat.
    const mustHave = ['invalid skill name', 'invalid avatar name', 'unknown project']
    for (const needle of mustHave) {
      const idx = routes.indexOf(needle)
      expect(idx, `nincs benne: ${needle}`).toBeGreaterThan(-1)
    }
    // A ket kulcs, amit a felulet a legtobbet mutat.
    expect(routes).toContain("errorKey: 'cb.err.unknown_project'")
    expect(routes).toContain("errorKey: 'cb.err.invalid_skill_name'")
    expect(routes).toContain("errorKey: 'cb.err.invalid_avatar_name'")
  })

  it('a frontend cbErrText az errorKey-t reszesiti elonyben, es a nyers error csak tartalek', () => {
    expect(app).toContain('function cbErrText(data, res)')
    // Eloszor a kulcs (forditva), utana a nyers error, vegul a HTTP-statusz.
    const fn = app.slice(app.indexOf('function cbErrText'), app.indexOf('function cbErrText') + 320)
    expect(fn).toContain('data.errorKey')
    expect(fn).toContain("t(data.errorKey, data.errorParams || {})")
    expect(fn).toContain('data.error')
  })
})
