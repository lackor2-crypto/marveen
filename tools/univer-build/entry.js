// Univer spreadsheet grid for the Workbench table editor (kanban #504).
// Bundled by build.mjs into web/vendor/univer/univer.js (+ univer.css).
// Exposes window.MarveenUniver.mount(host, sheets, opts) -> handle.
import { createUniver } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import enUS from '@univerjs/preset-sheets-core/locales/en-US'
import huHU from './hu-HU.json'
import '@univerjs/preset-sheets-core/lib/index.css'

import { blockedKind, hiddenMenuConfig, deepMerge, cellFromText, cellPattern, textFromCell } from './rules.mjs'

var CONTENT_MUTATION_RE = /^sheet\.mutation\.(set-range-values|move-range|insert-|remove-|set-worksheet-name|set-worksheet-order|add-worksheet|reorder|move-rows|move-columns|move-cols)/

function mount(host, sheets, opts) {
  opts = opts || {}
  var readonly = !!opts.readonly
  var structureLocked = !!opts.lockStructure
  // #526: sheets can be added, renamed, removed and reordered unless the file is one sheet by nature (.csv).
  var sheetsLocked = !!opts.lockSheets
  var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {}
  var onBlocked = typeof opts.onBlocked === 'function' ? opts.onBlocked : function () {}
  var locales = { huHU: deepMerge(enUS, huHU), enUS: enUS }
  var made = createUniver({
    locale: opts.lang === 'en' ? 'enUS' : 'huHU',
    locales: locales,
    presets: [UniverSheetsCorePreset({ container: host, footer: opts.footer !== false, menu: hiddenMenuConfig(sheetsLocked) })],
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
    // #526, part 2: every row and column of the opened sheet carries where it came from. The
    // tag travels with the row through inserts, removals, moves and undo (measured), so the
    // save can be told where each row's formatting belongs. An inserted row has no tag.
    var rowData = {}
    var columnData = {}
    for (var rr = 0; rr < (sh.rows || []).length; rr++) rowData[rr] = { custom: { o: rr } }
    // Every column the file has, also one that holds nothing but formatting.
    var fileCols = maxC
    ;(sh.rows || []).forEach(function (row) { if (row && row.length > fileCols) fileCols = row.length })
    for (var cc = 0; cc < fileCols; cc++) columnData[cc] = { custom: { o: cc } }
    sheetData[id] = {
      id: id,
      name: sh.name || ('Sheet' + (i + 1)),
      cellData: cellData,
      rowData: rowData,
      columnData: columnData,
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
      var objectsHere = false
      try {
        var act = api.getActiveWorkbook().getActiveSheet()
        var at = act ? order.indexOf(act.getSheetId()) : -1
        objectsHere = at >= 0 && !!(sheets[at] && sheets[at].structure_locked)
      } catch (e) { objectsHere = false }
      var kind = blockedKind(ev && ev.id, structureLocked, sheetsLocked, objectsHere)
      // Diagnosis only: set window.MarveenUniverDebug = true in the console to see every command.
      if (window.MarveenUniverDebug) console.log('[univer]', ev && ev.id, kind ? 'BLOCKED:' + kind : '')
      if (kind) { ev.cancel = true; onBlocked(kind) }
    }))
  }
  if (readonly) {
    try { wb.setEditable(false) } catch (e) { /* older API */ }
  }

  function read() {
    var fwb = api.getActiveWorkbook()
    var snap = fwb.save()
    var styles = snap.styles || {}
    var out = []
    // The sheets as they are NOW: a new one has an id of Univer's making, a removed one is
    // simply not in the list. `from` tells the server which opened sheet each one was.
    var nowOrder = Array.isArray(snap.sheetOrder) && snap.sheetOrder.length ? snap.sheetOrder : order
    nowOrder.forEach(function (id) {
      var s = (snap.sheets || {})[id]
      if (!s) return
      var from = order.indexOf(id)
      var rows = []
      var maxC = 0
      var cd = (s && s.cellData) || {}
      var maxR = -1
      // A filled or copied formula is stored once and shared: the cell itself may hold
      // only the shared id and the result, so the formula comes from Univer per cell.
      Object.keys(cd).forEach(function (rk) {
        Object.keys(cd[rk] || {}).forEach(function (ck) {
          var cell = cd[rk][ck]
          if (!cell || (cell.v == null && !cell.f && !cell.si && !cell.p)) return
          if (Number(rk) > maxR) maxR = Number(rk)
          if (Number(ck) + 1 > maxC) maxC = Number(ck) + 1
        })
      })
      var ws = maxR >= 0 && maxC > 0 ? fwb.getSheetBySheetId(id) : null
      var formulas = ws ? ws.getRange(0, 0, maxR + 1, maxC).getFormulas() : []
      var lastR = -1
      var lastC = 0
      Object.keys(cd).forEach(function (rk) {
        var r = Number(rk)
        var rowCells = cd[rk] || {}
        var texts = []
        Object.keys(rowCells).forEach(function (ck) {
          var c = Number(ck)
          var cell = rowCells[ck]
          var t = textFromCell(cell, cellPattern(cell, styles), formulas[r] && formulas[r][c])
          if (t !== '') { texts[c] = t; if (c + 1 > lastC) lastC = c + 1 }
        })
        if (texts.length) { rows[r] = texts; if (r > lastR) lastR = r }
      })
      maxR = lastR
      maxC = lastC
      var rect = []
      for (var r2 = 0; r2 <= maxR; r2++) {
        var row = []
        for (var c2 = 0; c2 < maxC; c2++) row.push(rows[r2] && rows[r2][c2] != null ? rows[r2][c2] : '')
        rect.push(row)
      }
      if (!rect.length) rect.push([''])
      if (!rect[0].length) rect[0] = ['']
      // The tags are read past the last filled row too: a row that was only emptied still has
      // its tag (it stays), a row that was removed does not (it goes, with what was bound to it).
      var lastTag = function (data) {
        var m = -1
        Object.keys(data || {}).forEach(function (k) { var d = data[k]; if (d && d.custom && typeof d.custom.o === 'number' && Number(k) > m) m = Number(k) })
        return m + 1
      }
      var tagOf = function (data, n) {
        n = Math.max(n, lastTag(data))
        var arr = []
        for (var k = 0; k < n; k++) { var d = (data || {})[k]; var o = d && d.custom ? d.custom.o : null; arr.push(typeof o === 'number' && o >= 0 && Math.floor(o) === o ? o : null) }
        return arr
      }
      var one = { name: (s && s.name) || '', rows: rect, from: from >= 0 ? from : null }
      // Only for a sheet that was opened: a new sheet has nothing to carry over.
      if (from >= 0) { one.rowsFrom = tagOf(s.rowData, rect.length); one.colsFrom = tagOf(s.columnData, rect[0] ? rect[0].length : 0) }
      out.push(one)
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

window.MarveenUniver = { mount: mount, version: '1.0.3-rows' }
