import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { _resetEventLoopWatch, noteLag, recentStalls, trackRequest, STALL_MS } from '../web/event-loop-watch.js'

const fakeRes = () => new EventEmitter() as unknown as http.ServerResponse
const fakeReq = (method: string) => ({ method }) as http.IncomingMessage

describe('#490 event-loop stall watch', () => {
  afterEach(() => _resetEventLoopWatch())

  it('a short delay is not a stall', () => {
    expect(noteLag(STALL_MS - 1)).toBeNull()
    expect(recentStalls()).toEqual([])
  })

  it('a stall names the requests that were running, never the query string', () => {
    const res = fakeRes()
    trackRequest(fakeReq('POST'), res, '/api/workbench/items/x/move')
    const s = noteLag(1200, 1)
    expect(s).toMatchObject({ lagMs: 1200, inflight: ['POST /api/workbench/items/x/move'] })
    ;(res as unknown as EventEmitter).emit('finish')
    expect(noteLag(500, 2)!.inflight).toEqual([])
  })

  it('keeps the worst stalls first', () => {
    noteLag(400, 1); noteLag(2000, 2); noteLag(900, 3)
    expect(recentStalls().map((s) => s.lagMs)).toEqual([2000, 900, 400])
  })
})
