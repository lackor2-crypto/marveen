// FRISS TELEPITES: a kod-hidat annak is uzembe kell tudnia helyezni, aki most
// toltotte le a Marveent -- a feluletrol, terminal es kezi .env-szerkesztes
// nelkul (Boss, 2026-08-22: "fel kell kesziteni a marveen t arra hogy masok is
// tudjak majd hasznalni ezt a funkciot is").
//
// Harom dolgot rogzitenek az itteni tesztek:
//
//   * a VS Code vegrehajto kartyaja a FIZETOS savba kerul, nem az ingyenesek
//     koze -- a sav a lap egyetlen jelzese arrol, mi megy kozos ingyen-poolon;
//   * a lap sorrendben megmondja, mi a kovetkezo beuzemelesi lepes, es amint
//     a kotelezo lepesek megvannak, a lista eltunik;
//   * amit a lap kimasolhato parancskent kinal, az AZON a telepitesen ervenyes,
//     ahol fut -- nem a szerzo sajat WSL-utvonala.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { detectHostKind } from '../web/routes/code.js'

const ROOT = process.cwd()
const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8')
const route = readFileSync(join(ROOT, 'src/web/routes/code.ts'), 'utf8')

describe('a vegrehajto kartyaja a fizetos savban all', () => {
  it('renders before the free-tier divider, not after it', () => {
    // A kartyakat mind ugyanaz az insertBefore(addBtn) rakja ki, tehat a
    // HIVASI SORREND a megjelenesi sorrend. A szintvalaszto csik a ciklusban
    // keszul; ami a ciklus UTAN hivodik, az a csik ala kerul -- igy csuszott
    // a kod-hid kartyaja az ingyenes agensek koze.
    const call = app.indexOf('renderCodeBridgeAgentCards(agentsGrid, addBtn)')
    const divider = app.indexOf(`dividerEl.className = 'agent-tier-divider'`)
    expect(call).toBeGreaterThan(-1)
    expect(divider).toBeGreaterThan(-1)
    expect(call).toBeLessThan(divider)
  })

  it('is called exactly once, right after the Marveen card', () => {
    // A fuggveny DEFINICIOJA ugyanezt a szoveget tartalmazza, ezert a hivast a
    // sor eleji behuzas kulonbozteti meg tole.
    const calls = app.split('\n  renderCodeBridgeAgentCards(agentsGrid, addBtn)').length - 1
    expect(calls).toBe(1)
    const marveen = app.indexOf('agentsGrid.insertBefore(mCard, addBtn)')
    const call = app.indexOf('renderCodeBridgeAgentCards(agentsGrid, addBtn)')
    expect(marveen).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(marveen)
  })

  it('tells the owner the NEXT step, not just that nothing is there', () => {
    // Harom kulon allapot -- kikapcsolt hid, hianyzo vegrehajto, nulla projekt
    // -- harom kulon teendo. Egyetlen "nincs projekt" szoveg mindharomra
    // hazudna, es a friss telepites pont az elso kettoben all.
    const fn = app.slice(app.indexOf('function cbIdleCardEntry('), app.indexOf('function renderCodeBridgeAgentCards('))
    expect(fn).toContain('ki van kapcsolva')
    expect(fn).toContain('Nincs futó Windows-végrehajtó')
    expect(fn).toContain('még egy projekt sincs regisztrálva')
    expect(fn).toContain('codeBridgeCards.workerOnline')
  })
})

describe('beuzemelesi lista', () => {
  it('has a card on the page with a place for the steps', () => {
    expect(html).toContain('id="cbSetupCard"')
    expect(html).toContain('id="cbSetupSteps"')
    expect(html).toContain('id="cbSetupProgress"')
  })

  it('every step points at a card that actually exists', () => {
    const fn = app.slice(app.indexOf('function cbSetupStepList('), app.indexOf('function cbRenderSetup('))
    const targets = [...fn.matchAll(/target: '([A-Za-z]+)'/g)].map((m) => m[1])
    expect(targets.length).toBe(4)
    for (const id of targets) expect(html).toContain(`id="${id}"`)
  })

  it('treats the Telegram bot as optional and the other three as required', () => {
    const fn = app.slice(app.indexOf('function cbSetupStepList('), app.indexOf('function cbRenderSetup('))
    expect((fn.match(/optional: false/g) ?? []).length).toBe(3)
    expect((fn.match(/optional: true/g) ?? []).length).toBe(1)
    // A kotelezo harom pont a hid harom eloofeltetele.
    expect(fn).toContain('h.enabled')
    expect(fn).toContain('h.workerOnline')
    expect(fn).toContain('h.sessions')
  })

  it('disappears once the required steps are done', () => {
    // Egy mukodo hidon az allando teendo-lista mar csak zaj.
    const fn = app.slice(app.indexOf('function cbRenderSetup('), app.indexOf('function cbRenderSetup(') + 1200)
    expect(fn).toContain('doneCount === required.length')
    expect(fn).toContain('card.hidden = true')
  })

  it('is refreshed from the same health payload as the status box', () => {
    expect(app).toContain('cbRenderSetup(h)')
    const health = app.indexOf('function cbRenderHealth(')
    const call = app.indexOf('cbRenderSetup(h)', health)
    expect(call).toBeGreaterThan(health)
  })
})

describe('a telepito parancs a SAJAT telepitesre ervenyes', () => {
  it('only ever returns one of the three host kinds', () => {
    expect(['wsl', 'windows', 'unix']).toContain(detectHostKind())
  })

  it('recognises WSL from the env markers', () => {
    if (process.platform !== 'linux') return
    const prev = process.env['WSL_DISTRO_NAME']
    process.env['WSL_DISTRO_NAME'] = 'Ubuntu'
    try {
      expect(detectHostKind()).toBe('wsl')
    } finally {
      if (prev === undefined) delete process.env['WSL_DISTRO_NAME']
      else process.env['WSL_DISTRO_NAME'] = prev
    }
  })

  it('offers NO token path when the worker is on another machine', () => {
    // Ez volt a hiba: a valasz feltetel nelkul \\wsl.localhost\... utat epitett,
    // ami pontosan egy topologian igaz. Nativ Windowson maskepp nez ki, egy
    // kulon Linux-gepen pedig egyaltalan nincs ilyen ut -- ott a null a helyes
    // valasz, mert abbol tudja a lap, hogy a -Token format kell kiirnia.
    expect(route).toContain('const hostKind = detectHostKind()')
    expect(route).toContain(`hostKind === 'wsl' ?`)
    expect(route).toContain(`: hostKind === 'windows' ?`)
    expect(route).toContain('      : null')
  })

  it('always reports the token file as THIS machine sees it', () => {
    expect(route).toContain('tokenFile: `${PROJECT_ROOT}/store/.dashboard-token`')
    expect(route).toContain('hostKind,')
  })

  it('switches the install command between -TokenPath and -Token', () => {
    const idx = app.indexOf('const authArg = hint.tokenPath')
    expect(idx).toBeGreaterThan(-1)
    const block = app.slice(idx, idx + 400)
    expect(block).toContain("'-TokenPath \"'")
    expect(block).toContain('-Token "<IDE-MASOLD-A-TOKENT>"')
  })

  it('stops claiming Marveen runs in WSL regardless of the install', () => {
    // A "Marveen a WSL-ben fut" mondat egyetlen telepitesi modra igaz. Most a
    // hostKind donti el, mit ir ki -- a HTML-ben mar nem allhat beegetve.
    expect(html).toContain('id="cbWorkerIntro"')
    expect(html).not.toContain('A Marveen a WSL-ben fut és <strong>nem</strong> éri el')
    expect(app).toContain(`hint.hostKind === 'wsl'`)
    expect(app).toContain(`hint.hostKind === 'windows'`)
  })
})

// ---------------------------------------------------------------------------
// A seed-skillek sablon-helyettesitese
// ---------------------------------------------------------------------------

describe('a seed-skillek minden helyorzoje behelyettesitodik telepiteskor', () => {
  const linux = readFileSync(join(ROOT, 'install-linux.sh'), 'utf8')
  const macos = readFileSync(join(ROOT, 'install-macos.sh'), 'utf8')

  function placeholdersIn(dir: string): Set<string> {
    const found = new Set<string>()
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry)
        if (statSync(p).isDirectory()) { walk(p); continue }
        for (const m of readFileSync(p, 'utf8').matchAll(/\{\{([A-Z_]+)\}\}/g)) found.add(m[1] as string)
      }
    }
    walk(dir)
    return found
  }

  it('every {{PLACEHOLDER}} a seed skill uses is substituted by BOTH installers', () => {
    // Merve 2026-08-22: a {{PROJECT_ROOT}} egyik telepitoben sem szerepelt,
    // pedig a code-dispatch skill ket curl-parancsa arra epul. Egy friss
    // telepitesen tehat minden ugynok szo szerinti
    // "{{PROJECT_ROOT}}/store/.dashboard-token"-t adott volna a curl-nek --
    // vagyis a kod-hid atadas sehol nem mukodott volna, csendben.
    for (const name of placeholdersIn(join(ROOT, 'seed-skills'))) {
      // A sed hol `|`, hol `/` hataroloval van irva -- mindketto szamit.
      const inLinux = linux.includes(`{{${name}}}|`) || linux.includes(`{{${name}}}/`)
      const inMacos = macos.includes(`{{${name}}}|`) || macos.includes(`{{${name}}}/`)
      expect(inLinux, `install-linux.sh nem helyettesiti: {{${name}}}`).toBe(true)
      expect(inMacos, `install-macos.sh nem helyettesiti: {{${name}}}`).toBe(true)
    }
  })
})

describe('a kod-atadas nem a fo ugynok kivaltsaga', () => {
  const skill = readFileSync(join(ROOT, 'seed-skills/code-dispatch/SKILL.md'), 'utf8')

  it('says any agent may hand a coding task to the VS Code session', () => {
    // Boss, 2026-08-22: "a marvin ugynokei hasznaljak a vscode ugynokot!"
    // A keszseg a kozos keszsegtarban van, tehat minden ugynok latja -- de a
    // szovege a fo ugynokhoz beszelt, ami elbizonytalanitja a tobbit.
    expect(skill).toContain('bármelyik ügynök')
    expect(skill).not.toContain('**Te (a fő agent)')
  })

  it('makes the caller put its OWN name in requestedBy', () => {
    expect(skill).toContain('A `requestedBy` a SAJÁT ügynök-neved')
    // A beegetett "main-agent" minden telepitesen hazudott volna a naplonak.
    expect(skill).not.toContain('"requestedBy":"main-agent"')
    expect(skill).toContain('"requestedBy":"{{MAIN_AGENT_ID}}"')
  })
})


// ---------------------------------------------------------------------------
// A KOD-HID A KARTYA ALATT LAKIK
// Boss, 2026-08-22: "miert kivetelezunk vele? mindenki alapbol is ott keresne
// nem? ha mar a tobbinel is ott van." Minden mas ugynok beallitasa a sajat
// kartyajarol nyilik; a hid egy kulon bal-menupont volt, vagyis pont ott NEM,
// ahol keresik. Az egesz tartalom atkerult egy ablakba -- es egy ekkora
// athelyezes nemaan tud elromlani: a JS getElementById-jai null-t kapnak, a
// felulet ugy nez ki, mintha betoltott volna, csak semmi nem tortenik.
// ---------------------------------------------------------------------------
describe('a kod-hid a VS Code kartya alatt nyilik', () => {
  it('has no left-menu entry of its own any more', () => {
    expect(html).not.toContain('data-page="codeBridge"')
    expect(html).not.toContain('codeBridgeNavBadge')
    // A regi lap-konteneri sem maradhat ott: ket peldany ugyanabbol az
    // id-bol azt jelentene, hogy a getElementById a HALOTT-at talalja meg.
    expect(html).not.toContain('id="codeBridgePage"')
  })

  it('every cb* element the script reaches for exists in the window', () => {
    // Ez a teszt fogja meg, ha az athelyezes egy dobozt kint felejtett.
    const ids = new Set<string>()
    const re = /getElementById\('(cb[A-Za-z0-9_]*)'\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(app)) !== null) ids.add(m[1]!)
    expect(ids.size).toBeGreaterThan(10)
    // Nehany dobozt maga az app.js gyart futas kozben (a feladat-reszletek
    // ablaka) -- azoknak helyesen nincs nyomuk a HTML-ben.
    const madeByScript = (id: string) => app.includes(`id="${id}"`) || app.includes(`.id = '${id}'`)
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !madeByScript(id))
    expect(missing, 'ezekre hivatkozik az app.js, de nincsenek a lapon').toEqual([])
  })

  it('the window opens from the card and closes cleanly', () => {
    expect(app).toContain('function openCodeBridgeModal()')
    expect(app).toContain("card.addEventListener('click', () => openCodeBridgeModal())")
    // Bezaraskor le kell allnia az 5 masodperces kornek: lapnal ezt a
    // switchPage vegezte, ablaknal nincs mas, aki megtenne.
    expect(app).toContain('const close = () => { closeModal(overlay); _cbStopPoll() }')
  })

  it('the Attekintes self-check rows open the window, not a dead page', () => {
    // Ezek a sorok onclick-STRINGKENT kerulnek a lapra, tehat a nevnek
    // globalisnak kell lennie -- egy top-level function deklaracio az.
    expect(app).toContain('"openCodeBridgeModal()"')
    expect(app).not.toContain('"switchPage(\'codeBridge\')"')
  })
})
