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
  })

  it('BARMENNYI sorbol legfeljebb negy doboz lesz', () => {
    // Ez az igazi or, es szandekosan nem a kodot nezi, hanem FUTTATJA a
    // szamolot. Boss, 2026-08-22: "csinlad meg hogy legkozelebb mas agent se
    // tudjon 2 nel tobb sorba tenni semmit!" -- egy szoveg-egyezes ellen
    // konnyu veletlenul athajtani, egy szamolas ellen nem.
    const forras = app.slice(app.indexOf('function selfCheckBoxes('))
    const fn = forras.slice(0, forras.indexOf('\n}\n') + 3)
    const selfCheckBoxes = new Function(fn + ' return selfCheckBoxes')() as
      (rows: unknown[], max: number) => { shown: unknown[]; extra: unknown[] }

    for (let n = 0; n <= 30; n++) {
      const { shown, extra } = selfCheckBoxes(new Array(n).fill({}), 4)
      const dobozok = shown.length + (extra.length ? 1 : 0)
      expect(dobozok, n + ' sorbol ' + dobozok + ' doboz lett').toBeLessThanOrEqual(4)
      // ...es kozben semmi nem esik ki nyomtalanul.
      expect(shown.length + extra.length, 'elveszett egy sor').toBe(n)
    }
  })

  it('az "Egyeb" NEM nyilik le: a maradek a doboz sajat leirasaba kerul', () => {
    // 2026-08-22: eloszor lenyilo volt, es pont az tortent, ami ellen a
    // szabaly szol -- a zold csikok lementek a lap aljara. A maradek azota
    // egyetlen doboz leirasaban, felsorolva all.
    expect(app).not.toContain('overviewConnectionsMore')
    expect(app).not.toMatch(/function toggleSelfCheckMore\(/)
    expect(css).not.toContain('.overview-capability-more')
    expect(app).toContain('desc: extra.map(rovid)')
    // A racsba SEMMI mas nem kerul a dobozokon kivul.
    expect(app).toMatch(/list\.innerHTML = shown\.map\(r => itemHtml\(r, tone\)\)\.join\(''\) \+ moreBox/)
  })

  it('a zold sorok szamatol sem no meg', () => {
    // Minden uj `_ok` sor egy uj zold doboz akarna lenni. A kartya ettol nem
    // lehet magasabb: a negyedik doboz nyeli el oket.
    const zold = [...app.matchAll(/greenRows\.push\(/g)]
    expect(zold.length).toBeGreaterThan(2)
    expect(app).toContain('selfCheckBoxes(rows, MAX_ITEMS)')
  })

  it('mindket nyelv ismeri az uj szovegeket', () => {
    for (const lang of ['hu', 'en']) {
      const f = readFileSync(join(ROOT, `web/lang/${lang}.js`), 'utf-8')
      for (const key of ['conn.ov_more', 'wizclaude.state_slow',
        'wizclaude.state_offline', 'wizclaude.state_no_answer', 'wizclaude.current_ok_anon']) {
        expect(f, `${lang}: hianyzik a(z) ${key}`).toContain(`'${key}'`)
      }
    }
  })
})
