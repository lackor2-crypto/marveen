// IRODAI DOKUMENTUM -> PDF (kanban #336, 7. fazis).
//
// Amit ez meg: hogy a "nincs LibreOffice" SOHA ne latsszon sikernek, es hogy a
// "nem tudtam megkerdezni" SOHA ne valjon "nincs"-cse -- a ketto mas teendo.
// A teszt SAJAT, hamis `soffice`-szal dolgozik (nem a gep telepiteset meri),
// igy ugyanugy fut egy olyan gepen is, ahol van LibreOffice, es olyanon is,
// ahol nincs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isOfficeConvertible, officeExt, OFFICE_CONVERTIBLE, sofficeCandidates,
  probeLibreOffice, resetLibreOfficeProbe, convertOfficeToPdf, cacheKeyFor, cachedPdfFor,
  renderCacheDir, gcRenderCache, RENDER_CACHE_MAX_FILES, RENDER_CACHE_MAX_AGE_MS,
  RENDER_CACHE_TMP_MAX_AGE_MS,
} from '../office-convert.js'

let dir = ''
let docx = ''
const savedEnv: Record<string, string | undefined> = {}

/** Hamis LibreOffice. A `--version` valaszol, a `--convert-to` pedig a kert
 *  kimeneti mappaba ir egy PDF-et -- pontosan ugy, ahogy az igazi. */
function fakeSoffice(body: string): string {
  const p = join(dir, `fake-soffice-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(p, `#!/bin/sh\n${body}\n`, 'utf-8')
  chmodSync(p, 0o755)
  return p
}

const WORKING = `
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"
done
printf '%%PDF-1.4 teszt' > "$out/atalakitott.pdf"
echo "convert ... -> $out/atalakitott.pdf"
exit 0
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'office-convert-'))
  docx = join(dir, 'ajanlat.docx')
  writeFileSync(docx, 'nem igazi docx, de a kiterjesztes szamit', 'utf-8')
  for (const k of ['MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) savedEnv[k] = process.env[k]
  process.env['MARVEEN_RENDER_CACHE'] = join(dir, 'cache')
  delete process.env['MARVEEN_SOFFICE']
  resetLibreOfficeProbe()
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetLibreOfficeProbe()
  rmSync(dir, { recursive: true, force: true })
})

describe('mit lehet atalakitani', () => {
  it('a docx igen, a txt es a pdf nem (azokhoz nem kell atalakitas)', () => {
    expect(isOfficeConvertible('ajanlat.docx')).toBe(true)
    expect(isOfficeConvertible('TERV.XLSX')).toBe(true)
    expect(isOfficeConvertible('jegyzet.txt')).toBe(false)
    expect(isOfficeConvertible('szamla.pdf')).toBe(false)
    expect(officeExt('a/b/c.pptx')).toBe('pptx')
    expect(officeExt('nincs-kiterjesztes')).toBe(null)
  })

  it('minden fajtanak van MAGYAR es ANGOL megnevezese (a kepernyore nem kiterjesztes kerul)', () => {
    for (const [ext, label] of Object.entries(OFFICE_CONVERTIBLE)) {
      expect(label.hu.length, ext).toBeGreaterThan(2)
      expect(label.en.length, ext).toBeGreaterThan(2)
    }
  })
})

describe('hol keressuk a LibreOffice-t', () => {
  it('ha a felhasznalo megadta az utat, CSAK ott keressuk (nem hasznalunk csendben masikat)', () => {
    process.env['MARVEEN_SOFFICE'] = '/valami/sajat/soffice'
    expect(sofficeCandidates()).toEqual(['/valami/sajat/soffice'])
  })

  it('beallitas nelkul a PATH es a szokasos helyek jonnek, beegetett gep-specifikus ut nelkul', () => {
    const list = sofficeCandidates()
    expect(list[0]).toBe('soffice')
    expect(list.some((c) => c.includes('/home/'))).toBe(false)
  })
})

describe('a meres KULON mondja a "nincs telepitve"-t es a "nem tudtam megnezni"-t', () => {
  it('ha egyik jelolt sincs meg: not_installed, es ez NEM hiba', async () => {
    const p = await probeLibreOffice({ force: true, candidates: [join(dir, 'nincs-ilyen-1'), join(dir, 'nincs-ilyen-2')] })
    expect(p.available).toBe(false)
    expect(p.reason).toBe('not_installed')
    expect(p.detail).toBe(null)
    expect(p.checked_at).toBeGreaterThan(0)
  })

  it('ha van fajl, de nem tudtam futtatni: check_failed, a VALODI hibauzenettel -- nem "nincs"', async () => {
    const nemFuttathato = join(dir, 'soffice-nem-futtathato')
    writeFileSync(nemFuttathato, 'nem futtathato', 'utf-8')
    chmodSync(nemFuttathato, 0o644)
    const p = await probeLibreOffice({ force: true, candidates: [nemFuttathato] })
    expect(p.available).toBe(false)
    expect(p.reason).toBe('check_failed')
    expect(String(p.detail)).toMatch(/EACCES|permission|denied/i)
  })

  it('a megadott ut hibaja KULON mondat: megmondja, hogy a MARVEEN_SOFFICE a rossz', async () => {
    process.env['MARVEEN_SOFFICE'] = join(dir, 'nincs-itt-semmi')
    const p = await probeLibreOffice({ force: true })
    expect(p.reason).toBe('check_failed')
    expect(String(p.detail)).toContain('MARVEEN_SOFFICE=')
  })

  it('ha megvan: available, es a verziot is visszamondja', async () => {
    process.env['MARVEEN_SOFFICE'] = fakeSoffice(WORKING)
    const p = await probeLibreOffice({ force: true })
    expect(p.available).toBe(true)
    expect(p.reason).toBe('ok')
    expect(String(p.version)).toContain('LibreOffice')
  })
})

describe('atalakitas', () => {
  it('LibreOffice nelkul NEM sikert ad, hanem "nincs telepitve"-t', async () => {
    process.env['MARVEEN_SOFFICE'] = join(dir, 'nincs-ilyen')
    const r = await convertOfficeToPdf(docx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // Megadott, de rossz ut -> "nem tudtam megnezni", nem "nincs telepitve".
      expect(r.code).toBe('check_failed')
      expect(String(r.detail)).toContain('MARVEEN_SOFFICE=')
    }
    expect(cachedPdfFor(docx)).toBe(null)
  })

  it('mukodo atalakitoval PDF keletkezik, es masodszor mar a gyorsitotarbol jon', async () => {
    process.env['MARVEEN_SOFFICE'] = fakeSoffice(WORKING)
    const first = await convertOfficeToPdf(docx)
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.cached).toBe(false)
      expect(existsSync(first.pdf)).toBe(true)
    }
    const second = await convertOfficeToPdf(docx)
    expect(second.ok && second.cached).toBe(true)
    // A munka-konyvtar nem marad ott: a fan nem hagyunk szemetet.
    expect(readdirSync(renderCacheDir()).some((f) => f.startsWith('tmp-'))).toBe(false)
  })

  it('ha a dokumentum megvaltozik, a REGI PDF nem jon vissza (a kulcs a fajl allapota)', async () => {
    process.env['MARVEEN_SOFFICE'] = fakeSoffice(WORKING)
    const before = cacheKeyFor(docx)
    await convertOfficeToPdf(docx)
    expect(cachedPdfFor(docx)).not.toBe(null)
    writeFileSync(docx, 'ez mar egy masik, hosszabb tartalom', 'utf-8')
    utimesSync(docx, new Date(Date.now() + 2000), new Date(Date.now() + 2000))
    const after = cacheKeyFor(docx)
    expect(before.ok && after.ok && before.key !== after.key).toBe(true)
    expect(cachedPdfFor(docx)).toBe(null)
  })

  it('ha az atalakito lefut, de PDF nem lesz: "no_output" -- nem hazudunk sikert', async () => {
    process.env['MARVEEN_SOFFICE'] = fakeSoffice('if [ "$1" = "--version" ]; then echo "LibreOffice 7"; exit 0; fi\necho "nem sikerult semmit kimenteni"\nexit 0')
    const r = await convertOfficeToPdf(docx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('no_output')
      expect(String(r.detail)).toContain('nem sikerult')
    }
  })

  it('ha az atalakito elhasal, a VALODI hibauzenetet adjuk tovabb', async () => {
    process.env['MARVEEN_SOFFICE'] = fakeSoffice('if [ "$1" = "--version" ]; then echo "LibreOffice 7"; exit 0; fi\necho "Error: source file could not be loaded" 1>&2\nexit 3')
    const r = await convertOfficeToPdf(docx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('convert_failed')
      expect(String(r.detail)).toContain('source file could not be loaded')
    }
  })

  it('nem irodai fajtat meg sem probal atalakitani', async () => {
    const txt = join(dir, 'jegyzet.txt')
    writeFileSync(txt, 'szoveg', 'utf-8')
    const r = await convertOfficeToPdf(txt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('unsupported')
  })

  it('hianyzo forrasnal megmondja, hogy a FAJL nincs meg (nem az atalakitot hibaztatja)', async () => {
    process.env['MARVEEN_SOFFICE'] = fakeSoffice(WORKING)
    const r = await convertOfficeToPdf(join(dir, 'nincs-ilyen.docx'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing_source')
  })

  it('ugyanarra a fajlra ket egyideju keres EGY atalakitast indit', async () => {
    // A hamis atalakito szamolja, hanyszor hivtak meg.
    const counter = join(dir, 'hivasok')
    process.env['MARVEEN_SOFFICE'] = fakeSoffice(`
if [ "$1" = "--version" ]; then echo "LibreOffice 7"; exit 0; fi
echo x >> ${counter}
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"
done
printf '%%PDF-1.4' > "$out/ki.pdf"
exit 0
`)
    const [a, b] = await Promise.all([convertOfficeToPdf(docx), convertOfficeToPdf(docx)])
    expect(a.ok && b.ok).toBe(true)
    // Egy sor = egy tenyleges atalakitas. Ketto keres, EGY futas.
    expect(readFileSync(counter, 'utf-8').trim().split('\n').length).toBe(1)
  })
})

// A gyorsitotar SZARMAZTATOTT adat: ujra eloallithato, tehat nem gyujtjuk
// vegtelenig. De csak a SAJATUNKAT dobjuk el, es csak a sajat mappankban.
describe('a gyorsitotar nem no vegtelenig (takaritas)', () => {
  const cacheDir = () => renderCacheDir()

  function putPdf(name: string, ageMs: number): string {
    mkdirSync(cacheDir(), { recursive: true })
    const f = join(cacheDir(), name)
    writeFileSync(f, '%PDF-1.4', 'utf-8')
    const t = (Date.now() - ageMs) / 1000
    utimesSync(f, t, t)
    return f
  }

  it('a REGI PDF elmegy, a friss marad', () => {
    const regi = putPdf('regi.pdf', RENDER_CACHE_MAX_AGE_MS + 60_000)
    const friss = putPdf('friss.pdf', 1000)
    const r = gcRenderCache()
    expect(existsSync(regi)).toBe(false)
    expect(existsSync(friss)).toBe(true)
    expect(r.removed).toBeGreaterThanOrEqual(1)
  })

  it('a hataron tul a LEGREGEBBEN hasznaltak mennek elsokent', () => {
    for (let i = 0; i < RENDER_CACHE_MAX_FILES + 5; i++) putPdf(`f${i}.pdf`, (RENDER_CACHE_MAX_FILES + 5 - i) * 1000)
    gcRenderCache()
    const left = readdirSync(cacheDir()).filter((n) => n.endsWith('.pdf'))
    expect(left.length).toBe(RENDER_CACHE_MAX_FILES)
    // A legregebbi ot ment el, a legfrissebb maradt.
    expect(left).toContain(`f${RENDER_CACHE_MAX_FILES + 4}.pdf`)
    expect(left).not.toContain('f0.pdf')
  })

  it('a felbeszakadt atalakitas maradeka elmegy, a FRISS ideiglenes mappa marad', () => {
    mkdirSync(join(cacheDir(), 'tmp-regi'), { recursive: true })
    mkdirSync(join(cacheDir(), 'tmp-most'), { recursive: true })
    const t = (Date.now() - RENDER_CACHE_TMP_MAX_AGE_MS - 60_000) / 1000
    utimesSync(join(cacheDir(), 'tmp-regi'), t, t)
    gcRenderCache()
    expect(existsSync(join(cacheDir(), 'tmp-regi'))).toBe(false)
    // Egy EPPEN futo atalakitas mappajahoz nem nyulunk hozza.
    expect(existsSync(join(cacheDir(), 'tmp-most'))).toBe(true)
  })

  it('amit nem mi hoztunk letre, ahhoz hozza sem nyulunk', () => {
    mkdirSync(cacheDir(), { recursive: true })
    const idegen = join(cacheDir(), 'olvassel.txt')
    writeFileSync(idegen, 'nem a mienk', 'utf-8')
    const t = (Date.now() - RENDER_CACHE_MAX_AGE_MS - 60_000) / 1000
    utimesSync(idegen, t, t)
    gcRenderCache()
    expect(existsSync(idegen)).toBe(true)
  })

  it('ha a mappa meg nem letezik, az NEM hiba (friss telepites)', () => {
    rmSync(cacheDir(), { recursive: true, force: true })
    expect(gcRenderCache()).toEqual({ removed: 0, kept: 0 })
  })
})
