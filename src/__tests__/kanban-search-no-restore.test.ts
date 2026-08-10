// Regression guard for a bug that survived two attempts at fixing it: the
// kanban card-search box came back with an old query in it (Boss saw his agent
// id "lackor2" sitting in the field after every reload, 2026-08-10). The cause
// is Chromium form-state restoration, which writes the previously typed value
// back into any control that exists in the PARSED document -- autocomplete="off"
// does not disable it, and clearing the value from script is a race (the restore
// pass can run after parse time, after rAF and after setTimeout(0)).
//
// The fix is structural: the input is built by app.js at runtime, so there is no
// parse-time control for the browser to restore into. These are string-contract
// assertions (the house idiom, see approvals-ui-contract.test.ts) because the
// property being guarded is "this input is not in the HTML", which no runtime
// test of the built page can express.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('kanban search box cannot be repopulated by the browser', () => {
  it('the search input is NOT parsed markup -- index.html only has the slot', () => {
    expect(HTML).toContain('id="kanbanSearchSlot"')
    // The whole point: no <input> for form-state restoration to target.
    expect(HTML).not.toContain('id="kanbanSearchInput"')
  })

  it('app.js creates the input into the slot', () => {
    expect(APP).toContain("document.getElementById('kanbanSearchSlot')")
    expect(APP).toContain("searchEl.id = 'kanbanSearchInput'")
    expect(APP).toMatch(/createElement\('input'\)/)
    expect(APP).toContain('slot.appendChild(searchEl)')
  })

  it('autofill opt-outs are set, so a password manager does not fill it either', () => {
    expect(APP).toContain("searchEl.autocomplete = 'off'")
    expect(APP).toContain("setAttribute('data-1p-ignore'")
    expect(APP).toContain("setAttribute('data-lpignore'")
    expect(APP).toContain("setAttribute('data-bwignore'")
  })

  it('the visible value is reconciled to the query state, incl. bfcache restore', () => {
    expect(APP).toContain('if (searchEl.value !== kanbanSearchQuery) searchEl.value = kanbanSearchQuery')
    expect(APP).toContain("window.addEventListener('pageshow', reconcile)")
    // Reconciling must never fight a user who is typing in the box.
    expect(APP).toContain('if (document.activeElement === searchEl) return')
  })

  it('blur flushes the debounce, so the reconciler never trails the typed text', () => {
    expect(APP).toMatch(/addEventListener\('blur', \(\) => \{ clearTimeout\(_searchTimer\); apply\(searchEl\.value\) \}\)/)
  })
})
