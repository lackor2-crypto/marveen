// #462: the Simple view's editor/live view switch. The live view shows only the finished
// picture (no boxes, no selection handles, no drag layer) -- what the export looks like.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

const js = readFileSync(join(PROJECT_ROOT, 'web', 'workbench.js'), 'utf-8')

describe('Simple view: live view switch', () => {
  it('the toolbar has the switch, wired to WB.frLive', () => {
    expect(js).toContain('data-wb-act="fr-live"')
    expect(js).toContain("a === 'fr-live'")
    expect(js).toContain('frLive: false')
  })

  it('the live stage is only the picture: no layer, no data-wb-stage drag hook', () => {
    const i = js.indexOf('if (bare && WB.frLive) return')
    expect(i).toBeGreaterThan(0)
    const line = js.slice(i, js.indexOf('\n', i))
    expect(line).toContain('wb-can-stage-live')
    expect(line).not.toContain('wb-can-layer')
    expect(line).not.toContain('data-wb-stage')
  })

  it('both languages carry the labels', () => {
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      for (const k of ['live_off', 'live_on', 'live_title']) expect(l).toContain(`"workbench.fr.${k}"`)
    }
  })
})

describe('project list: only names, actions in the right-click menu (TG 2164)', () => {
  it('a folder row carries no pencil / bin, and has its own right-click menu', () => {
    expect(js).not.toContain('wb-folder-ctl')
    expect(js).toContain('data-wb-ctx-folder')
    expect(js).toContain('function folderMenuHtml')
    expect(js).toContain("e.target.closest('[data-wb-ctx-folder]')")
  })
})

describe('project list: the fixed Favorites folder (TG 2173)', () => {
  it('is rendered first, collects the starred items, and the star no longer pins inside a folder', () => {
    expect(js).toContain("var FAV_KEY = '*favorites*'")
    expect(js).toContain("t('workbench.fav.title')")
    expect(js).toContain('byPlace[k].sort(')
    for (const lang of ['hu', 'en']) {
      const l = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf-8')
      expect(l).toContain('"workbench.fav.title"')
      expect(l).toContain('"workbench.fav.empty"')
    }
  })
})
