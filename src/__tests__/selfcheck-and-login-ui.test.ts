// Ket olyan hiba, amit egy szokasos unit-teszt nem lat, mert egyik sem a
// logikaban volt, hanem abban, hogy MIT MOND a felulet.
//
// Boss, 2026-08-21, ket dashboard-ablakkal egymas mellett: "a jobb oldali
// dasboardon mar a marveen be van jelentkezve a bal oldalin meg mindig azt irja
// hogy nehany masodperc amig elindul. [...] mennyi legyen az a pillanat? 5 ora
// hossza?" -- es: "az onellenorzes zold gombjai maximum ketto sorban lehetnek!
// nem 3! [...] osszesen max 4 ilyen zold kis dobozka lehet."
//
// A frontend nem importalhato (bongeszo-globalok), ezert a forras a bizonyitek.
// Egy szoveg-alapu teszt tordekenyebb a szokasosnal, de ez a ketto pontosan
// olyan visszaeses, amit semmi mas nem fog meg: mindketto lefordul, lefut, es
// csak a kepernyon rossz.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const runner = readFileSync(join(ROOT, 'src/web/claude-auth-runner.ts'), 'utf-8')
const authTypes = readFileSync(join(ROOT, 'src/claude-auth.ts'), 'utf-8')
const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
const css = readFileSync(join(ROOT, 'web/style.css'), 'utf-8')

describe('a bejelentkezes-allapot nem hazudik "indulast", ha semmi nem fut', () => {
  it('van kulon "idle" fazis', () => {
    expect(authTypes).toMatch(/\|\s*'idle'/)
  })

  it('a nem-futo allapot alapertelmezese "idle", nem "starting"', () => {
    // Ez volt maga a hiba: minden kesobbi lekerdezes "starting"-ot kapott, es a
    // varazslo hiven kiirta, hogy "indul a bejelentkeztetes, egy pillanat...".
    const m = runner.match(/function idle\([^)]*phase: LoginPaneState\['phase'\] = '([a-z-]+)'/)
    expect(m?.[1]).toBe('idle')
  })

  it('minden lekerdezes megmondja, be van-e jelentkezve a gep (nem csak az egyszeri "done")', () => {
    // A `done` elet: aki eppen kerdez, az kapja meg. Ket nyitott ablaknal nem
    // feltetlenul az, amelyiket a felhasznalo nezi.
    expect(runner).toContain('defaultLoggedIn')
    expect(runner).toMatch(/function isDefaultLoggedIn\(/)
  })

  it('a varazslo megnezi, fut-e egyaltalan folyamat, mielott fazist ir ki', () => {
    const tick = app.slice(app.indexOf('async function _wizClaudeTick('))
    const body = tick.slice(0, tick.indexOf('\n}\n') + 3)
    expect(body).toContain('if (s.active) {')
    // ... es ha nem fut, a VALOS allapotot mondja el, nem az utolso fazist.
    expect(body).toContain('wizclaude.current_none')
    expect(body).toContain('wizclaude.current_ok')
    // A vegtelen "egy pillanat" felso hatara.
    expect(body).toContain('wizclaude.state_slow')
  })

  it('egyetlen idozito fut, nem halmozodnak', () => {
    expect(app).toMatch(/function _wizClaudeStartPoll\(\)\s*\{\s*_wizClaudeStopPoll\(\)/)
  })
})

describe('az Onellenorzes kartya soha nem lesz ket sornal magasabb', () => {
  it('ket oszlopos racs, nem sorbarendezo flex', () => {
    const block = css.slice(css.indexOf('.overview-capabilities-list {'))
    const decl = block.slice(0, block.indexOf('}'))
    expect(decl).toContain('display: grid')
    expect(decl).toContain('repeat(2, minmax(0, 1fr))')
  })

  it('legfeljebb negy doboz, a negyedik az "Egyeb"', () => {
    expect(app).toMatch(/const MAX_ITEMS = 4/)
    expect(app).toContain('conn.ov_more')
    // A maradek nem esik ki: osszecsukva, de ott van.
    expect(app).toContain('overviewConnectionsMore')
    expect(app).toMatch(/function toggleSelfCheckMore\(/)
  })

  it('az "Egyeb" tartalma a racson KIVUL nyilik, kulonben megint harom sor lenne', () => {
    const block = css.slice(css.indexOf('.overview-capability-more {'))
    expect(block.slice(0, block.indexOf('}'))).toContain('grid-column: 1 / -1')
  })

  it('mindket nyelv ismeri az uj szovegeket', () => {
    for (const lang of ['hu', 'en']) {
      const f = readFileSync(join(ROOT, `web/lang/${lang}.js`), 'utf-8')
      for (const key of ['conn.ov_more', 'conn.ov_more_action', 'wizclaude.state_slow',
        'wizclaude.state_offline', 'wizclaude.state_no_answer', 'wizclaude.current_ok_anon']) {
        expect(f, `${lang}: hianyzik a(z) ${key}`).toContain(`'${key}'`)
      }
    }
  })
})
