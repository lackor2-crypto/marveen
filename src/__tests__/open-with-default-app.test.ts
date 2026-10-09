// #529 -- a document opens in the machine's own program, the way a double click does.
//
// Owner, 2026-10-10: "marveen intezo miert nem tud megnyitni excelt? csinald meg hogy tudja
// megnyitni az excelt. mint a windows intezo" and "innen is nyiljon meg! excel, docx, minden."
//
// "Open with the default program" RUNS the file when it is a program or a script. So the
// first thing pinned here is what is NEVER opened this way.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openableWithDefaultApp, openFileScript, openWithDefaultApp } from '../open-in-file-manager.js'

describe('what is handed to the machine\'s own program', () => {
  it('documents, tables, slides, pictures, sound and video are', () => {
    for (const n of ['a.xlsx', 'B.XLSX', 'c.docx', 'd.doc', 'e.odt', 'f.pptx', 'g.pdf', 'h.csv', 'i.txt', 'j.jpg', 'k.png', 'l.mp4', 'm.mp3', 'Költség 2026.xlsm']) {
      expect(openableWithDefaultApp(n), n).toBe(true)
    }
  })

  it('anything that would RUN is not -- nor a file without a known extension', () => {
    for (const n of ['a.exe', 'b.bat', 'c.cmd', 'd.ps1', 'e.vbs', 'f.js', 'g.lnk', 'h.msi', 'i.scr', 'j.com', 'k.hta', 'l.jar', 'm.reg', 'n.url', 'o.html', 'p.svg', 'q.zip', 'szamla.pdf.exe', 'nev', '.xlsx.bat', '']) {
      expect(openableWithDefaultApp(n), n).toBe(false)
    }
  })

  it('the Windows line opens the file itself, and a quote in the name cannot break out of it', () => {
    expect(openFileScript('F:\\Marveen\\Család\\Költség.xlsx')).toContain("Start-Process -FilePath 'F:\\Marveen\\Család\\Költség.xlsx'")
    expect(openFileScript("F:\\a'; Remove-Item C:\\ -Recurse; '.xlsx")).toContain("Start-Process -FilePath 'F:\\a''; Remove-Item C:\\ -Recurse; ''.xlsx'")
  })
})

describe('refusals happen before anything is started', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-default-'))
  it('a missing file, a folder and a non-document are each said', async () => {
    mkdirSync(join(dir, 'mappa'))
    writeFileSync(join(dir, 'prog.bat'), 'echo')
    expect(await openWithDefaultApp(join(dir, 'nincs.xlsx'))).toEqual({ ok: false, code: 'not_found' })
    expect(await openWithDefaultApp(join(dir, 'mappa'))).toEqual({ ok: false, code: 'not_a_file' })
    expect(await openWithDefaultApp(join(dir, 'prog.bat'))).toEqual({ ok: false, code: 'not_openable' })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the page', () => {
  const root = join(import.meta.dirname, '..', '..')
  const app = readFileSync(join(root, 'web/app.js'), 'utf-8')
  const wb = readFileSync(join(root, 'web/workbench.js'), 'utf-8')
  const route = readFileSync(join(root, 'src/web/routes/life.ts'), 'utf-8')

  it('opens on the machine only when the browser IS on the machine', () => {
    const fn = app.slice(app.indexOf('function _openOnMachineHere()'), app.indexOf('async function _openOnMachine('))
    expect(fn).toContain("h === 'localhost'")
    expect(fn).toContain("h === '127.0.0.1'")
    expect(app).toContain('if (_openOnMachineHere()) {')
    expect(wb).toMatch(/!WB_OPEN_LOCAL\.test\(rel\) \|\| typeof window\._openOnMachine !== 'function' \|\| !window\._openOnMachineHere\(\)/)
  })

  it('the download stays as the second way, and a failure falls back to it in the file list', () => {
    expect(app).toContain("dl.textContent = t('intezo.open_local_download')")
    expect(wb).toContain("window.open(a.getAttribute('href'), '_blank', 'noopener')")
  })

  it('the endpoint goes through the Life-tree boundary and the allowlist, with a sentence for each refusal', () => {
    const post = route.slice(route.indexOf("if (path === '/api/life/open-file' && method === 'POST')"), route.indexOf('// A FAJL TARTALMANAK kiszolgalasa'))
    expect(post.indexOf('resolveLifePath(rel)')).toBeGreaterThan(0)
    expect(post.indexOf('resolveLifePath(rel)')).toBeLessThan(post.indexOf('openWithDefaultApp(abs)'))
    for (const code of ['not_found', 'not_a_file', 'not_openable', 'no_file_manager', 'open_failed']) expect(post).toContain(`${code}: [`)
  })
})
