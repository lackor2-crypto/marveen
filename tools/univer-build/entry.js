// Univer spreadsheet grid for the Workbench table editor (kanban #504).
// Bundled by build.mjs into web/vendor/univer/univer.js (+ univer.css).
// Exposes window.MarveenUniver.mount(host, sheets, opts) -> handle.
import { createUniver } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import enUS from '@univerjs/preset-sheets-core/locales/en-US'
import huHU from './hu-HU.json'
import '@univerjs/preset-sheets-core/lib/index.css'

var NUM_RE = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/
// Structural edits are blocked in .xlsx: the server patches the original file and
// keeps styles/merges/widths by POSITION, so a row inserted in the middle would shift
// the data under the wrong formatting. Appending at the end is just typing below.
var STRUCTURE_RE = /^sheet\.command\.(insert-.*(row|col)|insert-range|remove-(row|col)|delete-range-move|move-(rows|cols))/
// Sheet-level edits are blocked everywhere: the save writes the sheets that were opened.
var SHEET_RE = /^sheet\.command\.(insert-sheet|remove-sheet|copy-sheet|set-worksheet-name)/

var CONTENT_MUTATION_RE = /^sheet\.mutation\.(set-range-values|move-range|insert-|remove-|set-worksheet-name|add-worksheet|reorder|move-rows|move-cols)/

// Deep merge: Univer's own mergeLocales drops untranslated keys below the second level
// (the UI then shows the raw key), so the Hungarian pack is laid over English by hand.
function deepMerge(base, over) {
  var out = {}
  Object.keys(base).forEach(function (k) { out[k] = base[k] })
  Object.keys(over).forEach(function (k) {
    var b = out[k]
    var o = over[k]
    out[k] = b && o && typeof b === 'object' && typeof o === 'object' ? deepMerge(b, o) : o
  })
  return out
}

function cellFromText(text) {
  var s = String(text == null ? '' : text)
  if (s === '') return null
  if (s.charAt(0) === '=' && s.length > 1) return { f: s }
  if (NUM_RE.test(s) && s.length < 16 && !/^-?0\d/.test(s)) return { v: Number(s), t: 2 }
  return { v: s, t: 1 }
}

function textFromCell(cell) {
  if (!cell) return ''
  if (typeof cell.f === 'string' && cell.f) return cell.f.charAt(0) === '=' ? cell.f : '=' + cell.f
  if (cell.v == null) {
    if (cell.p && cell.p.body && typeof cell.p.body.dataStream === 'string') return cell.p.body.dataStream.replace(/\r\n$/, '').replace(/\r\n/g, '\n').replace(/\r$/, '')
    return ''
  }
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE'
  return String(cell.v)
}

function mount(host, sheets, opts) {
  opts = opts || {}
  var readonly = !!opts.readonly
  var structureLocked = !!opts.lockStructure
  var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {}
  var onBlocked = typeof opts.onBlocked === 'function' ? opts.onBlocked : function () {}
  var locales = { huHU: deepMerge(enUS, huHU), enUS: enUS }
  var made = createUniver({
    locale: opts.lang === 'en' ? 'enUS' : 'huHU',
    locales: locales,
    presets: [UniverSheetsCorePreset({ container: host, footer: opts.footer !== false })],
  })
  var api = made.univerAPI
  var sheetData = {}
  var order = []
  sheets.forEach(function (sh, i) {
    var id = 'sheet' + i
    var cellData = {}
    var maxC = 0
    ;(sh.rows || []).forEach(function (row, r) {
      var rowObj = null
      ;(row || []).forEach(function (txt, c) {
        var cell = cellFromText(txt)
        if (!cell) return
        if (!rowObj) rowObj = cellData[r] = {}
        rowObj[c] = cell
        if (c + 1 > maxC) maxC = c + 1
      })
    })
    sheetData[id] = {
      id: id,
      name: sh.name || ('Sheet' + (i + 1)),
      cellData: cellData,
      rowCount: Math.max(100, (sh.rows || []).length + 50),
      columnCount: Math.max(26, maxC + 6),
    }
    order.push(id)
  })
  var wb = api.createWorkbook({ id: 'wb', name: 'table', sheetOrder: order, sheets: sheetData })
  var dirty = false
  var disposables = []
  var E = api.Event
  if (E && E.CommandExecuted) {
    disposables.push(api.addEvent(E.CommandExecuted, function (ev) {
      var id = String(ev && ev.id || '')
      if (CONTENT_MUTATION_RE.test(id)) { dirty = true; onChange() }
    }))
  }
  if (E && E.BeforeCommandExecute) {
    disposables.push(api.addEvent(E.BeforeCommandExecute, function (ev) {
      var cid = String(ev && ev.id || '')
      if (SHEET_RE.test(cid) || (structureLocked && STRUCTURE_RE.test(cid))) { ev.cancel = true; onBlocked(SHEET_RE.test(cid) ? 'sheet' : 'structure') }
    }))
  }
  if (readonly) {
    try { wb.setEditable(false) } catch (e) { /* older API */ }
  }

  function read() {
    var snap = api.getActiveWorkbook().save()
    var out = []
    order.forEach(function (id) {
      var s = (snap.sheets || {})[id]
      var rows = []
      var maxC = 0
      var cd = (s && s.cellData) || {}
      var maxR = -1
      Object.keys(cd).forEach(function (rk) {
        var r = Number(rk)
        var rowCells = cd[rk] || {}
        var texts = []
        Object.keys(rowCells).forEach(function (ck) {
          var t = textFromCell(rowCells[ck])
          if (t !== '') { texts[Number(ck)] = t; if (Number(ck) + 1 > maxC) maxC = Number(ck) + 1 }
        })
        if (texts.length) { rows[r] = texts; if (r > maxR) maxR = r }
      })
      var rect = []
      for (var r2 = 0; r2 <= maxR; r2++) {
        var row = []
        for (var c2 = 0; c2 < maxC; c2++) row.push(rows[r2] && rows[r2][c2] != null ? rows[r2][c2] : '')
        rect.push(row)
      }
      if (!rect.length) rect.push([''])
      if (!rect[0].length) rect[0] = ['']
      out.push({ name: (s && s.name) || '', rows: rect })
    })
    return out
  }

  return {
    getSheets: read,
    isDirty: function () { return dirty },
    clearDirty: function () { dirty = false },
    dispose: function () {
      disposables.forEach(function (d) { try { d && d.dispose && d.dispose() } catch (e) { /* ignore */ } })
      try { made.univer.dispose() } catch (e) { /* ignore */ }
    },
  }
}

window.MarveenUniver = { mount: mount, version: '1.0.3' }
