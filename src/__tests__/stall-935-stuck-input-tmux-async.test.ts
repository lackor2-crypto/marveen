import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #935: the event-loop sampler caught 750-1250 ms main-thread stalls in
// stuck-input-watcher -> performStuckInputAction -> clearInputBuffer -> runTmux -> execFileSync.
// Every `async` function that drives a pane must fork tmux off the event loop.
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf-8')

/** Body of a top-level function, from its signature to the first closing brace in column 0. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `${signature} must exist`).toBeGreaterThanOrEqual(0)
  return src.slice(start, src.indexOf('\n}\n', start))
}

describe('#935: the stuck-input / prompt-injection path forks tmux off the main thread', () => {
  const ap = read('../web/agent-process.ts')
  const cm = read('../web/channel-monitor.ts')

  it.each([
    'export async function clearInputBuffer',
    'async function discardPlaceholderBuffer',
    'export async function sendPromptToSession',
  ])('%s uses neither the synchronous runTmux nor the synchronous capturePane', (sig) => {
    const fn = body(ap, sig)
    expect(fn).not.toMatch(/\brunTmux\(/)
    expect(fn).not.toMatch(/\bcapturePane\(/)
    expect(fn).toMatch(/runTmuxAsync\(|capturePaneStrippedAsync\(/)
  })

  it('performStuckInputAction sends its recovery Enter without execFileSync', () => {
    const fn = body(cm, 'async function performStuckInputAction')
    expect(fn).not.toMatch(/execFileSync\(/)
    expect(fn).toMatch(/runTmuxAsync\(/)
  })

  it('runTmuxAsync keeps the cache invalidation of the synchronous runTmux', () => {
    const fn = body(ap, 'export function runTmuxAsync')
    expect(fn).toMatch(/invalidateObservedPanes\(\)/)
    expect(fn).toMatch(/SESSION_MUTATING_TMUX_VERBS\.has\(tmuxArgs\[0\]\)/)
    expect(fn).toMatch(/execFile\(/)
    expect(fn).not.toMatch(/execFileSync\(/)
  })
})
