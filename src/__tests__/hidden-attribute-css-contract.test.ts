// Contract test for the recurring "[hidden] does nothing" CSS regression.
//
// An author rule like `.foo { display: flex }` outranks the UA stylesheet's
// `[hidden] { display: none }`, so any element that the frontend hides by
// setting `el.hidden = true` stays on screen unless the class also carries an
// explicit `[hidden] { display: none }` override. style.css already documents
// this for .kanban-board / .kanban-col / .page / .tab-panel / .wizard-panel;
// the auth setup banner shipped without it, so the banner was permanently
// visible and its close button looked dead (it did set el.hidden = true).
//
// House idiom: read the frontend files as strings and assert short,
// formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
// Strip comments so an explanatory comment mentioning a property is never
// mistaken for a real declaration.
const css = readFileSync(join(WEB, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const html = readFileSync(join(WEB, 'index.html'), 'utf8')

/** Does an unconditional `.cls { ... display: <not none> ... }` rule exist? */
function hasUnconditionalDisplay(cls: string): boolean {
  const re = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`, 'g')
  for (const m of css.matchAll(re)) {
    const decl = /(^|;)\s*display\s*:\s*([a-z-]+)/i.exec(m[1])
    if (decl && decl[2].toLowerCase() !== 'none') return true
  }
  return false
}

function hasHiddenOverride(cls: string): boolean {
  return new RegExp(`\\.${cls}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(css)
}

// Elements the markup ships with the `hidden` attribute AND styles by class.
// Extracted from index.html so a newly added hidden container is covered
// automatically instead of needing a new test.
function hiddenClassNames(): string[] {
  const out = new Set<string>()
  // `\bhidden\b` also matched `aria-hidden="true"`, which is a DIFFERENT
  // attribute: it hides an element from screen readers and says nothing about
  // `display`. A decorative `<span aria-hidden>` tripped this on 2026-09-02,
  // and "fixing" it would have meant a meaningless `[hidden]` rule for an
  // element that is never hidden that way. So the name must not be preceded
  // by `-` or a word character, and must end the attribute (`hidden`,
  // `hidden>`, `hidden/>` or `hidden=""`).
  for (const tag of html.matchAll(/<[a-z]+[^>]*(?<![-\w])hidden(?=[\s>/=])[^>]*>/gi)) {
    const cls = /class="([^"]+)"/.exec(tag[0])
    if (!cls) continue
    for (const c of cls[1].split(/\s+/)) if (c) out.add(c)
  }
  return [...out]
}

describe('[hidden] stays effective for class-styled containers', () => {
  it('the auth setup banner can actually be hidden', () => {
    // Regression: without this the dismiss button and initAuthBanner() both
    // set el.hidden = true with no visible effect.
    expect(hasUnconditionalDisplay('auth-setup-banner')).toBe(true)
    expect(hasHiddenOverride('auth-setup-banner')).toBe(true)
  })

  // The allowlist is EMPTY and should stay that way. The five original offenders
  // were fixed on 2026-08-12 (Boss: "javitsd"), each verified in a real browser
  // via computed style -- one of them, .skill-detail-edit-actions, really was
  // rendering 580x37 px of buttons while carrying the `hidden` attribute. Adding
  // a name back here means shipping a container whose `hidden` does nothing, so
  // add the one-line `.cls[hidden] { display: none }` override instead.
  const KNOWN: string[] = []

  it('no NEW hidden-by-default container silently ignores [hidden]', () => {
    const offenders = hiddenClassNames()
      .filter((c) => hasUnconditionalDisplay(c) && !hasHiddenOverride(c))
      .filter((c) => !KNOWN.includes(c))
    expect(offenders).toEqual([])
  })
})
