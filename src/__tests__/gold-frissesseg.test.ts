// Arany idosikonkenti frissesseg-kapu (kanban 891a30f6).
//
// A bejelentett bug: scripts/gold-data.py a legFRISSEBB idosik korat nezte
// (min(ages)) es csak akkor szolt, ha AZ is >120 perces volt. Igy ha D1/H1/M15
// friss es csak az M5 all 3855 perce, a figyelmeztetes SOHA nem futott le.
//
// A repoban NINCS python teszt-futtato, ezert a python-oldali logikat a szkript
// sajat rejtett --selftest kapcsoloja ellenorzi (tiszta fuggveny, halozat es fajl
// nelkul). Ez a vitest azt biztositja, hogy:
//   1. a --selftest lefut es ZOLD (a frissesseg_kapu a harom kulcs-esetet helyesen
//      donti el: friss D1 + 3855 M5 -> 'elavult'; nulla .hst -> 'nincs_adat';
//      nincs live -> 'nem_tudom'),
//   2. a --selftest NEM nema: ha egy asszercio bukik, NEM-nullaval lep ki (a
//      "nulla ket dolgot jelenthet" ellen -- egy hibas kapu ne latszodjon sikernek).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'gold-data.py')

function py(args: string[], opts: { input?: string } = {}) {
  return spawnSync('python3', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input: opts.input,
    timeout: 30_000,
  })
}

describe('gold-data.py frissesseg-kapu', () => {
  it('a rejtett --selftest zold (a harom kulcs-eset helyes)', () => {
    const r = py([SCRIPT, '--selftest'])
    expect(r.error).toBeUndefined()
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('selftest OK')
  })

  it('a --selftest NEM nema: bukott asszercio -> nem-nulla kilepokod', () => {
    // Ugyanazt a mintat futtatjuk, mint a szkript selftestje, de SZANDEKOSAN
    // hamis elvarassal. Ha a kapu-mechanizmus jo, ez nem-nullaval lep ki -- vagyis
    // egy elrontott kapu nem tudna csendben "sikert" mutatni.
    const snippet = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("gold", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
most = 1_000_000_000
d1 = {"tf":"D1","utolso_gyertya_kora_perc":1380,"utolso_gyertya":"reggeli"}
m5 = {"tf":"M5","utolso_gyertya_kora_perc":3855,"utolso_gyertya":"regi"}
k = m.frissesseg_kapu([d1,m5], True, {"generated":most-120}, most)
# HAMIS elvaras: azt allitjuk, hogy az M5 'ok' -- pedig a helyes 'elavult'
assert k["idosikok"]["M5"]["allapot"] == "ok", "szandekos bukas"
`
    const r = py(['-c', snippet])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('AssertionError')
  })

  it('a tiszta fuggveny kozvetlenul is a vart verdikteket adja', () => {
    // Fuggetlen ujra-ellenorzes a szkripten kivulrol, hogy a kapu tenyleg tiszta
    // (minden bemenet parameter) es importalhato.
    const snippet = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("gold", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
most = 1_000_000_000
d1 = {"tf":"D1","utolso_gyertya_kora_perc":1380,"utolso_gyertya":"reggeli"}
m5 = {"tf":"M5","utolso_gyertya_kora_perc":3855,"utolso_gyertya":"regi"}
res = {
  "piac_nyitva": m.frissesseg_kapu([d1,m5], True, {"generated":most-120}, most),
  "nincs_live":  m.frissesseg_kapu([d1,m5], True, None, most),
  "hianyzo_hst": m.frissesseg_kapu([{"tf":"M5","error":"nincs history fajl: x"}], True, {"generated":most-120}, most),
}
print(json.dumps({
  "elavult_M5": res["piac_nyitva"]["idosikok"]["M5"]["allapot"],
  "elavult_D1": res["piac_nyitva"]["idosikok"]["D1"]["allapot"],
  "elavult_verdikt": res["piac_nyitva"]["verdikt"],
  "legelavultabb": res["piac_nyitva"]["legelavultabb_adat_kora_perc"],
  "nemtudom_M5": res["nincs_live"]["idosikok"]["M5"]["allapot"],
  "nincsadat_M5": res["hianyzo_hst"]["idosikok"]["M5"]["allapot"],
}))
`
    const r = py(['-c', snippet])
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const o = JSON.parse(r.stdout.trim())
    expect(o.elavult_M5).toBe('elavult')      // piac nyitva + 3855 perc -> elavult
    expect(o.elavult_D1).toBe('ok')           // friss D1 ejjel NEM riaszt
    expect(o.elavult_verdikt).toBe('elavult') // az osszesitest a legelavultabb hozza
    expect(o.legelavultabb).toBe(3855)        // nem a min(), a max()
    expect(o.nemtudom_M5).toBe('nem_tudom')   // nincs live -> nem 'ok'
    expect(o.nincsadat_M5).toBe('nincs_adat') // hianyzo .hst -> nem 'elavult'
  })
})
