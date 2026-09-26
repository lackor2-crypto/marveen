// AI Munkapad (kanban #336, 8. fazis): KEPESSEGEK ES FUGGOSEGEK.
//
// Amit ez a fajl oriz -- mind a negy a CLAUDE.md-bol, nem izlesbol:
//   1. A NULLA KET DOLGOT JELENTHET: `not_installed` (nincs) es `check_failed`
//      (nem lattam oda) KULON allapot, kulon mondattal.
//   2. SOSE TALALGATUNK OKOT: a `detail` a valodi hibauzenet.
//   3. AZ EXTRA HIANYA NEM VESZJELZES: a `tier` megvan minden soron.
//   4. FRISS TELEPITESEN IS VEGIGMEGY: amihez ut kell, ahhoz FELULETROL irhato
//      beallitas tartozik, es a TITOK sosem kerul a bongeszobe.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CAPABILITIES, getCapability, writableSettingKeys, describeCapability,
  describeAllCapabilities, resetCapabilityProbes, probeFfmpeg, ffmpegCandidates, ffmpegConfigured,
} from '../workbench-capabilities.js'
import { getSettingDefinition } from '../config-registry.js'

let dir: string
const SAVED = { soffice: process.env['MARVEEN_SOFFICE'], ffmpeg: process.env['MARVEEN_FFMPEG'] }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-caps-'))
  // Alapbol NEM a gep sajat telepiteset merjuk: igy a teszt ugyanazt mondja
  // minden gepen (van LibreOffice/FFmpeg, nincs -- mindegy).
  process.env['MARVEEN_SOFFICE'] = join(dir, 'nincs-ilyen-soffice')
  process.env['MARVEEN_FFMPEG'] = join(dir, 'nincs-ilyen-ffmpeg')
  resetCapabilityProbes()
})

afterEach(() => {
  if (SAVED.soffice === undefined) delete process.env['MARVEEN_SOFFICE']; else process.env['MARVEEN_SOFFICE'] = SAVED.soffice
  if (SAVED.ffmpeg === undefined) delete process.env['MARVEEN_FFMPEG']; else process.env['MARVEEN_FFMPEG'] = SAVED.ffmpeg
  resetCapabilityProbes()
  rmSync(dir, { recursive: true, force: true })
})

/** Egy mukodo programot utanzo szkript -- igy nem a gep telepiteset merjuk. */
function fakeBin(name: string, out: string): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\necho "${out}"\n`)
  chmodSync(p, 0o755)
  return p
}

describe('a lista maga', () => {
  it('minden sornak van kulcsa, szintje es KETNYELVU szovege', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(3)
    for (const c of CAPABILITIES) {
      expect(c.key).toMatch(/^[a-z0-9_]+$/)
      expect(['core', 'recommended', 'extra']).toContain(c.tier)
      for (const field of [c.title, c.what_for, c.affects]) {
        expect(field.hu.length).toBeGreaterThan(3)
        expect(field.en.length).toBeGreaterThan(3)
      }
      expect(Array.isArray(c.how_to.hu)).toBe(true)
      expect(c.how_to.hu.length).toBe(c.how_to.en.length)
    }
  })

  it('minden megnevezett beallitas LETEZIK a registryben (nem elgepelt kulcs)', () => {
    for (const key of writableSettingKeys()) {
      expect(getSettingDefinition(key), key).toBeTruthy()
    }
  })

  it('amihez ut vagy cim kell, ahhoz van FELULETROL irhato beallitas', () => {
    // Friss telepites: terminal es .env-szerkesztes nelkul is beallithato.
    for (const key of ['office_to_pdf', 'video_render']) {
      expect(getCapability(key)!.setting_key, key).toBeTruthy()
    }
  })

  it('a bongeszos Word-szerkesztes (ONLYOFFICE) nem kepesseg, es nincs hozza beallitas', () => {
    // #404, a tulajdonos dontese (TG 6532): a letoltes -> szerkesztes ->
    // visszatoltes ut marad, a kulon kiszolgalot igenylo ut kiment.
    expect(getCapability('office_embedded_edit')).toBeUndefined()
    expect(getSettingDefinition('WORKBENCH_ONLYOFFICE_URL')).toBeFalsy()
    expect(writableSettingKeys()).not.toContain('WORKBENCH_ONLYOFFICE_URL')
  })
})

describe('a NULLA ket dolgot jelenthet', () => {
  it('hibas MEGADOTT ut = "nem tudtam megkerdezni", NEM "nincs telepitve"', async () => {
    const row = await describeCapability(getCapability('office_to_pdf')!, 'hu', true)
    expect(row.state).toBe('check_failed')
    expect(row.available).toBe(false)
    // A VALODI hibauzenet, es megnevezi, MELYIK beallitast kell javitani.
    expect(String(row.detail)).toContain('MARVEEN_SOFFICE=')
    expect(row.message).toMatch(/nem azt jelenti/i)
  })

  it('ha egyik jelolt sem letezik: "nincs telepitve" -- csendes, varhato allapot', async () => {
    delete process.env['MARVEEN_FFMPEG']
    resetCapabilityProbes()
    const p = await probeFfmpeg({ force: true, candidates: [join(dir, 'a'), join(dir, 'b')] })
    expect(p.reason).toBe('not_installed')
    expect(p.detail).toBe(null)
  })

  it('ha ott van, a VALODI verziot es utat mondja', async () => {
    const bin = fakeBin('ffmpeg', 'ffmpeg version 7.1 Copyright (c)')
    process.env['MARVEEN_FFMPEG'] = bin
    resetCapabilityProbes()
    const row = await describeCapability(getCapability('video_render')!, 'hu', true)
    expect(row.state).toBe('ok')
    expect(row.available).toBe(true)
    expect(String(row.version)).toContain('ffmpeg version 7.1')
    expect(row.path).toBe(bin)
    expect(row.message).toMatch(/elérhető/i)
  })

  it('a megadott ut ELSObbseget elvez: nem hasznalunk csendben masik peldanyt', () => {
    process.env['MARVEEN_FFMPEG'] = '/sajat/ffmpeg'
    expect(ffmpegCandidates()).toEqual(['/sajat/ffmpeg'])
    expect(ffmpegConfigured()).toEqual({ path: '/sajat/ffmpeg', source: 'MARVEEN_FFMPEG' })
  })

  it('ha kozben ATALLITOTTAK az utat, NEM a regi meresbol valaszolunk', async () => {
    // A felhasznalo a Beallitasok lapjan is atirhatja az utat, nem csak a
    // Munkapadon -- olyankor nincs `force`, megis friss valasz kell.
    process.env['MARVEEN_FFMPEG'] = join(dir, 'meg-nincs-itt')
    resetCapabilityProbes()
    const first = await probeFfmpeg()
    expect(first.reason).toBe('check_failed')
    const bin = fakeBin('ffmpeg2', 'ffmpeg version 5.0')
    process.env['MARVEEN_FFMPEG'] = bin
    const second = await probeFfmpeg()
    expect(second.reason).toBe('ok')
    expect(second.path).toBe(bin)
  })

  it('ha a meres maga dol el, az is check_failed -- a valodi hibauzenettel', async () => {
    const broken = {
      ...getCapability('video_render')!,
      async measure(): Promise<never> { throw new Error('a merese eldolt: EACCES') },
    }
    const row = await describeCapability(broken, 'hu', true)
    expect(row.state).toBe('check_failed')
    expect(String(row.detail)).toContain('EACCES')
  })
})

describe('amit a felhasznalo lat', () => {
  it('a hianyzo EXTRA-t nem alapfunkciokent soroljuk be (nem veszjelzes)', async () => {
    const rows = await describeAllCapabilities('hu', true)
    const video = rows.find((r) => r.key === 'video_render')!
    expect(video.tier).toBe('extra')
    expect(video.optional).toBe(true)
    // Es megmondja, hogy enelkul is mukodik minden mas.
    expect(video.affects).toMatch(/működik/i)
  })

  it('amihez nincs megvalositasunk, azt KIMONDJUK -- nem igerunk varazslot', async () => {
    const rows = await describeAllCapabilities('hu', true)
    for (const key of ['image_gen', 'video_gen', 'tts']) {
      const row = rows.find((r) => r.key === key)!
      expect(row.state).toBe('not_implemented')
      expect(row.setting).toBe(null)
      expect(row.testable).toBe(false)
      expect(row.message).toMatch(/nincs bekötve/i)
    }
  })

  it('a szoveg a keres nyelven jon (HU es EN is)', async () => {
    const hu = await describeCapability(getCapability('video_render')!, 'hu', true)
    const en = await describeCapability(getCapability('video_render')!, 'en', true)
    expect(hu.title).not.toBe(en.title)
    expect(en.how_to.join(' ')).toMatch(/ffmpeg/i)
    expect(en.message).toMatch(/[A-Za-z]/)
  })

  it('a lepesek KONKRETAK: parancs vagy pelda-utvonal, nem "lasd a leirast"', async () => {
    const row = await describeCapability(getCapability('office_to_pdf')!, 'hu', true)
    expect(row.how_to.join(' ')).toMatch(/apt install libreoffice/)
    expect(row.obtain_url).toMatch(/^https:\/\//)
  })

  it('#404: a Munkapad-ugynoknek nincs beallitasa, es sehol nem kinal sajat API-kulcsot', async () => {
    for (const lang of ['hu', 'en'] as const) {
      const row = await describeCapability(getCapability('ai_agent')!, lang, true)
      expect(row.setting).toBe(null)
      expect(row.how_to.join(' ')).not.toMatch(/API-kulcs|API key/i)
    }
    expect(writableSettingKeys()).not.toContain('WORKBENCH_ANTHROPIC_API_KEY')
  })

  it('a PDF-elonezet alapfunkcio, es mindig mukodik (nincs mit telepiteni)', async () => {
    const row = await describeCapability(getCapability('pdf_preview')!, 'hu', true)
    expect(row.tier).toBe('core')
    expect(row.state).toBe('ok')
    expect(row.setting).toBe(null)
  })
})

// #336 atvizsgalas: a `soffice` burkolo-szkript; idotullepeskor eddig csak a
// kozvetlen gyerek halt meg, az unoka (`soffice.bin`) arvakent tovabb futott,
// es fogta a kozos LibreOffice-profilt.
describe('runVersion idotullepes: az egesz folyamatcsoport leall', () => {
  it.skipIf(process.platform === 'win32')('az unoka-folyamat sem marad arvakent', async () => {
    const { runVersion } = await import('../capability-probe.js')
    const { execFileSync } = await import('node:child_process')
    const marker = `31.${process.pid}${Math.floor(Math.random() * 1000)}`
    const r = await runVersion('sh', ['-c', `sleep ${marker} & wait`], 300)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('timeout')
    await new Promise((res) => setTimeout(res, 200))
    let left = ''
    try { left = execFileSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' }).trim() } catch { left = '' }
    expect(left).toBe('')
  })
})

// Boss, 2026-09-26 (TG 6523): a working agent showed "A pontos hibaüzenet:
// signed-in Claude account" under "Működik", and its help sent the owner to a
// terminal ("claude login"). A detail on an ok row is not an error, and a
// fresh-install owner signs in from the wizard, not from a shell.
describe('capability card wording', () => {
  it('labels the detail as an error only when the capability is not ok', async () => {
    const { readFileSync } = await import('node:fs')
    const js = readFileSync(join(process.cwd(), 'web', 'workbench.js'), 'utf8')
    const line = js.split('\n').find(l => l.includes("t('workbench.caps.detail')"))!
    expect(line).toContain("cap.state !== 'ok'")
  })

  it('never sends the owner to a terminal to sign in', () => {
    for (const c of CAPABILITIES) expect([...c.how_to.hu, ...c.how_to.en].join(' '), c.key).not.toMatch(/claude login/)
  })
})
