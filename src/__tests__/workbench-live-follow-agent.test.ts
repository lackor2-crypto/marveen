// Owner, 2026-11-07: "if the assistant says it corrected something, the screen must show it at once, without F5" and "the left
// folder tree also needs a refresh to show a change". (1) The folder tree follows the disk also while the assistant works and
// while the cursor stands in the document page: then only the tree panel is replaced. (2) The translation column follows
// the language version when the assistant's turn ends and every few seconds while it works. (3) "Save translation" never
// writes an older page over a newer saved text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const between = (a: string, b: string) => js.slice(js.indexOf(a), js.indexOf(b, js.indexOf(a)))

describe('the Workbench follows the assistant without F5', () => {
  it('the folder tree is asked for also while the assistant works and while the cursor is in the page, drawing only the tree panel', () => {
    const mode = between('function treeMode()', 'function treeAutoRefresh')
    expect(mode).toContain("if (WB.chatStreaming || (a && a.isContentEditable)) return 'swap'")
    // a typed field (not the chat box) still stops it, and so do a running file action and a hidden tab
    expect(mode).toContain("/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)")
    expect(mode).toContain("document.visibilityState === 'hidden'")
    expect(mode).toContain('WB.fileBusy')
    const swap = between('function treeSwapOnly()', '// The tree follows the disk by itself')
    expect(swap).toContain("document.querySelector('.wb-panel-items')")
    expect(swap).toContain('host.replaceChild(fresh, cur)')
    // the scroll position of the tree is kept
    expect(swap).toContain('scrollTop')
    // the refresh in swap mode never calls the full redraw
    const rt = between('function refreshTree(quiet, swap)', 'function treeSwapOnly()')
    expect(rt).toContain('if (swap) { treeSwapOnly(); return }')
    expect(rt.indexOf('if (swap)')).toBeLessThan(rt.indexOf('render()'))
  })

  it('the lists are asked for every 10 s, and every 4 s while the assistant works (with the translation column)', () => {
    expect(js).toContain('var TREE_POLL_MS = 10000')
    expect(js).toContain('var TREE_POLL_BUSY_MS = 12000')
    expect(js).toMatch(/setInterval\(function \(\) \{ if \(WB\.chatStreaming\) \{ treeAutoRefresh\(TREE_POLL_BUSY_MS - 500\); twResync\(\) \} \}, TREE_POLL_BUSY_MS\)/)
  })

  it('the translation column is re-read the moment the assistant turn ends', () => {
    const fin = between('function finishChatTurn(turn)', 'A KULDOTT SZOVEG NEM JON VISSZA')
    expect(fin).toContain('refreshSelectedAfterTurn()')
    expect(fin.indexOf('twResync()')).toBeGreaterThan(fin.indexOf('refreshSelectedAfterTurn()'))
  })

  it('"Save translation" reads the saved text first and never overwrites a newer one silently', () => {
    const save = between('function twSave(auto)', 'function twSavePost(')
    expect(save).toContain("'/outline/translation?to='")
    // unchanged page + changed server: the newer server text is taken, nothing is written for that section
    expect(save).toContain('if (pageSig === base) { take(s); taken++; return }')
    // page edited AND server changed: the owner is asked, the default (Cancel) keeps the newer saved text
    expect(save).toContain("window.confirm(t('workbench.tw.conflict_confirm'")
    expect(save).toContain('else conflicts.forEach(function (c) { take(c.s); taken++ })')
    // when every section was taken from the server there is no write at all
    expect(save).toContain('if (!keep.length) {')
    expect(save.indexOf('if (!keep.length) {')).toBeLessThan(save.indexOf('twSavePost(id, lang, keep, auto)'))
    const post = between('function twSavePost(', '// ---- the translation page: Enter / paste')
    expect(post).toContain("'/outline/translation-save'")
  })

  it('the new texts exist in Hungarian and English', () => {
    for (const lang of ['hu', 'en']) {
      const dict = readFileSync(join(__dirname, '..', '..', 'web', 'lang', lang + '.js'), 'utf8')
      for (const k of ['workbench.tw.conflict_confirm', 'workbench.tw.newer_taken']) expect(dict).toContain('"' + k + '"')
    }
  })
})
