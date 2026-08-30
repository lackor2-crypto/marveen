/**
 * A GEPEM MENTESE A DRIVE-RA (#47) -- a dontesek orei.
 *
 * A kartya #47 sajat szavaival: "ez az egesz mappastruktura folyamatosan
 * sync-elve / feltoltve a Google Drive-ra biztonsagi mentesnek ... azok NEM
 * mennek a git repoba". MERVE 2026-08-28: a raktarban 9356 fajl / 11 GB all
 * ugy, hogy sehol nincs masodpeldanya.
 *
 * Amit itt orzunk, az mind olyan hiba, ami NEM adna hibauzenetet:
 *   * a mentes onmagat mentene (kor),
 *   * ket mentes egymasba erne (minden fajl ketszer megy fel, minden ejjel),
 *   * a listazasi plafon csendben leallitana a feltoltest,
 *   * a felig felment mentes ZOLD sort mutatna az Attekintesen.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_LOCAL_FILES,
  MAX_UPLOADS,
  merjMentendot,
  MENTES_MAPPA,
  mentesAgHiba,
  mentesKihagy,
  mentesKihagyUt,
  mentesMappaNev,
  mentesUtNorm,
  mentesUtkozes,
  pairLabel,
  walkLocalFiles,
} from '../web/routes/drive-sync.js'
import { DEPOT_SYSTEM_ROOT } from '../depot.js'

const paros = (localPath: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'x', account: 'a@b.hu', folderId: 'f', backup: true, localPath, ...extra }) as any

describe('#47 -- mit hagyunk ki a mentesbol', () => {
  it('a TELJES raktar mentesebol a Rendszer ag kimarad (kulonben a mentest mentenenk)', () => {
    expect([...mentesKihagyUt('')]).toEqual([DEPOT_SYSTEM_ROOT])
    expect([...mentesKihagy(paros(''))]).toEqual([DEPOT_SYSTEM_ROOT])
  })

  it('egy KIVALASZTOTT ag mentesebol semmi nem marad ki', () => {
    expect([...mentesKihagyUt('Korpás László/Projektek')]).toEqual([])
    expect([...mentesKihagy(paros('Korpás László'))]).toEqual([])
  })

  it('Drive-masolat parosnal (nem mentes) nincs kihagyas -- az a masik irany', () => {
    expect([...mentesKihagy({ id: 'x', account: 'a', folderId: 'f' } as any)]).toEqual([])
  })
})

describe('#47 -- korok visszautasitasa', () => {
  it('a Rendszer ag nem kothető be, es az uzenet MEGMONDJA, miert', () => {
    const hiba = mentesAgHiba(DEPOT_SYSTEM_ROOT)
    expect(hiba).toBeTruthy()
    expect(hiba).toContain(DEPOT_SYSTEM_ROOT)
    // Nem eleg nemet mondani: a kovetkezo lepest is ki kell mondani.
    expect(hiba).toContain('teljes raktár')
  })

  it('a Rendszer ALATTI mappa sem kothető be (a kor ott is kor)', () => {
    expect(mentesAgHiba(`${DEPOT_SYSTEM_ROOT}/Tárolók/Drive`)).toBeTruthy()
    expect(mentesAgHiba(`${DEPOT_SYSTEM_ROOT}\\Tárolók`)).toBeTruthy()
  })

  it('minden mas ag bekothető', () => {
    expect(mentesAgHiba('Korpás László/Projektek')).toBeNull()
    expect(mentesAgHiba('')).toBeNull()
    // A "Rendszerhaz" nem a Rendszer ag: csak a TELJES elso szint szamit.
    expect(mentesAgHiba('Rendszerhaz')).toBeNull()
  })
})

describe('#47 -- ket mentes nem erhet egymasba', () => {
  it('ugyanaz az ag', () => {
    const t = mentesUtkozes([paros('Korpás László')], 'Korpás László')
    expect(t?.fajta).toBe('ugyanaz')
  })

  it('a meglevo FOLOTTE van (a teljes raktar mar mindent visz)', () => {
    expect(mentesUtkozes([paros('')], 'Korpás László/Projektek')?.fajta).toBe('fölötte')
    expect(mentesUtkozes([paros('Korpás László')], 'Korpás László/Projektek')?.fajta).toBe('fölötte')
  })

  it('a meglevo ALATTA van (a most bekotott nyelne el)', () => {
    expect(mentesUtkozes([paros('Korpás László/Projektek')], 'Korpás László')?.fajta).toBe('alatta')
    expect(mentesUtkozes([paros('Korpás László')], '')?.fajta).toBe('alatta')
  })

  it('kulon agak nem utkoznek', () => {
    expect(mentesUtkozes([paros('Cégek')], 'Korpás László')).toBeNull()
    // Nev-elotag NEM tartalmazas: a "Korpás" nem szuloje a "Korpás László"-nak.
    expect(mentesUtkozes([paros('Korpás')], 'Korpás László')).toBeNull()
  })

  it('a Drive-masolat parosokat figyelmen kivul hagyja (masik irany, nem utkozik)', () => {
    expect(mentesUtkozes([{ id: 'x', account: 'a', folderId: 'f', name: 'X' } as any], '')).toBeNull()
  })
})

describe('#47 -- a Drive-oldali mappanev', () => {
  it('a TELJES utbol keszul, nem csak az utolso szintbol', () => {
    // Ket kulon agban lehet ugyanolyan nevu mappa; a Drive-on nem szabad ket
    // azonos nevu mentes-mappanak allnia, mert nem lehetne kozuluk valasztani.
    expect(mentesMappaNev('Korpás László/Munka')).not.toBe(mentesMappaNev('Cégek/Munka'))
    expect(mentesMappaNev('Korpás László/Munka')).toContain('Korpás László')
  })

  it('a teljes raktarnak is van neve (nem ures string)', () => {
    expect(mentesMappaNev('').length).toBeGreaterThan(0)
  })

  it('a gyujto-mappa neve rogzitett', () => {
    expect(MENTES_MAPPA).toBe('Marveen mentés')
  })
})

describe('#47 -- a sor felirata', () => {
  it('a mentes-paros a HELYI utat mutatja, es hogy merre megy', () => {
    const cimke = pairLabel({ backup: true, localPath: 'Korpás László/Projektek' })
    expect(cimke).toContain('Korpás László/Projektek')
    expect(cimke).toContain('mentés a Drive-ra')
  })

  it('a teljes raktar mentesenek is van olvashato felirata (nem ures)', () => {
    expect(pairLabel({ backup: true, localPath: '' })).toContain('raktár')
  })
})

describe('#47 -- a listazasi plafon NEM a feltoltesi keret', () => {
  it('a helyi kep akkor is teljes, ha egy futasban keves fajl megy fel', () => {
    // EZ VOLT A LAPPANGO HIBA: amikor a bejaras plafonja = a feltoltesi keret
    // (2000), a 2000-nel tobb fajlt tartalmazo mappa "tul sok helyi fajl"
    // miatt KIHAGYTA az egesz feltoltest -- vagyis a 9356 fajlos agbol soha
    // egyetlen bajt sem ment volna fel, hibauzenet nelkul.
    expect(MAX_LOCAL_FILES).toBeGreaterThan(MAX_UPLOADS)
    // A helyi kep tovabba a TORLES alapja is: csonka listabol torolni vakon
    // torles lenne.
    expect(MAX_LOCAL_FILES).toBeGreaterThanOrEqual(100_000)
  })
})

describe('#47 -- a bejaras kihagyasa', () => {
  it('a kihagyott agat se nem listazza, se nem jarja be', () => {
    const gyoker = mkdtempSync(join(tmpdir(), 'mentes-'))
    try {
      mkdirSync(join(gyoker, 'Munka'))
      writeFileSync(join(gyoker, 'Munka', 'a.txt'), 'a')
      mkdirSync(join(gyoker, DEPOT_SYSTEM_ROOT, 'Tárolók'), { recursive: true })
      writeFileSync(join(gyoker, DEPOT_SYSTEM_ROOT, 'Tárolók', 'nagy.bin'), 'x')

      const teljes = walkLocalFiles(gyoker, MAX_LOCAL_FILES, new Set())
      expect(teljes.files.length).toBe(2)

      const szurt = walkLocalFiles(gyoker, MAX_LOCAL_FILES, new Set([DEPOT_SYSTEM_ROOT]))
      expect(szurt.files).toEqual(['Munka/a.txt'])
      // Nem csak a fajl hianyzik: a mappaba BE SEM lepett.
      expect(szurt.files.some((f) => f.startsWith(DEPOT_SYSTEM_ROOT))).toBe(false)
      expect(szurt.csonkolt).toBe(false)
    } finally {
      rmSync(gyoker, { recursive: true, force: true })
    }
  })

  it('ures mappanal a nulla VALODI nulla -- a csonkolas kulon jelzes', () => {
    // A nulla ket dolgot jelenthet. Itt a forrast kerdezzuk meg: a bejaras
    // vegigment (`csonkolt: false`), tehat tenyleg nincs benne fajl.
    const gyoker = mkdtempSync(join(tmpdir(), 'mentes-ures-'))
    try {
      const e = walkLocalFiles(gyoker, MAX_LOCAL_FILES, new Set())
      expect(e.files.length).toBe(0)
      expect(e.csonkolt).toBe(false)
    } finally {
      rmSync(gyoker, { recursive: true, force: true })
    }
  })

  it('a plafon elereset CSONKOLTNAK jelzi, nem hallgatja el', () => {
    const gyoker = mkdtempSync(join(tmpdir(), 'mentes-sok-'))
    try {
      for (let i = 0; i < 5; i++) writeFileSync(join(gyoker, `f${i}.txt`), 'x')
      const e = walkLocalFiles(gyoker, 3, new Set())
      expect(e.csonkolt).toBe(true)
      expect(e.files.length).toBeLessThanOrEqual(3)
    } finally {
      rmSync(gyoker, { recursive: true, force: true })
    }
  })
})

describe('#47 -- az elonezet merese nem fagyaszthatja le a dashboardot', () => {
  const fa = () => {
    const gyoker = mkdtempSync(join(tmpdir(), 'mentes-meres-'))
    mkdirSync(join(gyoker, 'Munka', 'Mely'), { recursive: true })
    writeFileSync(join(gyoker, 'Munka', 'a.txt'), 'aaa')
    writeFileSync(join(gyoker, 'Munka', 'Mely', 'b.txt'), 'bbbbb')
    mkdirSync(join(gyoker, DEPOT_SYSTEM_ROOT), { recursive: true })
    writeFileSync(join(gyoker, DEPOT_SYSTEM_ROOT, 'nagy.bin'), 'xxxxxxxx')
    // Fel kesz letoltes: sose megy fel, tehat a meresben sincs benne.
    writeFileSync(join(gyoker, 'Munka', 'c.txt.part'), 'zzz')
    return gyoker
  }

  it('ugyanazt szamolja, mint a feltoltes sajat bejarasa', async () => {
    // Ha a ketto elvalik, a Boss mas szamot LAT, mint ami fel fog menni.
    const gyoker = fa()
    try {
      const kihagy = new Set([DEPOT_SYSTEM_ROOT])
      const jaras = walkLocalFiles(gyoker, MAX_LOCAL_FILES, kihagy)
      const meres = await merjMentendot(gyoker, MAX_LOCAL_FILES, kihagy)
      expect(meres.files).toBe(jaras.files.length)
      expect(meres.csonkolt).toBe(jaras.csonkolt)
      expect(meres.bytes).toBe(3 + 5)     // a .part es a kihagyott ag nincs benne
      expect(meres.unreadable).toBe(0)
      expect(meres.tooBig).toBe(0)
    } finally {
      rmSync(gyoker, { recursive: true, force: true })
    }
  })

  it('meres kozben MAS is szohoz jut (nem all meg tole a szerver)', async () => {
    // EZ A LENYEG. MERVE 2026-08-29: a teljes raktar bejarasa 52 masodperc; a
    // Node egy szalon fut, tehat szinkron bejarassal egy gombnyomasra egy
    // percre befagyna az egesz felulet -- hibauzenet nelkul.
    //
    // A meres sajat lelegzetvetele (`drive-sync.ts`) VALODI oran (Date.now())
    // meri, hogy eltelt-e mar 15 ms -- csak akkor ad at vezerlest. Ha a teszt
    // is a valodi orara bizna magat, gyors/ures lemezen (MERVE: 2026-08-30, a
    // GitHub Actions futtatoja) az 1200 apro fajl bejarasa a 15 ms-os szelet
    // ALATT lefuthat, es a masodperc-oragomb egyszer sem kap szot -- nem azert,
    // mert a lelegzetvetel elromlott, hanem mert a gep egyszeruen tul gyors
    // volt ahhoz, hogy a verseny lefusson. Ezert itt az orat magunk toljuk
    // elore: a lelegzetvetel mechanizmusat vizsgaljuk, nem a gep sebesseget.
    const gyoker = mkdtempSync(join(tmpdir(), 'mentes-lelegzet-'))
    const valodiNow = Date.now.bind(Date)
    let hivas = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      hivas++
      return valodiNow() + hivas * 2 // minden hivas 2 ms-ot "telik" -- 8 hivas utan mar biztos tullepi a 15 ms-os szeletet
    })
    try {
      // Eleg fajl ahhoz, hogy tobb adag legyen belole.
      for (let i = 0; i < 1200; i++) writeFileSync(join(gyoker, `f${i}.txt`), 'x')
      let masFutott = false
      const oragomb = setInterval(() => { masFutott = true }, 1)
      try {
        await merjMentendot(gyoker, MAX_LOCAL_FILES, new Set())
      } finally {
        clearInterval(oragomb)
      }
      expect(masFutott).toBe(true)
    } finally {
      nowSpy.mockRestore()
      rmSync(gyoker, { recursive: true, force: true })
    }
  })

  it('a plafont ITT is csonkoltnak jelzi, nem hallgatja el', async () => {
    const gyoker = fa()
    try {
      const m = await merjMentendot(gyoker, 1, new Set())
      expect(m.csonkolt).toBe(true)
      expect(m.files).toBeLessThanOrEqual(1)
    } finally {
      rmSync(gyoker, { recursive: true, force: true })
    }
  })

  it('ures mappanal a nulla VALODI nulla (a bejaras vegigment)', async () => {
    const gyoker = mkdtempSync(join(tmpdir(), 'mentes-ures2-'))
    try {
      const m = await merjMentendot(gyoker, MAX_LOCAL_FILES, new Set())
      expect(m.files).toBe(0)
      expect(m.bytes).toBe(0)
      expect(m.csonkolt).toBe(false)
    } finally {
      rmSync(gyoker, { recursive: true, force: true })
    }
  })
})

describe('#47 -- ut-egysegesites', () => {
  it('a Windows-perjel es a szelso perjelek nem szamitanak', () => {
    expect(mentesUtNorm('\\Korpás László\\Projektek\\')).toBe('Korpás László/Projektek')
    expect(mentesUtNorm('/')).toBe('')
    expect(mentesUtNorm(undefined as any)).toBe('')
  })
})
