import { describe, it, expect, vi } from 'vitest'

// ISSUE1895 (#1895): owner-facing times follow the install zone (APP_TZ), not a
// hardcoded Europe/Budapest. With the zone set to Europe/London, the heartbeat
// header is London time -- one hour behind Budapest in
// September -- which is what an install outside Central Europe must see.
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_TZ: 'Europe/London' }))

const { stampHeartbeatHeader } = await import('../web/heartbeat-header-stamp.js')

// 2026-09-08T13:00:28Z == 14:00 in Europe/London (BST), 15:00 in Europe/Budapest
const NOW = new Date('2026-09-08T13:00:28Z')

describe('the install zone, not Budapest (ISSUE1895)', () => {
  it('the heartbeat header is stamped in APP_TZ', () => {
    expect(stampHeartbeatHeader('## Heartbeat 2026-09-08 18:00', NOW)).toBe('## Heartbeat 2026-09-08 14:00')
  })
})
