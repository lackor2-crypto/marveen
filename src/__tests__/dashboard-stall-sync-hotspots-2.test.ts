import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #922 (second half): the event-loop sampler named two more synchronous forks on the dashboard's main thread.
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf-8')

describe('#922: no synchronous process fork from the periodic watchers', () => {
  it('the channel sweep tells checkMainKeepaliveStaleness the plugin is alive, so it skips the ps/pgrep forks', () => {
    const src = read('../web/channel-monitor.ts')
    expect(src).toMatch(/function checkMainKeepaliveStaleness\(pluginKnownAlive = false\)/)
    expect(src).toMatch(/checkMainKeepaliveStaleness\(true\)/)
    expect(src).toMatch(/pluginKnownAlive \? 0 : getClaudePidForSession\(/)
  })

  it('the availability watcher reads the screens asynchronously and hands them to the tick', async () => {
    const src = read('../web/agent-availability-watch.ts')
    expect(src).toMatch(/void availabilityTickAsync\(\)/)
    expect(src).not.toMatch(/setInterval\(\(\) => availabilityTick\(\)/)
    const { measureFleet } = await import('../web/agent-availability-watch.js')
    // Panes given for every agent: measureFleet must not fork a tmux capture itself.
    expect(measureFleet.length).toBeGreaterThanOrEqual(2)
    expect(src).toMatch(/panes && agent in panes \? panes\[agent\]!/)
  })
})
