// A Munkapad vegpontjainak hivasa a VALODI utvonalkezelon at (#406 tesztjei).
// Ugyanaz a minta, mint a `workbench-routes.test.ts`-ben: a valasz igazi
// Writable, a keres igazi Readable -- JSON-t es nyers bajtokat is merni lehet.
import { Readable, Writable } from 'node:stream'
import type { RouteContext } from '../../web/routes/types.js'
import { tryHandleWorkbench } from '../../web/routes/workbench.js'

export interface CallResult {
  handled: boolean
  status: number
  body: any
  raw: Buffer
  headers: Record<string, string>
}

export async function callWorkbench(path: string, method: string, body?: unknown, headers?: Record<string, string>): Promise<CallResult> {
  const chunks: Buffer[] = []
  const out = { status: 200, headers: {} as Record<string, string> }
  const res: any = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) { chunks.push(Buffer.from(chunk)); cb() },
  })
  const done = new Promise<void>((resolve) => { res.on('finish', () => resolve()) })
  res.writeHead = (status: number, hdrs?: Record<string, string>) => {
    out.status = status
    if (hdrs) out.headers = { ...out.headers, ...hdrs }
    return res
  }
  res.setHeader = (k: string, v: unknown) => { out.headers[k] = String(v); return res }
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
  const req: any = Readable.from([raw])
  req.headers = { 'content-type': 'application/json', 'content-length': String(raw.length), ...(headers || {}) }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext
  const handled = await tryHandleWorkbench(ctx)
  if (handled) await done
  const buf = Buffer.concat(chunks)
  let parsed: any = null
  try { parsed = buf.length ? JSON.parse(buf.toString('utf-8')) : null } catch { parsed = null }
  return { handled, status: out.status, body: parsed, raw: buf, headers: out.headers }
}
