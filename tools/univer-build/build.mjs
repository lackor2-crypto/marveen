// Bundles the Univer grid into web/vendor/univer/ (committed output: a fresh install
// needs no npm step for the dashboard). Rebuild only when upgrading Univer or hu-HU.json.
import { build } from 'esbuild'
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', '..', 'web', 'vendor', 'univer')
mkdirSync(out, { recursive: true })
await build({
  entryPoints: [join(here, 'entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: join(out, 'univer.js'),
  loader: { '.css': 'css', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'info',
})
console.log('built', out)
