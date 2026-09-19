// Card #327 (and its duplicate #328): the INBOX "AI suggestion" run must honour
// the owner's ticks. The server side is pinned in life-routes.test.ts; this
// file pins the other end of the wire -- that the button really SENDS the
// ticked names. It runs the real functions from web/app.js against a minimal
// fake DOM instead of matching source text, so a refactor that keeps the
// words but drops the selection still fails here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

function extract(name: string): string {
  const start = src.indexOf(name.startsWith('async ') ? name : 'function ' + name + '(')
  if (start < 0) throw new Error('not found in web/app.js: ' + name)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error('unbalanced: ' + name)
}

async function runAnalyze(checked: string[]) {
  const posts: Array<{ url: string; body: unknown }> = []
  const note = { textContent: '' }
  const document = {
    getElementById: (id: string) => (id === 'inboxAnalyzeNote' ? note : id === 'inboxSuggestions' ? {} : null),
    querySelectorAll: (sel: string) => {
      if (sel !== '.inbox-item:checked') throw new Error('unexpected selector: ' + sel)
      return checked.map((value) => ({ value }))
    },
  }
  const _depoPost = async (url: string, body: unknown) => {
    posts.push({ url, body })
    // Stop right after the request: what happens to the answer is not this test's business.
    throw new Error('stop-after-post')
  }
  const code = [extract('_inboxSelected'), extract('async function _inboxAnalyze'), 'return _inboxAnalyze()'].join('\n')
  const fn = new Function('document', '_depoPost', 't', 'window', '_inboxAiRun', code)
  await fn(document, _depoPost, (k: string) => k, { _lang: 'hu' }, 0)
  return posts
}

describe('Beerkezo AI-javaslat: a kijeloles eljut a szerverig (kartya #327)', () => {
  it('bejelolt tetelekkel CSAK azokat kuldi (names)', async () => {
    const posts = await runAnalyze(['a.pdf', 'b.jpg'])
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toContain('/api/life/inbox/analyze')
    expect(posts[0].body).toEqual({ names: ['a.pdf', 'b.jpg'] })
  })

  it('kijeloles nelkul a "mind" marad (ures torzs)', async () => {
    const posts = await runAnalyze([])
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({})
  })
})

describe('BEERKEZO mappa neve: a telepites nyelve, nem a felulete', () => {
  it('inboxDir ugyanazt adja hu es en feluleti nyelvre', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    process.env.MARVEEN_DEPOT = mkdtempSync(join(tmpdir(), 'marveen-inboxlang-'))
    const { inboxDir } = await import('../life-tree.js')
    expect(inboxDir('en')).toBe(inboxDir('hu'))
    expect(inboxDir('en')).toBe(inboxDir())
  })
})
