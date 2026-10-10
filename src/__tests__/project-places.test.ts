// #530 (the owner's specification, chapter 50): the places of the Life tree a project belongs to.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { addProjectPlace, listProjectPlaces, moveProjectPlacesPrefix, removeProjectPlace, PROJECT_PLACES_MAX } from '../project-places.js'

describe('project places', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a project remembers folders; once each; removal removes the pointer only', () => {
    expect(listProjectPlaces('p1')).toEqual([])
    expect(addProjectPlace('p1', 'Család/Anna/Hatóságok/Jobcenter', 'o').ok).toBe(true)
    expect(addProjectPlace('p1', '/Család/Anna/Hatóságok/Bíróság/', 'o').ok).toBe(true)
    const dup = addProjectPlace('p1', 'Család/Anna/Hatóságok/Jobcenter/', 'o')
    expect(dup.ok === false && dup.code).toBe('duplicate')
    for (const bad of ['', '../..', 'a/../b']) { const r = addProjectPlace('p1', bad, 'o'); expect(r.ok === false && r.code).toBe('bad_input') }
    expect(listProjectPlaces('p1')).toEqual(['Család/Anna/Hatóságok/Jobcenter', 'Család/Anna/Hatóságok/Bíróság'].sort((a, b) => a.localeCompare(b)).reverse().sort())
    // Another project has its own list.
    expect(listProjectPlaces('p2')).toEqual([])
    expect(removeProjectPlace('p2', 'Család/Anna/Hatóságok/Jobcenter').ok).toBe(false)
    expect(removeProjectPlace('p1', 'Család/Anna/Hatóságok/Jobcenter').ok).toBe(true)
    expect(listProjectPlaces('p1')).toEqual(['Család/Anna/Hatóságok/Bíróság'])
  })

  it('a renamed or moved folder is followed -- the place itself, and a place below the renamed folder', () => {
    addProjectPlace('p1', 'Család/Anna/Hatóságok/Jobcenter', 'o')
    addProjectPlace('p2', 'Család/Anna/Hatóságok/Jobcenter/Kimenő', 'o')
    addProjectPlace('p2', 'Család/Anna/Hatóságok2', 'o') // a name prefix is not the folder
    expect(moveProjectPlacesPrefix('Család/Anna/Hatóságok', 'Család/Anna/Hivatalok')).toBe(2)
    expect(listProjectPlaces('p1')).toEqual(['Család/Anna/Hivatalok/Jobcenter'])
    expect(listProjectPlaces('p2').sort()).toEqual(['Család/Anna/Hatóságok2', 'Család/Anna/Hivatalok/Jobcenter/Kimenő'])
    expect(moveProjectPlacesPrefix('x', 'x')).toBe(0)
  })

  it('two places that become the same folder are kept once', () => {
    addProjectPlace('p1', 'A/Régi', 'o')
    addProjectPlace('p1', 'A/Új', 'o')
    moveProjectPlacesPrefix('A/Régi', 'A/Új')
    expect(listProjectPlaces('p1')).toEqual(['A/Új'])
  })

  it('there is an upper limit, and it is said', () => {
    for (let i = 0; i < PROJECT_PLACES_MAX; i++) expect(addProjectPlace('p1', 'M/' + i, 'o').ok).toBe(true)
    const r = addProjectPlace('p1', 'M/tobb', 'o')
    expect(r.ok === false && r.code).toBe('too_many')
  })
})
