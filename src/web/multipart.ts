// Egyszeru multipart/form-data parser: kep + szoveg mezok.

export interface ParsedForm {
  fields: Record<string, string>
  file?: { name: string; data: Buffer; mime: string }
}

function utf8(latin1: string): string {
  return Buffer.from(latin1, 'binary').toString('utf8')
}

export function parseMultipart(buf: Buffer, contentType: string): ParsedForm {
  const boundaryMatch = contentType.match(/boundary=(.+)/)
  if (!boundaryMatch) return { fields: {} }
  const boundary = boundaryMatch[1]
  const parts = buf.toString('binary').split(`--${boundary}`)

  const result: ParsedForm = { fields: {} }

  for (const part of parts) {
    if (part === '--\r\n' || part === '--' || !part.includes('Content-Disposition')) continue
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers = part.slice(0, headerEnd)
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, '')

    const nameMatch = headers.match(/name="([^"]+)"/)
    if (!nameMatch) continue
    const fieldName = utf8(nameMatch[1])

    const filenameMatch = headers.match(/filename="([^"]+)"/)
    if (filenameMatch) {
      const mimeMatch = headers.match(/Content-Type:\s*(.+)\r?\n?/i)
      result.file = {
        // The part was split as latin1 so the file bytes survive intact; the
        // header, though, is UTF-8 -- decode it back, or "fotók.jpg" arrives
        // as "fotÃ³k.jpg" (#424).
        name: utf8(filenameMatch[1]),
        data: Buffer.from(body, 'binary'),
        mime: mimeMatch?.[1]?.trim() || 'application/octet-stream',
      }
    } else {
      result.fields[fieldName] = utf8(body)
    }
  }

  return result
}
