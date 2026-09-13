import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readMainExpectedEmail,
  pinMainExpectedEmail,
  mainAccountVerdict,
} from '../web/main-account-identity.js'

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'main-acct-')), 'main-account.json')
}

describe('mainAccountVerdict', () => {
  it('vak proba -> blind (a "nem latok oda" nem "rendben")', () => {
    expect(mainAccountVerdict(false, false, null, null)).toEqual({ kind: 'blind' })
    expect(mainAccountVerdict(false, true, 'a@b.com', 'a@b.com')).toEqual({ kind: 'blind' })
  })

  it('kijelentkezve -> signed_out', () => {
    expect(mainAccountVerdict(true, false, null, 'a@b.com')).toEqual({ kind: 'signed_out' })
    expect(mainAccountVerdict(true, true, null, 'a@b.com')).toEqual({ kind: 'signed_out' })
  })

  it('nincs rogzitett cim -> unpinned (elso megfigyeles)', () => {
    expect(mainAccountVerdict(true, true, 'a@b.com', null)).toEqual({ kind: 'unpinned', actual: 'a@b.com' })
  })

  it('mas fiok van benne, mint a rogzitett -> drift', () => {
    expect(mainAccountVerdict(true, true, 'usalackor@gmail.com', 'lackor2@gmail.com'))
      .toEqual({ kind: 'drift', expected: 'lackor2@gmail.com', actual: 'usalackor@gmail.com' })
  })

  it('a rogzitett fiok van benne -> ok (kis/nagybetu nem szamit)', () => {
    expect(mainAccountVerdict(true, true, 'Lackor2@Gmail.com', 'lackor2@gmail.com'))
      .toEqual({ kind: 'ok', actual: 'lackor2@gmail.com' })
  })
})

describe('pin/read main expected email', () => {
  it('friss telepites: nincs fajl -> null (nem hiba)', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'main-acct-')), 'nincs.json')
    expect(readMainExpectedEmail(p)).toBeNull()
  })

  it('elso pin rogzit, masodik (nem-force) NEM ir felul', () => {
    const p = tmp()
    expect(pinMainExpectedEmail('lackor2@gmail.com', { path: p })).toEqual({ ok: true, changed: true })
    expect(readMainExpectedEmail(p)).toBe('lackor2@gmail.com')
    // Mas cim, nem-force: nem ir felul, a drift-ellenorzes dolga jelezni.
    expect(pinMainExpectedEmail('usalackor@gmail.com', { path: p })).toEqual({ ok: true, changed: false })
    expect(readMainExpectedEmail(p)).toBe('lackor2@gmail.com')
    rmSync(p, { force: true })
  })

  it('ugyanaz a cim ujra -> changed:false', () => {
    const p = tmp()
    pinMainExpectedEmail('a@b.com', { path: p })
    expect(pinMainExpectedEmail('A@B.com', { path: p })).toEqual({ ok: true, changed: false })
    rmSync(p, { force: true })
  })

  it('force: a felhasznalo dontese atirja', () => {
    const p = tmp()
    pinMainExpectedEmail('lackor2@gmail.com', { path: p })
    expect(pinMainExpectedEmail('uj@gmail.com', { path: p, force: true })).toEqual({ ok: true, changed: true })
    expect(readMainExpectedEmail(p)).toBe('uj@gmail.com')
    rmSync(p, { force: true })
  })

  it('ures cim -> hiba', () => {
    const p = tmp()
    expect(pinMainExpectedEmail('', { path: p })).toEqual({ ok: false, error: 'hianyzo cim' })
    expect(existsSync(p)).toBe(false)
  })

  it('serult fajl -> null olvasas (nem dobja el a lapot)', () => {
    const p = tmp()
    writeFileSync(p, '{ ez nem json')
    expect(readMainExpectedEmail(p)).toBeNull()
    rmSync(p, { force: true })
  })

  it('a tarolt fajl normalizalt cimet tart', () => {
    const p = tmp()
    pinMainExpectedEmail('  Lackor2@Gmail.com  ', { path: p })
    expect(JSON.parse(readFileSync(p, 'utf-8')).expectedEmail).toBe('lackor2@gmail.com')
    rmSync(p, { force: true })
  })
})
