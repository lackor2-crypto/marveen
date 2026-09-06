// Kártya #67 (dec7b061): WordPress child-theme-szerű felülíró réteg a web/
// alá -- egy fork saját CSS/JS-e a (gitignore-olt) web/custom.css és
// web/custom.js fájlba kerül, hogy a tracked app.js/style.css sose módosuljon
// és upstream pull-nál nulla legyen az ütközés. A kutatási döntés (kártya
// kommentek 110/113): szerveroldali injekció a serveIndexHtml pipeline-jában
// (Opció A), monkey-patch JS-minta (A1), .gitignore-olt fájlnevek.
//
// A teszt egy IZOLÁLT ideiglenes web-könyvtárral dolgozik (nem a valódi web/
// mappával), hogy a "fájl nincs jelen" és a "fájl jelen van" ágat egyaránt
// determinisztikusan tudja próbálni -- fresh installon SOSE létezik
// custom.css/js, tehát az első eset a valódi alapállapot.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectCustomOverrides } from '../web/routes/static.js'

describe('injectCustomOverrides: fork-friendly web/ felülíró réteg', () => {
  let webDir: string
  const html = '<html><head><title>x</title></head><body><p>hi</p></body></html>'

  beforeAll(() => {
    webDir = mkdtempSync(join(tmpdir(), 'marveen-custom-override-'))
  })
  afterAll(() => {
    rmSync(webDir, { recursive: true, force: true })
  })

  it('fresh install (nincs custom.css/js): a HTML BYTE-FOR-BYTE változatlan', () => {
    expect(injectCustomOverrides(html, webDir)).toBe(html)
  })

  it('csak custom.css jelenlétekor <link> kerül a </head> elé, <script> nem', () => {
    writeFileSync(join(webDir, 'custom.css'), 'body{color:red}')
    const out = injectCustomOverrides(html, webDir)
    expect(out).toContain('<link rel="stylesheet" href="/custom.css?v=')
    expect(out).not.toContain('/custom.js')
    // A </head> elé kerül, nem a </body> elé.
    expect(out.indexOf('/custom.css')).toBeLessThan(out.indexOf('</head>'))
    rmSync(join(webDir, 'custom.css'))
  })

  it('custom.js jelenlétekor <script> kerül a </body> ELÉ (app.js UTÁN fut)', () => {
    writeFileSync(join(webDir, 'custom.js'), 'console.log(1)')
    const out = injectCustomOverrides(html, webDir)
    expect(out).toContain('<script src="/custom.js?v=')
    expect(out.indexOf('/custom.js')).toBeLessThan(out.indexOf('</body>'))
    expect(out.indexOf('<p>hi</p>')).toBeLessThan(out.indexOf('/custom.js'))
    rmSync(join(webDir, 'custom.js'))
  })

  it('mindkettő jelenlétekor mindkét tag bekerül, a fájl tartalma nem íródik a HTML-be', () => {
    writeFileSync(join(webDir, 'custom.css'), 'body{color:red}')
    writeFileSync(join(webDir, 'custom.js'), 'console.log(1)')
    const out = injectCustomOverrides(html, webDir)
    expect(out).toContain('/custom.css?v=')
    expect(out).toContain('/custom.js?v=')
    expect(out).not.toContain('color:red')
    expect(out).not.toContain('console.log')
    rmSync(join(webDir, 'custom.css'))
    rmSync(join(webDir, 'custom.js'))
  })

  it('a verzió-token a fájl mtime+size alapján változik (cache-busting)', () => {
    writeFileSync(join(webDir, 'custom.css'), 'a')
    const v1 = injectCustomOverrides(html, webDir).match(/custom\.css\?v=([^"]+)"/)?.[1]
    writeFileSync(join(webDir, 'custom.css'), 'ab')
    const v2 = injectCustomOverrides(html, webDir).match(/custom\.css\?v=([^"]+)"/)?.[1]
    expect(v1).toBeTruthy()
    expect(v2).toBeTruthy()
    expect(v1).not.toBe(v2)
    rmSync(join(webDir, 'custom.css'))
  })
})
