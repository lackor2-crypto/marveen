// MEGA fiokok (kartya e67bf278): a belepes csak valodi siker utan marad meg,
// a jelszo nem kerul argumentumba, a levetel mas konfig-szakaszhoz nem nyul.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-mega-'))
const fakeBin = join(store, 'rclone-fake')
writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 })

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const mega = await import('../mega.js')
type Call = { args: string[]; input?: string }

function runner(aboutOk: boolean, calls: Call[]): import('../mega.js').Runner {
  return async (_bin, args, input) => {
    calls.push({ args, input })
    if (args[0] === 'obscure') return { code: 0, stdout: 'OBSCURED\n', stderr: '' }
    if (args[0] === 'about') {
      return aboutOk
        ? { code: 0, stdout: JSON.stringify({ total: 21474836480, used: 1073741824, free: 20401094656 }), stderr: '' }
        : { code: 1, stdout: '', stderr: 'Failed to create file system: couldn\'t login: Object (typically, node or user) not found' }
    }
    return { code: 0, stdout: 'rclone v1.71.0\n', stderr: '' }
  }
}

beforeEach(() => {
  process.env.MARVEEN_RCLONE = fakeBin
  for (const f of ['mega-accounts.json', 'mega-quota.json', 'rclone']) rmSync(join(store, f), { recursive: true, force: true })
})

describe('MEGA fiokok', () => {
  it('sikeres belepes utan a fiok, a konfig es a tarhely is megmarad', async () => {
    const calls: Call[] = []
    const r = await mega.addMegaAccount({ email: 'Teszt.Egy@example.com', password: 'titok' }, runner(true, calls))
    expect(r.ok).toBe(true)
    expect(mega.megaAccountNames()).toEqual(['teszt_egy'])
    const conf = readFileSync(mega.rcloneConfigPath(), 'utf8')
    expect(conf).toContain('[mega_teszt_egy]')
    expect(conf).toContain('pass = OBSCURED')
    expect(conf).not.toContain('titok')
    expect(statSync(mega.rcloneConfigPath()).mode & 0o777).toBe(0o600)
    expect(mega.readMegaQuota().teszt_egy.free).toBe(20401094656)
  })

  it('a jelszo a standard bemeneten megy, soha nem argumentumban', async () => {
    const calls: Call[] = []
    await mega.addMegaAccount({ email: 'a@b.hu', password: 'titok' }, runner(true, calls))
    for (const c of calls) expect(c.args.join(' ')).not.toContain('titok')
    expect(calls.find((c) => c.args[0] === 'obscure')?.input).toBe('titok')
  })

  it('sikertelen belepesnel semmi nem marad, es a MEGA sajat uzenete visszajon', async () => {
    const r = await mega.addMegaAccount({ email: 'a@b.hu', password: 'rossz' }, runner(false, []))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('login_failed')
      expect(r.detail).toContain('not found')
    }
    expect(mega.megaAccountNames()).toEqual([])
    expect(readFileSync(mega.rcloneConfigPath(), 'utf8')).not.toContain('mega_a')
  })

  it('rclone nelkul kimondja, hogy hianyzik -- nem "nincs fiok"', async () => {
    process.env.MARVEEN_RCLONE = join(store, 'nincs-ilyen')
    const r = await mega.addMegaAccount({ email: 'a@b.hu', password: 'x' }, runner(true, []))
    expect(r).toEqual({ ok: false, error: 'rclone_missing' })
    expect((await mega.rcloneStatus(runner(true, []))).installed).toBe(false)
  })

  it('ugyanaz a fiok ketszer nem veheto fel', async () => {
    await mega.addMegaAccount({ email: 'a@b.hu', password: 'x' }, runner(true, []))
    const r = await mega.addMegaAccount({ email: 'A@b.hu', password: 'x' }, runner(true, []))
    expect(r.ok).toBe(false)
  })

  it('a levetel csak a sajat szakaszt viszi, a tobbi marad', async () => {
    await mega.addMegaAccount({ email: 'egy@b.hu', password: 'x' }, runner(true, []))
    await mega.addMegaAccount({ email: 'ketto@b.hu', password: 'x' }, runner(true, []))
    expect(mega.removeMegaAccount('egy')).toBe(true)
    const conf = readFileSync(mega.rcloneConfigPath(), 'utf8')
    expect(conf).not.toContain('[mega_egy]')
    expect(conf).toContain('[mega_ketto]')
    expect(mega.megaAccountNames()).toEqual(['ketto'])
    expect(mega.readMegaQuota().egy).toBeUndefined()
  })

  it('a meres hibaja idobelyeggel rogzul, nem nullakent', async () => {
    await mega.addMegaAccount({ email: 'a@b.hu', password: 'x' }, runner(true, []))
    const q = await mega.measureMegaQuota('a', runner(false, []))
    expect(q?.free).toBeNull()
    expect(q?.error).toContain('not found')
    expect(existsSync(join(store, 'mega-quota.json'))).toBe(true)
  })
})

describe('MEGA onellenorzes es tarolo-sor', () => {
  const acc = (name: string) => ({ name, email: name + '@x.hu', remote: 'mega_' + name, addedAt: 1 })

  it('fiok nelkul csend (friss telepites), rclone nelkul sarga -- soha nem piros', async () => {
    const { megaRows } = await import('../web/system-health.js')
    expect(megaRows([], {}, false)).toEqual([])
    const r = megaRows([acc('a')], {}, false)
    expect(r).toEqual([{ id: 'mega_rclone_missing', status: 'warn', params: { n: 1 } }])
  })

  it('a sikertelen meres es a tele fiok kulon sort kap, a szabad fiok csendes', async () => {
    const { megaRows } = await import('../web/system-health.js')
    const q = {
      a: { total: 100, used: 99, free: 1, measuredAt: 1 },
      b: { total: null, used: null, free: null, measuredAt: 1, error: 'x' },
      c: { total: 100, used: 10, free: 90, measuredAt: 1 },
    }
    const ids = megaRows([acc('a'), acc('b'), acc('c')], q, true).map((r) => r.id)
    expect(ids).toEqual(['mega_quota_failed', 'mega_quota_full'])
  })

  it('a MEGA fiok a Tarolok alatt sajat MEGA_01 azonositot kap', async () => {
    const { listStorages } = await import('../storages.js')
    const root = mkdtempSync(join(tmpdir(), 'marveen-megadepot-'))
    const reg = { ids: {}, names: {}, disabled: {}, gitAccounts: [] }
    const { rows } = listStorages({ driveAccounts: [], photosAccounts: [], megaAccounts: ['teszt'], root, registry: reg })
    const row = rows.find((r) => r.kind === 'mega')
    expect(row?.id).toBe('MEGA_01')
    expect(row?.rel).toMatch(/\/MEGA\/teszt$/)
    expect(row?.connected).toBe(true)
  })
})
