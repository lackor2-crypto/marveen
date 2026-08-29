// A BEERKEZO-LANC (specifikacio 22-23.) meresei.
//
// A harom biztonsagi szabaly mindegyikere kulon teszt jut, plusz a NULLA KET
// DOLGOT JELENTHET negy allapotara. A `credentialRisk()` a lemeztol fuggetlen,
// ezert az kulon, gyorsan merheto; a tobbihez valodi mappa kell.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRisk } from '../life-inbox.js'

describe('Beérkező – hitelesítő adatok kiszűrése (23. pont, 3. szabály)', () => {
  it('megfogja a jelszó/kulcs/token nevű fájlokat, magyarul és angolul is', () => {
    for (const n of [
      'jelszavak.txt', 'passwords.csv', 'id_rsa', 'szerver.pem', 'vault.kdbx',
      'API_KEY.txt', 'my-token.json', '.env', 'PrivateKey.pfx', 'ssh-kulcs.txt',
    ]) {
      expect(credentialRisk(n), n).not.toBe('')
    }
    expect(credentialRisk('jelszavak.txt', 'en')).toContain('Marvin Vault')
    expect(credentialRisk('jelszavak.txt', 'hu')).toContain('Vault')
  })

  it('a hétköznapi iratokat átengedi', () => {
    for (const n of [
      'szamla-2026-01.pdf', 'birosagi-vegzes.docx', 'IMG_2031.jpg',
      'berleti-szerzodes.pdf', 'onkormanyzat-levele.pdf',
    ]) {
      expect(credentialRisk(n), n).toBe('')
    }
  })

  it('a kiterjesztés önmagában is elég ok a megállásra', () => {
    // A fajlnev artatlan, a kiterjesztes nem: egy `.pem` akkor is kulcs, ha
    // "nyaralas"-nak hivjak.
    expect(credentialRisk('nyaralas.pem')).not.toBe('')
  })
})

// A lemezre tamaszkodo resz. A depot gyokeret a `MARVEEN_DEPOT` adja, es az
// import ELOTT kell beallitani -- a `depot.ts` modul-szinten olvassa.
describe('Beérkező – a lánc és a négy üres-állapot', () => {
  let dir = ''
  let inbox = ''
  let mod: typeof import('../life-inbox.js')
  const eredeti = process.env.MARVEEN_DEPOT

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'inbox-'))
    process.env.MARVEEN_DEPOT = dir
    mod = await import('../life-inbox.js')
    inbox = join(dir, 'Beérkező')
  })

  afterAll(() => {
    if (eredeti === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = eredeti
    rmSync(dir, { recursive: true, force: true })
  })

  it('hiányzó BEÉRKEZŐ mappánál NEM nullát mond, hanem hogy még nem készült el', () => {
    const st = mod.inboxStatus('hu')
    expect(st.reason).toBe('no-folder')
    expect(st.message).toContain('nem készült el')
  })

  it('üres BEÉRKEZŐ-t üresnek mond — ez a helyes csend', () => {
    mkdirSync(inbox, { recursive: true })
    const st = mod.inboxStatus('hu')
    expect(st.reason).toBe('ok')
    expect(st.count).toBe(0)
    expect(st.message).toContain('üres')
  })

  it('felsorolja a tételeket, és a jelszófájlt megjelöli', () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'x')
    writeFileSync(join(inbox, 'jelszavak.txt'), 'x')
    const st = mod.inboxStatus('hu')
    expect(st.count).toBe(2)
    const szamla = st.items.find((i) => i.name === 'szamla.pdf')!
    const jelszo = st.items.find((i) => i.name === 'jelszavak.txt')!
    expect(szamla.credentialWarning).toBe('')
    expect(jelszo.credentialWarning).not.toBe('')
  })

  it('az előnézet megállítja a jelszófájlt — a lemezhez nem nyúl', () => {
    mkdirSync(join(dir, 'Példa Panna', 'Pénzügy'), { recursive: true })
    const p = mod.inboxPreview(['jelszavak.txt'], 'Példa Panna/Pénzügy', 'hu')
    expect(p.plans[0].status).toBe('credential')
    expect(existsSync(join(inbox, 'jelszavak.txt'))).toBe(true)
  })

  it('cél nélkül NEM sorol be — a gazdát nem találja ki (23. pont, 1. szabály)', () => {
    const p = mod.inboxPreview(['szamla.pdf'], '', 'hu')
    expect(p.plans[0].status).toBe('no_target')
  })

  it('azonos névnél MEGÁLL, nem ír felül (23. pont, 2. szabály)', () => {
    writeFileSync(join(dir, 'Példa Panna', 'Pénzügy', 'szamla.pdf'), 'régi')
    const p = mod.inboxPreview(['szamla.pdf'], 'Példa Panna/Pénzügy', 'hu')
    expect(p.plans[0].status).toBe('exists')
    const r = mod.inboxFile(['szamla.pdf'], 'Példa Panna/Pénzügy', 'hu')
    expect(r.moved).toEqual([])
    expect(r.failed[0].message).toContain('Nem írom felül')
    // A regi fajl ERINTETLEN maradt.
    expect(existsSync(join(inbox, 'szamla.pdf'))).toBe(true)
  })

  it('a lánc lépései magából a fából jönnek, és a BEÉRKEZŐ nem választható célnak', () => {
    const step = mod.inboxChainStep('', 'hu')
    expect(step.question).toContain('Kihez tartozik')
    const nevek = step.choices.map((c) => c.name)
    expect(nevek).toContain('Példa Panna')
    expect(nevek).not.toContain('Beérkező')
  })

  it('a lánc végén kimondja, hogy ide már le lehet tenni', () => {
    mkdirSync(join(dir, 'Példa Panna', 'Pénzügy', 'Számlák'), { recursive: true })
    const step = mod.inboxChainStep('Példa Panna/Pénzügy/Számlák', 'hu')
    expect(step.leaf).toBe(true)
    expect(step.message).toContain('le lehet tenni')
  })

  it('a tiszta esetet TÉNYLEG áthelyezi', () => {
    const cel = 'Példa Panna/Pénzügy/Számlák'
    const r = mod.inboxFile(['szamla.pdf'], cel, 'hu')
    expect(r.failed).toEqual([])
    expect(r.moved.length).toBe(1)
    expect(existsSync(join(dir, 'Példa Panna', 'Pénzügy', 'Számlák', 'szamla.pdf'))).toBe(true)
    expect(existsSync(join(inbox, 'szamla.pdf'))).toBe(false)
  })
})
