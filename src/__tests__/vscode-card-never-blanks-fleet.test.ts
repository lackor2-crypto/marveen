// Kanban #235 (Boss, 2026-09-06): a VS Code (kod-hid) csapattag-kartya
// renderelese SOHA nem tuntetheti el a tobbi ugynok-kartyat.
//
// A #44 (kanban #213) elhasalt VS Code-kartyaja emiatt tuntette el az EGESZ
// listat -- csak Marvin latszott ("kizarolag csak a marvin agent latszik az
// ugynokok alatt! az osszes tobbi eltunt!"), mert a dobott hiba a Marvin-kartya
// beszurasa UTAN, de a tobbi-agens ciklus ELE esett (renderCodeBridgeAgentCards
// hivas), es magaval vitte a teljes render maradekat. A #46 emiatt vissza is
// vonta a #44-et.
//
// Ez a teszt forras-szinten kikenyszeriti a szerkezeti izolaciot: a
// csapattag-kartyak (kod-hid + federalt) renderelese try/catch-ben all a
// renderAgents fuggvenyen belul, tehat egy dobott hiba csak a sajat kartyajat
// viszi, a mar kirakott flotta-listat nem. jsdom nincs a projektben, ezert ez
// a repo bevett forras-kontraktus tesztjeinek mintajat koveti (a tobbi
// app.js-teszt is igy ellenoriz).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

// A renderAgents fuggveny torzse: a 'function renderAgents()' es a KOVETKEZO
// top-level 'function ' kozotti resz.
function renderAgentsBody(): string {
  const start = app.indexOf('function renderAgents()')
  expect(start, 'renderAgents fuggveny letezik').toBeGreaterThan(-1)
  const nextFn = app.indexOf('\nfunction ', start + 1)
  expect(nextFn, 'renderAgents lezarodik egy kovetkezo fuggvennyel').toBeGreaterThan(start)
  return app.slice(start, nextFn)
}

describe('#235 -- a VS Code/kod-hid kartya nem tuntetheti el a flotta-listat', () => {
  it('renderAgents a kod-hid kartya rendereleset try/catch-ben hivja', () => {
    const body = renderAgentsBody()
    // A hivas + egy catch UGYANABBAN a torzsben, es a hivas a catch ELE esik
    // (tehat tenylegesen a try-ban van).
    const call = body.indexOf('renderCodeBridgeAgentCards(agentsGrid, addBtn)')
    expect(call, 'renderCodeBridgeAgentCards-hivas a renderAgents-ben').toBeGreaterThan(-1)
    // A hivast megelozo legkozelebbi 'try' es az azt koveto 'catch' fogja kozre.
    const tryBefore = body.lastIndexOf('try', call)
    const catchAfter = body.indexOf('catch', call)
    expect(tryBefore, 'a hivas elott try nyilik').toBeGreaterThan(-1)
    expect(catchAfter, 'a hivas utan catch zar').toBeGreaterThan(call)
  })

  it('renderAgents a federalt kartyak rendereleset is try/catch-ben hivja', () => {
    const body = renderAgentsBody()
    const call = body.indexOf('renderFederatedAgentCards(agentsGrid, addBtn)')
    expect(call, 'renderFederatedAgentCards-hivas a renderAgents-ben').toBeGreaterThan(-1)
    const tryBefore = body.lastIndexOf('try', call)
    const catchAfter = body.indexOf('catch', call)
    expect(tryBefore, 'a hivas elott try nyilik').toBeGreaterThan(-1)
    expect(catchAfter, 'a hivas utan catch zar').toBeGreaterThan(call)
  })

  it('a kod-hid kartya "beallitas" gombjanak esemenykotese null-biztos (?.)', () => {
    // Az innerHTML sablon barmiert nem all elo -> a puszta
    // `.querySelector(...).addEventListener` null-on dobna, ami epp a rendert
    // akasztana meg. Optional chaining kotelezo.
    expect(
      app.includes(".querySelector('.code-bridge-open-btn')?.addEventListener"),
      "a .code-bridge-open-btn esemenykotese ?.-tal",
    ).toBe(true)
    // Es NE maradjon ott a regi, vedtelen valtozat.
    expect(
      app.includes(".querySelector('.code-bridge-open-btn').addEventListener"),
      'ne maradjon vedtelen .code-bridge-open-btn addEventListener',
    ).toBe(false)
  })
})
