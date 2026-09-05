// Kanban #167 (9588db41): nevadasi es ikon-konvenciok EGY helyen.
//
// A kartya lenyege Botond Peter mondatabol jon: "Aztan ha valami ujat csinal,
// akkor azok alapjan hozza letre." Vagyis a szabaly nem attol er valamit, hogy
// le van irva, hanem attol, hogy a LETREHOZAS elott lefut. Ezert ezek a
// tesztek nem a szoveget egyeztetik, hanem a dontest merik.
import { describe, it, expect } from 'vitest'
import {
  namingZone, slugify, checkName, checkNameForPath,
  iconForKey, iconForFolderName, keysWithoutIcon, iconTable,
  DEFAULT_FOLDER_ICON, MACHINE_ZONE_DIR,
} from '../naming-conventions.js'
import { lifeName, lifeNameKeys } from '../life-tree.js'

describe('ket zona van, es a szulo donti el', () => {
  it('az eletfa java resze ember-zona', () => {
    expect(namingZone('Beérkező')).toBe('human')
    expect(namingZone('Példa/Projektek/Tőzsde/Fejlesztés')).toBe('human')
    expect(namingZone('')).toBe('human')
  })

  it('a GIT_REPOS es minden alatta gep-zona', () => {
    expect(namingZone(`Példa/Projektek/X/Fejlesztés/${MACHINE_ZONE_DIR}`)).toBe('machine')
    expect(namingZone(`Példa/Projektek/X/Fejlesztés/${MACHINE_ZONE_DIR}/marveen`)).toBe('machine')
  })

  it('MAGA a GIT_REPOS mappa letrehozasat nem slugositjuk', () => {
    // A neve szandekosan fix nagybetus (life-tree.ts, specifikacio 16.). Ha a
    // zonat a keszulo elem sajat utjabol vennenk, a sajat kanonikus nevet
    // kifogasolnank -- ezert a SZULO utja dont.
    const a = checkNameForPath('Példa/Projektek/X/Fejlesztés', MACHINE_ZONE_DIR)
    expect(a.zone).toBe('human')
    expect(a.ok).toBe(true)
  })
})

describe('ember-zona: az ekezet es a szokoz RENDBEN van', () => {
  it('egy szokozos, ekezetes nev nem kap figyelmeztetest', () => {
    // Ez a lenyeg: az eletfa embernek szol. Ha ezt kifogasolnank, a fa
    // elvesztene az ertelmet.
    expect(checkName('Régi szerződések 2024', 'human').ok).toBe(true)
    expect(checkName('Németország', 'human').ok).toBe(true)
  })

  it('a kotojellel kezdodo nevet a parancsok kapcsolonak neznek -> tanacs', () => {
    const a = checkName('-fontos', 'human')
    expect(a.ok).toBe(false)
    expect(a.code).toBe('leading_dash')
    expect(a.suggestion).toBe('fontos')
    expect(a.message).toContain('fontos')
  })

  it('a parancssort ertelmezo jelre szolunk, es MEGMONDJUK mi legyen helyette', () => {
    const a = checkName('Számlák (2024) & egyéb', 'human')
    expect(a.ok).toBe(false)
    expect(a.code).toBe('shell_hazard')
    // A javaslat marad ember-nev: az ekezetet NEM szedjuk ki.
    expect(a.suggestion).toContain('Számlák')
    expect(a.suggestion).not.toMatch(/[()&]/)
  })
})

describe('gep-zona: slug jar, mert a nema hiba a rossz', () => {
  it('ekezetes/szokozos nev -> slug javaslat', () => {
    const a = checkName('Tőzsde Bot', 'machine')
    expect(a.ok).toBe(false)
    expect(a.code).toBe('machine_zone_not_slug')
    expect(a.suggestion).toBe('tozsde-bot')
  })

  it('a mar helyes slug atmegy', () => {
    expect(checkName('marveen-dashboard', 'machine').ok).toBe(true)
    expect(checkName('repo2', 'machine').ok).toBe(true)
  })

  it('amibol nem lesz slug, arrol megmondjuk hogy nem tudunk jobbat', () => {
    const a = checkName('....', 'machine')
    expect(a.ok).toBe(false)
    expect(a.suggestion).toBe('')
    expect(a.message.length).toBeGreaterThan(0)
  })

  it('a GIT_REPOS ALATT letrehozott mappa mar gep-zonas', () => {
    const a = checkNameForPath(`Példa/Projektek/X/Fejlesztés/${MACHINE_ZONE_DIR}`, 'Új Repó')
    expect(a.zone).toBe('machine')
    expect(a.suggestion).toBe('uj-repo')
  })
})

describe('slugify', () => {
  it('ekezetet bont, nem dob el', () => {
    expect(slugify('Árvíztűrő tükörfúrógép')).toBe('arvizturo-tukorfurogep')
  })
  it('a szeleken nem hagy kotojelet', () => {
    expect(slugify('  --Hello World--  ')).toBe('hello-world')
  })
  it('ures bemenetre ures', () => {
    expect(slugify('')).toBe('')
    expect(slugify('!!!')).toBe('')
  })
})

describe('ketnyelvuseg: a mondat a felulet nyelven all', () => {
  it('a magyar es az angol valtozat is letezik, es nem ugyanaz', () => {
    const hu = checkName('Tőzsde Bot', 'machine', 'hu')
    const en = checkName('Tőzsde Bot', 'machine', 'en')
    expect(hu.message.length).toBeGreaterThan(0)
    expect(en.message.length).toBeGreaterThan(0)
    expect(hu.message).not.toBe(en.message)
    // A javaslat viszont ugyanaz: az nem forditando.
    expect(hu.suggestion).toBe(en.suggestion)
  })
})

describe('ikon-konvencio: uj mappa nem szulethet ikon nelkul', () => {
  it('MINDEN fa-kulcshoz tartozik ikon', () => {
    // Ez a kartya 2. pontja. A tabla a fa sajat kulcsaira megy, tehat ha
    // valaki uj mappat vesz fel a life-tree NAMES tablajaba, ez a teszt
    // megbuktatja, amig nem ad hozza ikont is.
    expect(keysWithoutIcon(), `ikon nelkuli fa-kulcsok: ${keysWithoutIcon().join(', ')}`).toEqual([])
    expect(Object.keys(iconTable()).length).toBeGreaterThanOrEqual(lifeNameKeys().length)
  })

  it('ismeretlen kulcsra nem talalunk ki ikont, hanem a sima mappa jon', () => {
    expect(iconForKey('nincs-ilyen-kulcs')).toBe(DEFAULT_FOLDER_ICON)
  })

  it('a lemezen levo mappanevbol is megvan az ikon, MINDKET nyelven', () => {
    // A lemezre kerulo nev nyelvfuggo (`Jogi` / `Legal`), ezert nevre kotni
    // nem lehet -- a kulcs a gepi nev. Ezt meri ez a sor.
    const huName = lifeName('legal', 'hu')
    const enName = lifeName('legal', 'en')
    expect(iconForFolderName(huName)).toBe(iconForKey('legal'))
    expect(iconForFolderName(enName)).toBe(iconForKey('legal'))
    expect(iconForFolderName('Valami saját mappa')).toBe(DEFAULT_FOLDER_ICON)
  })
})
