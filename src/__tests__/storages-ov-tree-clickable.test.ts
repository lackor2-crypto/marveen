// #715: the Storages / "what is up per account" folder tree is clickable. A folder
// inside a marked folder gets a toggle button; once opened, its real sub-folders
// and files (loaded from /api/life/list) are listed, and what the account leaves
// out is greyed. This runs the pure `_storagesOvTree` from web/app.js in a sandbox,
// extracted the same way as the other web/app.js tests.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

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

type Entry = { path: string; exclude?: string[] }
type Dir = { folders?: string[]; files?: string[]; loading?: boolean; error?: string; truncated?: boolean }

function makeTree(open: Record<string, boolean>, dirs: Record<string, Dir>) {
  return new Function(
    't', 'escapeHtml', 'open', 'dirs',
    `var _storagesOvOpen = open
     var _storagesOvDirs = dirs
     ${extractFn(app, '_storagesOvTree')}
     return _storagesOvTree`,
  )(
    (k: string) => `«${k}»`,
    (v: string) => String(v),
    open,
    dirs,
  ) as (entries: Entry[], sizes: Record<string, unknown>, accKey: string) => string
}

describe('#715 clickable per-account folder tree', () => {
  const entries: Entry[] = [{ path: 'Cégek/Freeberischeaper', exclude: ['Tmp', '.log'] }]

  it('a marked folder gets a closed toggle button, nothing is listed before it is opened', () => {
    const html = makeTree({}, {})(entries, {}, 'drive|a')
    expect(html).toContain('data-stor-ov="toggle"')
    expect(html).toContain('data-path="Cégek/Freeberischeaper"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('📄')
  })

  it('a folder above the marked one is not clickable (only the covered part opens)', () => {
    const html = makeTree({}, {})(entries, {}, 'drive|a')
    expect(html).not.toContain('data-path="Cégek"')
  })

  it('an opened marked folder shows a loading note, then its real folders and files', () => {
    const key = 'drive|a|Cégek/Freeberischeaper'
    const loading = makeTree({ [key]: true }, { 'Cégek/Freeberischeaper': { loading: true } })(entries, {}, 'drive|a')
    expect(loading).toContain('«storages.ov_loading»')

    const loaded = makeTree({ [key]: true }, {
      'Cégek/Freeberischeaper': { folders: ['Szerződések'], files: ['terv.docx'] },
    })(entries, {}, 'drive|a')
    expect(loaded).toContain('aria-expanded="true"')
    expect(loaded).toContain('data-path="Cégek/Freeberischeaper/Szerződések"')
    expect(loaded).toContain('📄 terv.docx')
  })

  it('a left-out sub-folder and a left-out file type are greyed, not clickable', () => {
    const key = 'drive|a|Cégek/Freeberischeaper'
    const html = makeTree({ [key]: true }, {
      'Cégek/Freeberischeaper': { folders: ['Tmp', 'Jó'], files: ['gep.log', 'ok.txt'] },
    })(entries, {}, 'drive|a')
    expect(html).toContain('stor-ov-off')
    expect(html).not.toContain('data-path="Cégek/Freeberischeaper/Tmp"')
    expect(html).toContain('data-path="Cégek/Freeberischeaper/Jó"')
    expect(html).toMatch(/stor-ov-file stor-ov-off"><span>📄 gep\.log/)
    expect(html).toMatch(/stor-ov-file"><span>📄 ok\.txt/)
  })

  it('an empty opened folder says so; a failed load shows the error', () => {
    const key = 'drive|a|Cégek/Freeberischeaper'
    const empty = makeTree({ [key]: true }, { 'Cégek/Freeberischeaper': { folders: [], files: [] } })(entries, {}, 'drive|a')
    expect(empty).toContain('«storages.ov_empty»')
    const failed = makeTree({ [key]: true }, { 'Cégek/Freeberischeaper': { error: 'boom' } })(entries, {}, 'drive|a')
    expect(failed).toContain('«storages.ov_failed»')
  })

  it('a truncated listing is flagged', () => {
    const key = 'drive|a|Cégek/Freeberischeaper'
    const html = makeTree({ [key]: true }, {
      'Cégek/Freeberischeaper': { folders: [], files: ['a.txt'], truncated: true },
    })(entries, {}, 'drive|a')
    expect(html).toContain('«storages.ov_list_truncated»')
  })
})
