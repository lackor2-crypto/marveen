// #390 kiegeszites (lackor2 komment 1444, Boss TG 6383): halozati hiba vagy
// ujraindulas eseten emberi mondat ("A Marveen eppen frissul, pillanat...") es
// automatikus ujraprobalkozas MINDEN oldalon -- nem nyers "Failed to fetch".
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync('web/app.js', 'utf8')
const hu = readFileSync('web/lang/hu.js', 'utf8')
const en = readFileSync('web/lang/en.js', 'utf8')

function fnBody(head: string): string {
  const i = app.indexOf(head)
  if (i < 0) throw new Error('missing: ' + head)
  return app.slice(i, app.indexOf('\n}', i) + 2)
}

const create = new Function(fnBody('function createResilientFetch(') + '\nreturn createResilientFetch')() as (
  raw: (i: any, init?: any) => Promise<any>,
  opts?: any,
) => (i: any, init?: any) => Promise<any>

const netErr = () => new TypeError('Failed to fetch')
const ok = (status = 200) => ({ ok: status < 400, status })

function harness(script: Array<'net' | number>, extra: any = {}) {
  const calls: any[] = []
  const events: string[] = []
  let n = 0
  const raw = async (input: any, init?: any) => {
    calls.push({ input, init })
    const step = script[Math.min(n++, script.length - 1)]
    if (step === 'net') throw netErr()
    return ok(step)
  }
  const f = create(raw, {
    delays: [1, 1, 1],
    sleep: async () => {},
    onDown: () => events.push('down'),
    onUp: () => events.push('up'),
    onGiveUp: (idem: boolean) => events.push('giveup:' + idem),
    msgRead: () => 'HUMAN_READ',
    msgWrite: () => 'HUMAN_WRITE',
    ...extra,
  })
  return { f, calls, events }
}

describe('#390 createResilientFetch', () => {
  it('GET halozati hiba utan ujraprobal, es a helyreallas utan a valaszt adja', async () => {
    const h = harness(['net', 'net', 200])
    const res = await h.f('/api/kanban')
    expect(res.status).toBe(200)
    expect(h.calls.length).toBe(3)
    expect(h.events).toEqual(['down', 'down', 'up'])
  })

  it('kifogyott probalkozas utan emberi mondatot dob, nem "Failed to fetch"-et', async () => {
    const h = harness(['net'])
    const e = await h.f('/api/kanban').catch((x: any) => x)
    expect(e.message).toBe('HUMAN_READ')
    expect(e.cause).toBeInstanceOf(TypeError)
    expect(h.calls.length).toBe(4) // 1 + 3 retry
    expect(h.events.at(-1)).toBe('giveup:true')
  })

  it('POST-ot SOHA nem ismetel (lehet, hogy mar lefutott), a mondat szerint nem ment vegbe', async () => {
    const h = harness(['net', 200])
    const e = await h.f('/api/kanban', { method: 'POST', body: '{}' }).catch((x: any) => x)
    expect(e.message).toBe('HUMAN_WRITE')
    expect(h.calls.length).toBe(1)
    expect(h.events).toEqual(['down', 'giveup:false'])
  })

  it('AbortError valtozatlanul atmegy, ujraprobalas nelkul', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const f = create(async () => { throw abort }, { delays: [1], sleep: async () => {} })
    await expect(f('/api/x')).rejects.toBe(abort)
  })

  it('a sajat szandekos 502/503 valasz (pl. Drive) azonnal atmegy, ha a szerver el', async () => {
    const h = harness([502], { probe: async () => true })
    const res = await h.f('/api/drive/list')
    expect(res.status).toBe(502)
    expect(h.calls.length).toBe(1)
    expect(h.events).toEqual(['up'])
  })

  it('proxy 502 mikozben a szerver all: kiesesnek veszi es ujraprobal', async () => {
    let probes = 0
    const h = harness([502, 502, 200], { probe: async () => { probes++; return false } })
    const res = await h.f('/api/kanban')
    expect(res.status).toBe(200)
    expect(h.calls.length).toBe(3)
    expect(probes).toBe(2)
  })

  it('a varakozas alatt megszakitott keres nem probalkozik tovabb', async () => {
    const ctrl = new AbortController()
    let n = 0
    const f = create(async () => { n++; throw netErr() }, { delays: [1, 1, 1], sleep: async () => { ctrl.abort() } })
    await expect(f('/api/x', { signal: ctrl.signal })).rejects.toBeInstanceOf(TypeError)
    expect(n).toBe(1)
  })
})

describe('#390 bekotes', () => {
  it('a globalis fetch-burkolo az /api hivasokat a rugalmas fetch-en at kuldi', () => {
    expect(app).toContain('const res = await (isSameOriginApi ? apiFetch : originalFetch)(input, init)')
    expect(app).toContain("msgRead: () => window.t('net.unreachable')")
    expect(app).toContain("msgWrite: () => window.t('net.unreachable_action')")
    expect(app).toContain('onGiveUp: _netStatus.giveUp')
  })

  it('helyreallaskor az aktiv oldal ujratolti magat (a Beallitasok kivetelevel)', () => {
    const i = app.indexOf('const _netStatus = (() => {')
    const block = app.slice(i, app.indexOf('\n})()', i))
    expect(block).toContain("active !== 'settings'")
    expect(block).toContain('switchPage(active)')
    expect(block).toContain("show('net.restarting')")
  })

  it('a mondatok mindket nyelven megvannak', () => {
    for (const k of ['net.restarting', 'net.back', 'net.unreachable', 'net.unreachable_action']) {
      expect(hu).toContain(`'${k}':`)
      expect(en).toContain(`'${k}':`)
    }
    expect(hu).toContain('éppen frissül, pillanat')
  })
})
