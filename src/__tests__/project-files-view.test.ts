// #359 (Boss 1249): "lehessen valasztani, hogy maradjon igy omlesztve, ahogy
// most van, illetve helyezze ugy, hogy mapparendszerbe lassam". A Fajlok ful
// valodi kodjat futtatjuk (web/app.js-bol kivagva), nem a forrasszoveget nezzuk.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() not found in web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() is not brace-balanced`)
}

const FNS = ['_prjFilesView', '_prjSetFilesView', '_prjCurrentFilesView', '_prjLoadFlat', '_prjFlatHtml',
  '_prjFilesBodyHtml', '_prjTreeHtml', '_prjFileRowHtml', '_prjFileMeta', '_prjRefreshFilesTab', '_prjRefreshTree',
  '_prjFilesTabHtml']

type Env = {
  prj: any
  store: Record<string, string>
  calls: string[]
  tab: () => string
  setView: (v: string) => void
  flush: () => Promise<void>
}

function makeEnv(opts: { stored?: string; storageThrows?: boolean; flat?: { ok: boolean; data: any } } = {}): Env {
  const store: Record<string, string> = {}
  if (opts.stored) store.prjFilesView = opts.stored
  const localStorage = {
    getItem: (k: string) => { if (opts.storageThrows) throw new Error('blocked'); return k in store ? store[k] : null },
    setItem: (k: string, v: string) => { if (opts.storageThrows) throw new Error('blocked'); store[k] = v },
  }
  const calls: string[] = []
  const prj: any = {
    current: 'p1', tab: 'files', overview: { project: { id: 'p1', name: 'P', folder_path: 'Projektek/P' } },
    files: {
      pid: 'p1', state: 'ok', path: 'Projektek/P', err: null, open: new Set(), loading: new Set(),
      dirs: { '': { entries: [{ kind: 'dir', name: 'Szerzodes', sub: 'Szerzodes', children: 2, at: 1 }], truncated: false } },
    },
    fileFind: null,
  }
  const flatResp = opts.flat || { ok: true, data: { state: 'ok', path: 'Projektek/P', files: [
    { rel: 'Projektek/P/Szerzodes/alairt.pdf', name: 'alairt.pdf', at: 2 },
    { rel: 'Projektek/P/jegyzet.md', name: 'jegyzet.md', at: 1 },
  ] } }
  const _prjApi = async (_m: string, url: string) => { calls.push(url); return flatResp }
  const t = (k: string, p?: Record<string, unknown>) => `⟦${k}${p ? ':' + JSON.stringify(p) : ''}⟧`
  const document = { getElementById: () => null }
  const api = new Function('_prj', '_prjApi', 't', 'localStorage', 'document', 'escapeHtml', 'escapeAttr', '_prjAgo', '_depoBytes', '_prjT',
    `const _PRJ_FILES_VIEW_KEY = 'prjFilesView'\n${FNS.map((n) => extractFn(APP, n)).join('\n')}
     return { tab: _prjFilesTabHtml, setView: _prjSetFilesView }`)(
    prj, _prjApi, t, localStorage, document, (s: unknown) => String(s ?? ''), (s: unknown) => String(s ?? ''),
    (at: number) => 'ago' + at, (n: number) => n + 'B', (k: string) => k)
  return { prj, store, calls, tab: api.tab, setView: api.setView, flush: () => new Promise((r) => setTimeout(r, 0)) }
}

describe('Fajlok ful: omlesztett / mappas nezet valaszto (#359)', () => {
  let env: Env
  beforeEach(() => { env = makeEnv() })

  it('alapbol a mapparendszer latszik, es mindket nezet-gomb ott van', () => {
    const html = env.tab()
    expect(html).toContain('data-prj-files-view="tree"')
    expect(html).toContain('data-prj-files-view="flat"')
    expect(html).toMatch(/class="tab-btn active" data-prj-files-view="tree" aria-pressed="true"/)
    expect(html).toContain('data-prj-dir="Szerzodes"')
    expect(html).toContain('⟦projects.files.hint⟧')
  })

  it('omlesztettre valtva a /files lista jon: minden fajl, a mappajaval, legfrissebb elol', async () => {
    env.setView('flat')
    await env.flush()
    expect(env.calls).toEqual(['/api/projects/p1/files'])
    const html = env.tab()
    expect(html).toMatch(/class="tab-btn active" data-prj-files-view="flat"/)
    expect(html.indexOf('alairt.pdf')).toBeLessThan(html.indexOf('jegyzet.md'))
    // a fajl mappaja latszik, es kattintasra oda nyilik az Intezo
    expect(html).toContain('data-prj-reveal="Szerzodes"')
    expect(html).toContain('<span class="prj-tree-path">Szerzodes</span>')
    // a fo mappaban levo fajlnal a "fo mappa" felirat, ures reveal = a projekt mappaja
    expect(html).toContain('data-prj-reveal=""')
    expect(html).toContain('⟦projects.files.root_folder⟧')
    expect(html).not.toContain('data-prj-dir=')
    expect(html).toContain('⟦projects.files.hint_flat⟧')
    expect(env.store.prjFilesView).toBe('flat')
  })

  it('a valasztas megmarad: ujranyitaskor az omlesztett nezet toltodik', async () => {
    env = makeEnv({ stored: 'flat' })
    env.setView('flat')
    await env.flush()
    expect(env.tab()).toContain('alairt.pdf')
    env.setView('tree')
    expect(env.store.prjFilesView).toBe('tree')
    expect(env.tab()).toContain('data-prj-dir="Szerzodes"')
  })

  it('tiltott bongeszo-tar mellett is mukodik (csak nem jegyzi meg)', async () => {
    env = makeEnv({ storageThrows: true })
    expect(env.tab()).toContain('data-prj-dir="Szerzodes"')
    env.setView('flat')
    await env.flush()
    expect(env.tab()).toContain('alairt.pdf')
  })

  it('ures mappa: barátságos ures-allapot, nem hiba', async () => {
    env = makeEnv({ flat: { ok: true, data: { state: 'ok', files: [] } } })
    env.setView('flat')
    await env.flush()
    expect(env.tab()).toContain('⟦projects.files.empty⟧')
  })

  it('olvasasi hiba: a szerver emberi mondata latszik, nem gepi kod', async () => {
    env = makeEnv({ flat: { ok: false, data: { message: 'A Raktár most nem érhető el.' } } })
    env.setView('flat')
    await env.flush()
    const html = env.tab()
    expect(html).toContain('A Raktár most nem érhető el.')
    expect(html).toContain('depo-bad')
  })

  it('minden uj felirat HU es EN nyelven is megvan', () => {
    for (const k of ['view_label', 'view_tree', 'view_flat', 'hint_flat', 'flat_limit']) {
      expect(HU).toContain(`"projects.files.${k}"`)
      expect(EN).toContain(`"projects.files.${k}"`)
    }
  })
})
