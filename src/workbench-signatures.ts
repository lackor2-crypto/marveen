// Saved signatures (Boss TG 3040/3044): picture files anywhere in the Life tree
// whose name says they are a signature. The document editor lists them and the
// owner picks which one goes onto the page; nothing is copied or moved.
import { searchLife } from './life-explorer.js'

export interface SignatureFile { rel: string; name: string; folder: string }

/** Name fragments that mark a signature picture (lower case; accents and plain spelling). */
export const SIGNATURE_TERMS = ['aláírás', 'alairas', 'alárás', 'signature', 'unterschrift', 'szignó']

const IMAGE_EXT = /\.(png|jpe?g|gif)$/i

export function listSignatures(lang?: string): { signatures: SignatureFile[]; truncated: boolean } {
  const seen = new Map<string, SignatureFile>()
  let truncated = false
  for (const term of SIGNATURE_TERMS) {
    const r = searchLife('', term, 200, lang as 'hu' | 'en' | undefined)
    if (r.truncated) truncated = true
    for (const e of r.entries) {
      if (e.isDir || !IMAGE_EXT.test(e.name) || seen.has(e.rel)) continue
      const cut = e.rel.lastIndexOf('/')
      seen.set(e.rel, { rel: e.rel, name: e.name, folder: cut > 0 ? e.rel.slice(0, cut) : '' })
    }
  }
  const signatures = [...seen.values()].sort((a, b) => a.folder.localeCompare(b.folder, 'hu') || a.name.localeCompare(b.name, 'hu'))
  return { signatures, truncated }
}
