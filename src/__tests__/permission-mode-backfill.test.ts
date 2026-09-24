// NE KERDEZZEN ENGEDELYT -- A FRISSITO TELEPITES IS KAPJA MEG.
//
// Boss, 2026-09-13: "soha ne is jojjon fel nekem ilyen! ne kelljen nyomogani
// egesz nap ezt a yes gombokat."
//
// A MERT HIBA. A `permissions.defaultMode: bypassPermissions` harom helyen
// megvolt (projekt .claude/settings.json, templates/settings.json.template,
// install-linux.sh), es Boss MEGIS egesz nap nyomkodta a yes-t. Mert:
//   * az `install-linux.sh` csak TELEPITESKOR ir;
//   * a `scaffoldAgentDir` csak UJ agensnek masolja a teljes sablont;
//   * az `ensureAgentHooks` induláskor CSAK a `hooks` blokkot fesuli ossze, a
//     `permissions`-hoz SOHA nem nyul.
// Egy mar meglevo telepites, ami csak `git pull`-lal frissit, tehat SOHA nem
// kapta meg -- es semmi nem szolt errol. Ez a nema nulla: a rendszer
// "rendben"-nek latszik, kozben mindenki nyomkodja a yes-t.
//
// A DONTES, amit ez a teszt leszogez: A HIANYZO NEM UGYANAZ, MINT A VALASZTOTT.
// Az erteket CSAK akkor irjuk be, ha a kulcs egyaltalan nincs ott (senki nem
// dontott). Barmilyen meglevo erteket -- a szandekos "acceptEdits"-et is --
// erintetlenul hagyunk, mert az install-linux.sh EPP EZT dokumentalja
// visszaveteli utkent. Egy induláskor felulíro job lehetetlenne tenne a
// dokumentalt kiszallast: a tulaj beallitja, a kovetkezo ujraindulas szo
// nelkul visszacsinalja.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decidePermissionMode } from '../web/agent-scaffold.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WEB_TS = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf8')
const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf8')

describe('a hianyzo ertek bekerul', () => {
  it('teljesen ures beallitasba beirja a sablon ertekét', () => {
    const out = decidePermissionMode({}, 'bypassPermissions')
    expect(out).not.toBeNull()
    expect((out!.permissions as Record<string, unknown>).defaultMode).toBe('bypassPermissions')
  })

  it('letezo permissions blokkba is beirja, ha csak a defaultMode hianyzik', () => {
    const out = decidePermissionMode({ permissions: { allow: ['Bash(ls)'] } }, 'bypassPermissions')
    expect((out!.permissions as Record<string, unknown>).defaultMode).toBe('bypassPermissions')
    // Az allow lista nem veszhet el.
    expect((out!.permissions as Record<string, unknown>).allow).toEqual(['Bash(ls)'])
  })

  it('a tobbi kulcsot (hooks, enabledPlugins) valtozatlanul hagyja', () => {
    const before = {
      hooks: { PreCompact: [{ matcher: 'auto' }] },
      enabledPlugins: { 'telegram@claude-plugins-official': true },
      model: 'opus',
    }
    const out = decidePermissionMode(before, 'bypassPermissions')!
    expect(out.hooks).toEqual(before.hooks)
    expect(out.enabledPlugins).toEqual(before.enabledPlugins)
    expect(out.model).toBe('opus')
  })

  it('nem mutalja a bemenetet (a hivo eldontheti, ir-e)', () => {
    const before: Record<string, unknown> = {}
    decidePermissionMode(before, 'bypassPermissions')
    expect(before.permissions).toBeUndefined()
  })
})

describe('a MEGLEVO dontest SOHA nem irja felul', () => {
  // Ez a dokumentalt kiszallas vedelme. Ha ez elromlik, a tulaj nem tudja
  // visszavenni az automatikat: beallitja, es az ujraindulas visszacsinalja.
  it('a szandekos acceptEdits marad', () => {
    expect(decidePermissionMode({ permissions: { defaultMode: 'acceptEdits' } }, 'bypassPermissions')).toBeNull()
  })

  it('a "default" (mindent kerdez) is marad', () => {
    expect(decidePermissionMode({ permissions: { defaultMode: 'default' } }, 'bypassPermissions')).toBeNull()
  })

  it('a mar beallitott bypassPermissions eseten nem ir ujra (idempotens)', () => {
    expect(decidePermissionMode({ permissions: { defaultMode: 'bypassPermissions' } }, 'bypassPermissions')).toBeNull()
  })

  it('az ures sztring is DONTES, nem hiany -- marad', () => {
    expect(decidePermissionMode({ permissions: { defaultMode: '' } }, 'bypassPermissions')).toBeNull()
  })
})

describe('hianyzo sablon-ertek eseten nem talalgat', () => {
  it('ha a sablon nem mond modot, nem ir semmit', () => {
    expect(decidePermissionMode({}, undefined)).toBeNull()
    expect(decidePermissionMode({}, '')).toBeNull()
    expect(decidePermissionMode({}, null)).toBeNull()
  })
})

describe('a lanc tenylegesen be van kotve', () => {
  it('a sablon tartalmaz permissions.defaultMode-ot (kulonben az egesz lanc nema)', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf8'))
    expect(tpl.permissions?.defaultMode, 'a sablonbol hianyzik a defaultMode').toBe('bypassPermissions')
  })

  it('a boot-kor MINDEN agensre meghivja, a fo agensre is', () => {
    // A ciklus fejlece [MAIN_AGENT_ID, ...listAgentNames()] -- a hivas ezen
    // belul all, tehat a fo agens (~/.claude/settings.json) is megkapja.
    expect(WEB_TS).toContain('if (ensurePermissionMode(agentName)) permModePatched.push(agentName)')
    expect(WEB_TS).toContain('[MAIN_AGENT_ID, ...listAgentNames()]')
  })

  it('a fo agens beallitasfajlja tenyleg a ~/.claude/settings.json', () => {
    expect(SCAFFOLD).toMatch(/if \(name === MAIN_AGENT_ID\) return join\(homedir\(\), '\.claude', 'settings\.json'\)/)
  })

  it('olvashatatlan settings.json eseten nem ir (nem tapos le kezi configot)', () => {
    const body = SCAFFOLD.slice(SCAFFOLD.indexOf('export function ensurePermissionMode'))
    expect(body).toMatch(/catch \{[\s\S]*?return false/)
  })
})
