// Card references (#<id> / "Kartya <id>" / a bare id) must be clickable
// EVERYWHERE a card id appears as text -- Boss, card 7ab36f1b: "nehol
// kattinthatok, nehol nem -- kaotikus".
//
// The reason the first attempt did not fix it: the linkifier only matched
// '#<8hex>', while agents overwhelmingly write the id without a '#'. Measured
// on the live approvals list on 2026-08-10: 8 of 9 references had no '#'. So
// the pattern now also links a bare 8-hex token when it is a REAL card id,
// which is what /api/kanban/card-ids is for.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const KANBAN_ROUTE = readFileSync(join(__dirname, '../web/routes/kanban.ts'), 'utf-8')
const DB = readFileSync(join(__dirname, '../db.ts'), 'utf-8')

// The production regex, lifted verbatim from web/app.js so the test breaks if
// it drifts (the file is plain JS served to the browser, not importable here).
const RE_SRC = APP.match(/^const KANBAN_REF_RE = (\/.*\/[a-z]*)$/m)?.[1]

function linkify(text: string, known: Set<string>): string {
  const re = new RegExp(RE_SRC!.slice(1, RE_SRC!.lastIndexOf('/')), 'gi')
  return text.replace(re, (match, marker, id) => {
    if (!marker && !known.has(id.toLowerCase())) return match
    return `${marker || ''}[LINK:${id.toLowerCase()}]`
  })
}

describe('kanban reference linkifier', () => {
  const known = new Set(['16911a38', 'b380afac'])

  it('links the marked forms, with or without a known id', () => {
    expect(linkify('lásd #d396cc16 részleteket', new Set())).toContain('[LINK:d396cc16]')
    expect(linkify('Kartya 17c32538: email', new Set())).toContain('[LINK:17c32538]')
    expect(linkify('Kártya 17c32538 kész', new Set())).toContain('[LINK:17c32538]')
    expect(linkify('kanban b380afac javitva', new Set())).toContain('[LINK:b380afac]')
  })

  it('links a BARE id when it is a real card -- the form agents actually write', () => {
    expect(linkify('16911a38 kesz', known)).toBe('[LINK:16911a38] kesz')
  })

  it('leaves hex that is not a card alone', () => {
    // A commit sha, a colour, any other hex blob: no marker, not a card id.
    expect(linkify('commit deadbeef landed', known)).toBe('commit deadbeef landed')
    expect(linkify('szin #a1b2c3d4 volt', new Set())).toContain('[LINK:a1b2c3d4]') // marked -> linked
    expect(linkify('szin a1b2c3d4 volt', known)).toBe('szin a1b2c3d4 volt')
  })

  it('does not match a fragment of a longer hex string', () => {
    const sha = 'ddd7bca144de30cd8291a71e4b6a70dc169fc727'
    expect(linkify(`commit ${sha}`, known)).toBe(`commit ${sha}`)
  })

  it('the id set comes from a dedicated ids-only endpoint', () => {
    expect(KANBAN_ROUTE).toContain("path === '/api/kanban/card-ids'")
    expect(KANBAN_ROUTE).toContain("SELECT id FROM kanban_cards")
    expect(APP).toContain("fetch('/api/kanban/card-ids')")
    // Board loads keep it fresh without another request.
    expect(APP).toContain('for (const c of kanbanCards) kanbanKnownIds.add(c.id)')
  })
})

describe('where references are rendered', () => {
  const surfaces: Array<[string, string]> = [
    ['overview activity feed', '<div class="overview-activity-title">${linkifyKanbanRefs(a.text)}</div>'],
    ['messages bubbles', '<div class="bubble-text">${linkifyKanbanRefs(m.content || \'\')}</div>'],
    ['daily log entries', '<div class="log-entry-content">${linkifyKanbanRefs(entry.content)}</div>'],
    ['memory list', '<div class="mem-content-full">${linkifyKanbanRefs(mem.content)}</div>'],
    ['memory graph panel', '<div class="graph-panel-content">${linkifyKanbanRefs(node.mem.content)}</div>'],
    ['naplo diary entries', 'linkifyKanbanRefs(rawContent.slice(0, 200))'],
    ['idea detail', "linkifyKanbanRefs(idea.description || t('ideas.no_description'))"],
  ]
  for (const [name, snippet] of surfaces) {
    it(`${name} renders references as links`, () => {
      expect(APP).toContain(snippet)
    })
  }
})

describe('following a reference', () => {
  it('falls back to the archive instead of dead-ending on an archived card', () => {
    expect(APP).toContain('if (await _openArchivedCardById(cardId)) return')
    expect(APP).toContain('async function _openArchivedCardById(cardId)')
    // The archive search has to match on id for that lookup to find anything.
    expect(DB).toContain('OR kc.id LIKE ?')
  })

  it('a direct load of #naplo / #archived does not race their loaders', () => {
    // Both loaders are defined in IIFEs at the end of app.js, so a refresh on
    // those hashes reached switchPage before the definition existed and threw.
    expect(APP).toContain("callPageLoader('loadArchivedPage')")
    expect(APP).toContain("callPageLoader('loadNaplo')")
    expect(APP).toContain('function callPageLoader(name)')
  })
})
