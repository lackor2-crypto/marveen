// Az "Újraindítás most" gomb probaja.
//
// Amit itt merni kell, az NEM az, hogy ujraindul-e valami -- azt egy teszt nem
// tudja kiprobalni. Az a kerdes, hogy MIT INDITANA UJRA, es hogy a tiltott
// esetekben tenylegesen el sem indul semmi.
//
// Miert eletbevago ez? Mert a csatorna-unit ujrainditasa megolne a kozos tmux
// szervert, es vele EGYUTT minden agens munkamenetet (lasd
// src/web/channel-monitor.ts:1048). Egy elgepelt unitnev itt nem "hiba", hanem
// az osszes futo munka elvesztese.
//
// Amit szandekosan NEM tesztelunk: a sikeres POST-ot a valodi vegponton. Az a
// teszt futtato gepet inditana ujra. Helyette a dontest merjuk (mit hivnank
// meg), es a sorrendet a forraskodban horgonyozzuk le.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync as read } from 'node:fs'
import { join } from 'node:path'
import {
  ownSystemdUnit, unitIsSafeToRestart, restartAvailability, restartCommand, performSelfRestart,
} from '../self-restart.js'
import { tryHandleSystemRestart } from '../web/routes/system-restart.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(__dirname, '..', '..')

// Ez egy VALODI cgroup-sor a futo vezerlopultbol (2026-08-15-en merve).
const DASHBOARD_CGROUP =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/lackor2-bot-dashboard.service\n'
const CHANNELS_CGROUP =
  '0::/user.slice/user-1000.slice/user@1000.service/app.slice/lackor2-bot-channels.service\n'

function fakeReq(method: string, path: string): { ctx: RouteContext; out: { status: number; body: any; finishHooks: number } } {
  const out = { status: 200, body: null as any, finishHooks: 0 }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    // A vegpont ide koti az ujrainditast: eloszor valasz, aztan leallas.
    once(event: string) { if (event === 'finish') out.finishHooks++ },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = { on(event: string, cb: (c?: Buffer) => void) { if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('melyik szolgaltatast inditanank ujra', () => {
  it('a sajat unitjat ismeri fel a cgroupbol', () => {
    expect(ownSystemdUnit(DASHBOARD_CGROUP)).toBe('lackor2-bot-dashboard.service')
  })

  it('a felhasznaloi systemd-menedzsert NEM nezi sajat maganak', () => {
    // Ha a `user@1000.service`-t valasztana, az ujrainditas az EGESZ
    // felhasznaloi munkamenetet ujrainditana -- minden szolgaltatast.
    expect(ownSystemdUnit('0::/user.slice/user-1000.slice/user@1000.service\n')).toBeNull()
  })

  it('ha nem szolgaltataskent futunk, nincs mit ujrainditani', () => {
    expect(ownSystemdUnit('0::/\n')).toBeNull()
    expect(ownSystemdUnit('0::/user.slice/user-1000.slice/session-3.scope\n')).toBeNull()
    expect(ownSystemdUnit('')).toBeNull()
  })

  it('a legbelso szolgaltatast valasztja, nem az elsot', () => {
    // Egy beagyazott alakban a mi unitunk hatul van.
    expect(ownSystemdUnit('0::/user.slice/user@1000.service/app.slice/valami-dashboard.service\n'))
      .toBe('valami-dashboard.service')
  })
})

describe('amit soha nem szabad ujrainditani', () => {
  it('a csatorna-unitot NEM inditja ujra (megolne minden agens munkamenetet)', () => {
    expect(unitIsSafeToRestart('lackor2-bot-channels.service')).toBe(false)
    expect(unitIsSafeToRestart('marveen-channels.service')).toBe(false)
    // Nagybetuvel is: a tiltas nem mulhat azon, hogyan irtak a unit nevet.
    expect(unitIsSafeToRestart('Foo-CHANNELS.service')).toBe(false)
  })

  it('csak `.service` johet szoba', () => {
    expect(unitIsSafeToRestart('session-3.scope')).toBe(false)
    expect(unitIsSafeToRestart('')).toBe(false)
    expect(unitIsSafeToRestart(null)).toBe(false)
  })

  it('csatorna-unitban futva a gomb NEM elerheto, es meg is mondja, miert', () => {
    const a = restartAvailability(CHANNELS_CGROUP)
    expect(a.possible).toBe(false)
    expect(a.reason).toMatch(/ügynök/i)
  })

  it('tiltott esetben tenylegesen EL SEM INDUL semmi', () => {
    // Ez a lenyeg: nem eleg, hogy `possible:false` -- a parancs sem futhat.
    const spawnFn = vi.fn()
    const r = performSelfRestart(CHANNELS_CGROUP, spawnFn as any)
    expect(r.possible).toBe(false)
    expect(spawnFn).not.toHaveBeenCalled()
    // Es az indoklas MEGMONDJA AZ IGAZAT: azert nem indul, mert nem szabad --
    // nem azert, mert "nem sikerult". A ketto teljesen mas dontest hoz annal,
    // aki olvassa: az egyik szandekos, a masik egy hiba, amit javitani kene.
    expect(r.reason).toMatch(/ügynök/i)
    expect(r.reason).not.toMatch(/nem sikerült/i)
  })
})

describe('az ujrainditas parancsa', () => {
  it('pontosan a sajat unitjat inditja ujra, felhasznaloi szinten', () => {
    const { cmd, args } = restartCommand('lackor2-bot-dashboard.service')
    expect(cmd).toBe('systemd-run')
    expect(args).toContain('--user')
    // SZO SZERINT ez a parancs fut le -- nem "tartalmazza", hanem EZ.
    // Egy odaragadt toldalek (`...service-channels`) mar mas unitot celozna,
    // es azt egy "tartalmazza" ellenorzes atengedne.
    expect(args[args.length - 1]).toBe('sleep 1; systemctl --user restart lackor2-bot-dashboard.service')
    // Rendszerszintu ujrainditas sose: az mas felhasznalok szolgaltatasaihoz nyulna.
    expect(args.join(' ')).not.toMatch(/--system|sudo/)
  })

  it('tiltott unitra parancsot sem epit -- nem csak a hivo helyen tiltjuk', () => {
    // Ha egy kesobbi atiras elvesztene a hivo oldali ellenorzest, itt akkor is
    // megall. A csatorna-unit ujrainditasa minden agens munkamenetet megolne.
    expect(() => restartCommand('lackor2-bot-channels.service')).toThrow()
    expect(() => restartCommand('session-3.scope')).toThrow()
  })

  it('kulon egysegben fut, kulonben magat olne meg indulas kozben', () => {
    // A `systemctl restart` azt a folyamatot is megoli, amelyik elinditotta.
    // A `systemd-run` a mi cgroupunkon KIVUL futtatja -- enelkul az
    // ujrainditas fele uton megallna.
    const { cmd, args } = restartCommand('x-dashboard.service')
    expect(cmd).toBe('systemd-run')
    expect(args.join(' ')).toMatch(/sleep 1;/)
  })

  it('a sajat cgroupbol vett unitot hivja meg, nem valami talalgatast', () => {
    const spawnFn = vi.fn(() => ({ unref() {} }))
    const r = performSelfRestart(DASHBOARD_CGROUP, spawnFn as any)
    expect(r.possible).toBe(true)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    const [cmd, args] = spawnFn.mock.calls[0] as any[]
    expect(cmd).toBe('systemd-run')
    expect((args as string[]).join(' ')).toContain('lackor2-bot-dashboard.service')
  })
})

describe('a vegpont', () => {
  it('a GET megmondja, lehet-e, es mikor indult ez a folyamat', async () => {
    const { ctx, out } = fakeReq('GET', '/api/system/restart')
    expect(await tryHandleSystemRestart(ctx)).toBe(true)
    expect(out.body).toHaveProperty('possible')
    // Ez a "mar visszajott?" merceje: uj folyamat = uj idobelyeg.
    expect(typeof out.body.startedAt).toBe('number')
    expect(out.body.startedAt).toBeGreaterThan(0)
  })

  it('a GET nem inditja ujra semmi', async () => {
    // Egy kopogtato vegpontnak nem lehet mellekhatasa: a felulet
    // masodpercenkent hivja, amig vissza nem jon a szolgaltatas.
    const route = read(join(ROOT, 'src', 'web', 'routes', 'system-restart.ts'), 'utf8')
    const getBlock = route.slice(route.indexOf("method === 'GET'"), route.indexOf("method === 'POST'"))
    expect(getBlock).not.toContain('performSelfRestart')
  })

  it('ELOSZOR valaszol, es csak azutan indul ujra', async () => {
    // Forditva a bongeszo egy megszakadt kapcsolatot latna, es a felhasznalo
    // azt hinne, elromlott valami -- pedig eppen az tortenik, amit kert.
    const route = read(join(ROOT, 'src', 'web', 'routes', 'system-restart.ts'), 'utf8')
    expect(route).toMatch(/json\(res, \{ ok: true[^\n]*\n\s*res\.once\('finish', \(\) => \{ performSelfRestart\(\) \}\)/)
  })
})
