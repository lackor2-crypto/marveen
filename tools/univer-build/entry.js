// Univer spreadsheet grid for the Workbench table editor (kanban #504).
// Bundled by build.mjs into web/vendor/univer/univer.js (+ univer.css).
// Exposes window.MarveenUniver.mount(host, sheets, opts) -> handle.
import { createUniver, IUndoRedoService } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import enUS from '@univerjs/preset-sheets-core/locales/en-US'
import huHU from './hu-HU.json'
import '@univerjs/preset-sheets-core/lib/index.css'
import './widgets.css'

import { blockedKind, hiddenMenuConfig, deepMerge, cellFromText, cellPattern, textFromCell, styleToUniver, univerToStyle, cellStyleOf, isDatePattern, isoToSerial, freezeCount, freezeConfig, freezeCounts, FREEZE_MAX_ROWS, FREEZE_MAX_COLS } from './rules.mjs'

var CONTENT_MUTATION_RE = /^sheet\.mutation\.(set-range-values|set\.numfmt|remove\.numfmt|move-range|insert-|remove-|set-worksheet-name|set-worksheet-order|add-worksheet|reorder|move-rows|move-columns|move-cols)/
// The commands after which the undo / redo stack has changed (kanban #533: the top bar's two buttons follow it).
var HISTORY_COMMAND_RE = /^univer\.command\.(undo|redo)$/
// #557: a freeze changed, or another sheet came to the front: the two freeze boxes show the sheet's own state.
var FREEZE_COMMAND_RE = /^sheet\.(command\.(set-selection-frozen|set-row-frozen|set-col-frozen|set-frozen|cancel-frozen|set-first-row-frozen|set-first-col-frozen)|operation\.set-worksheet-active)$/
// Univer's own toolbar button for freezing (the dropdown the two boxes replace) and the list of the border panel.
var FREEZE_TRIGGER_SEL = '[data-u-command="sheet.toolbar.sheet-frozen"]'
var BORDER_PANEL_SEL = 'div[class*="univer-grid-cols-5"]'
var BORDER_PANEL_ICONS = 15
var BORDER_NONE_AT = 4

function mount(host, sheets, opts) {
  opts = opts || {}
  var readonly = !!opts.readonly
  var structureLocked = !!opts.lockStructure
  // #526: sheets can be added, renamed, removed and reordered unless the file is one sheet by nature (.csv).
  var sheetsLocked = !!opts.lockSheets
  // #526 part 3 (section A): an .xlsx with a usable stylesheet keeps font, colours, alignment,
  // wrap, column widths and row heights. Without it (a .csv) formatting stays blocked.
  var formatKept = !!opts.formatting
  var styleTable = opts.styleTable || {}
  // Defaults close to what Excel shows, so a column or row the file leaves alone looks like it.
  var DEF_COL_W = 64
  var DEF_ROW_H = 20
  var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {}
  var onBlocked = typeof opts.onBlocked === 'function' ? opts.onBlocked : function () {}
  // #533: called after a command that changed the grid's undo / redo stack.
  var onHistory = typeof opts.onHistory === 'function' ? opts.onHistory : function () {}
  // #557: the words of the two controls this build adds (the page hands them over: HU + EN live in web/lang).
  var texts = opts.texts || {}
  var T = function (k, d) { return typeof texts[k] === 'string' && texts[k] ? texts[k] : d }
  var locales = { huHU: deepMerge(enUS, huHU), enUS: enUS }
  var made = createUniver({
    locale: opts.lang === 'en' ? 'enUS' : 'huHU',
    locales: locales,
    presets: [UniverSheetsCorePreset({ container: host, footer: opts.footer !== false, menu: hiddenMenuConfig(sheetsLocked, formatKept) })],
  })
  var api = made.univerAPI
  host.classList.add('mv-uv-host')
  var sheetData = {}
  var order = []
  // Per opened sheet: what the file had, to tell later what the editor changed.
  var loaded = []
  var wbStyles = {}
  Object.keys(styleTable).forEach(function (k) { wbStyles['f' + k] = styleToUniver(styleTable[k]) })
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
    // Formats: a cell keeps the file's own style under the id 'f<key>', so a cell the editor did
    // not touch is recognised at save time by that id and by where it came from.
    var keyAt = {}
    ;(sh.cellStyles || []).forEach(function (e) {
      var r = e[0]; var c = e[1]; var k = e[2]
      if (!wbStyles['f' + k]) return
      keyAt[r + ',' + c] = k
      var rowObj = cellData[r] || (cellData[r] = {})
      var cell = rowObj[c] || (rowObj[c] = {})
      cell.s = 'f' + k
      // The server sends a date as text ("2024-03-05"); under a date format the grid needs the
      // number, or it shows the text as it is and a format picked later has nothing to work on.
      var nf = styleTable[k] && styleTable[k].nf
      if (formatKept && nf && cell.t === 1 && typeof cell.v === 'string' && isDatePattern(nf)) {
        var serial = isoToSerial(cell.v)
        if (serial != null) { cell.v = serial; cell.t = 2 }
      }
      if (c + 1 > maxC) maxC = c + 1
    })
    var wLoaded = {}
    var hLoaded = {}
    // #526, part 2: every row and column of the opened sheet carries where it came from. The
    // tag travels with the row through inserts, removals, moves and undo (measured), so the
    // save can be told where each row's formatting belongs. An inserted row has no tag.
    var rowData = {}
    var columnData = {}
    var nRows = (sh.rows || []).length
    Object.keys(keyAt).forEach(function (k) { var r = Number(k.split(',')[0]); if (r + 1 > nRows) nRows = r + 1 })
    for (var rr = 0; rr < nRows; rr++) rowData[rr] = { custom: { o: rr } }
    if (formatKept) Object.keys(sh.rowHeights || {}).forEach(function (k) { if (rowData[k]) { rowData[k].h = sh.rowHeights[k]; rowData[k].ia = 0; hLoaded[k] = sh.rowHeights[k] } })
    // Every column the file has, also one that holds nothing but formatting.
    var fileCols = maxC
    ;(sh.rows || []).forEach(function (row) { if (row && row.length > fileCols) fileCols = row.length })
    for (var cc = 0; cc < fileCols; cc++) columnData[cc] = { custom: { o: cc } }
    Object.keys(sh.colWidths || {}).forEach(function (k) {
      if (!formatKept) return
      var c = Number(k)
      if (!columnData[c]) columnData[c] = { custom: { o: c } }
      columnData[c].w = sh.colWidths[k]
      wLoaded[k] = sh.colWidths[k]
    })
    loaded.push({ keyAt: keyAt, w: wLoaded, h: hLoaded })
    sheetData[id] = {
      id: id,
      name: sh.name || ('Sheet' + (i + 1)),
      cellData: cellData,
      rowData: rowData,
      columnData: columnData,
      mergeData: formatKept ? (sh.merges || []).map(function (m) { return { startRow: m[0], startColumn: m[1], endRow: m[2], endColumn: m[3] } }) : [],
      rowCount: Math.max(100, nRows + 50),
      defaultColumnWidth: DEF_COL_W,
      defaultRowHeight: DEF_ROW_H,
      columnCount: Math.max(26, maxC + 6),
    }
    order.push(id)
  })
  var wb = api.createWorkbook({ id: 'wb', name: 'table', sheetOrder: order, sheets: sheetData, styles: wbStyles })
  var dirty = false
  var disposables = []
  var E = api.Event
  if (E && E.CommandExecuted) {
    disposables.push(api.addEvent(E.CommandExecuted, function (ev) {
      var id = String(ev && ev.id || '')
      if (CONTENT_MUTATION_RE.test(id)) { dirty = true; onChange() }
      if (CONTENT_MUTATION_RE.test(id) || HISTORY_COMMAND_RE.test(id)) onHistory()
      if (FREEZE_COMMAND_RE.test(id)) host.querySelectorAll('[data-mv-freeze]').forEach(function (b) { freezeShow(b) })
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
      var kind = blockedKind(ev && ev.id, structureLocked, sheetsLocked, objectsHere, formatKept)
      // Diagnosis only: set window.MarveenUniverDebug = true in the console to see every command.
      if (window.MarveenUniverDebug) console.log('[univer]', ev && ev.id, kind ? 'BLOCKED:' + kind : '')
      if (kind) { ev.cancel = true; onBlocked(kind) }
    }))
  }
  if (readonly) {
    try { wb.setEditable(false) } catch (e) { /* older API */ }
  }

  // #557 (owner TG 8786): freezing is two typed values -- how many rows, how many columns -- and 0 / 0 lifts
  // it. The boxes sit where Univer's "Freeze" dropdown was (that one is hidden by widgets.css).
  function activeSheet() {
    try { return api.getActiveWorkbook().getActiveSheet() } catch (e) { return null }
  }
  function freezeMax(ws) {
    var mr = FREEZE_MAX_ROWS
    var mc = FREEZE_MAX_COLS
    try { mr = Math.min(mr, ws.getMaxRows() - 1) } catch (e) { /* keep the cap */ }
    try { mc = Math.min(mc, ws.getMaxColumns() - 1) } catch (e) { /* keep the cap */ }
    return { rows: mr, cols: mc }
  }
  // `force`: after "Set" the boxes show what the sheet really holds, also a number typed beyond the limit.
  function freezeShow(box, force) {
    var ws = activeSheet()
    var f = ws ? freezeCounts(ws.getFreeze()) : { rows: 0, cols: 0 }
    var ins = box.querySelectorAll('input')
    // Otherwise do not overwrite what the user is typing in this very moment.
    if (force || host.ownerDocument.activeElement !== ins[0]) ins[0].value = String(f.rows)
    if (force || host.ownerDocument.activeElement !== ins[1]) ins[1].value = String(f.cols)
  }
  function freezeApply(box) {
    var ws = activeSheet()
    if (!ws) return
    var ins = box.querySelectorAll('input')
    var mx = freezeMax(ws)
    var cfg = freezeConfig(freezeCount(ins[0].value, mx.rows), freezeCount(ins[1].value, mx.cols))
    try { ws.setFreeze(cfg) } catch (e) { /* the boxes below show what the sheet really holds */ }
    freezeShow(box, true)
  }
  function freezeBox() {
    var d = host.ownerDocument
    var box = d.createElement('span')
    box.className = 'mv-uv-freeze'
    box.setAttribute('data-mv-freeze', '1')
    box.title = T('freezeHint', '0 and 0: lift the freeze')
    var mk = function (tag, text) { var e = d.createElement(tag); if (text != null) e.textContent = text; return e }
    var num = function (label) {
      var i = d.createElement('input')
      i.type = 'number'; i.min = '0'; i.step = '1'; i.value = '0'; i.setAttribute('inputmode', 'numeric'); i.setAttribute('aria-label', label)
      return i
    }
    var rowsIn = num(T('freezeRows', 'rows'))
    var colsIn = num(T('freezeCols', 'columns'))
    var btn = mk('button', T('freezeApply', 'Set'))
    btn.type = 'button'
    box.appendChild(mk('b', T('freezeTitle', 'Freeze')))
    box.appendChild(rowsIn)
    box.appendChild(mk('span', T('freezeRows', 'rows')))
    box.appendChild(colsIn)
    box.appendChild(mk('span', T('freezeCols', 'columns')))
    box.appendChild(btn)
    btn.addEventListener('click', function () { freezeApply(box) })
    // Keys typed here are the box's, not the grid's (Univer would start editing the active cell).
    ;['keydown', 'keyup', 'keypress', 'beforeinput', 'paste', 'copy', 'cut'].forEach(function (n) {
      box.addEventListener(n, function (ev) {
        ev.stopPropagation()
        if (n === 'keydown' && ev.key === 'Enter') { ev.preventDefault(); freezeApply(box) }
      })
    })
    return box
  }
  // The border panel is a list of 15 icons without a word on them: "no border" is the fifth one. A plain word
  // button under the icons does what that icon does (owner TG 8821: a border once set must be able to go).
  function borderNoneButton(grid) {
    var b = host.ownerDocument.createElement('button')
    b.type = 'button'
    b.className = 'mv-uv-noborder'
    b.setAttribute('data-mv-noborder', '1')
    b.textContent = T('noBorder', 'No border')
    b.addEventListener('mousedown', function (ev) { ev.stopPropagation() })
    b.addEventListener('click', function (ev) {
      ev.stopPropagation()
      var icon = grid.children[BORDER_NONE_AT]
      if (icon) icon.click()
    })
    return b
  }
  function placeWidgets() {
    var d = host.ownerDocument
    host.querySelectorAll(FREEZE_TRIGGER_SEL).forEach(function (trigger) {
      var prev = trigger.previousElementSibling
      if (prev && prev.getAttribute && prev.getAttribute('data-mv-freeze')) return
      var box = freezeBox()
      trigger.parentNode.insertBefore(box, trigger)
      freezeShow(box, true)
    })
    d.querySelectorAll(BORDER_PANEL_SEL).forEach(function (grid) {
      if (grid.children.length !== BORDER_PANEL_ICONS || !host.ownerDocument.body.contains(grid)) return
      var next = grid.nextElementSibling
      if (next && next.getAttribute && next.getAttribute('data-mv-noborder')) return
      grid.parentNode.insertBefore(borderNoneButton(grid), grid.nextSibling)
    })
  }
  var placeQueued = false
  var watcher = null
  if (typeof MutationObserver === 'function') {
    watcher = new MutationObserver(function () {
      if (placeQueued) return
      placeQueued = true
      var run = function () { placeQueued = false; try { placeWidgets() } catch (e) { /* the grid works without them */ } }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16)
    })
    watcher.observe(host.ownerDocument.body, { childList: true, subtree: true })
  }
  try { placeWidgets() } catch (e) { /* the grid works without them */ }

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
          var t = textFromCell(cell, cellPattern(cell, styles), formulas[r] && formulas[r][c], formatKept)
          if (t !== '') { texts[c] = t; if (c + 1 > lastC) lastC = c + 1 }
        })
        if (texts.length) { rows[r] = texts; if (r > lastR) lastR = r }
      })
      maxR = lastR
      maxC = lastC
      var tagNow = function (data, i) { var d = (data || {})[i]; var o = d && d.custom ? d.custom.o : null; return typeof o === 'number' ? o : null }
      // Formatting (section A): every cell whose style is not the one the file had at the place
      // it came from goes along in full -- also an emptied one, and one inserted or moved.
      var fmt = []
      var ld = from >= 0 ? loaded[from] : null
      if (formatKept) {
        Object.keys(cd).forEach(function (rk) {
          var r = Number(rk)
          var rowCells = cd[rk] || {}
          Object.keys(rowCells).forEach(function (ck) {
            var c = Number(ck)
            var cell = rowCells[ck]
            // A styled cell stays in the grid even when it is empty, or the save would drop it.
            if (cell && cell.s != null) {
              if (r > maxR) maxR = r
              if (c + 1 > maxC) maxC = c + 1
            }
            var sid = cell && typeof cell.s === 'string' ? cell.s : null
            var m = sid ? /^f(\d+)$/.exec(sid) : null
            var ro = tagNow(s.rowData, r)
            var co = tagNow(s.columnData, c)
            var origKey = ld && ro != null && co != null ? ld.keyAt[ro + ',' + co] : undefined
            if (m && origKey !== undefined && Number(m[1]) === origKey) return
            var st = univerToStyle(cellStyleOf(cell, styles))
            // Nothing to say: no format now and none came with the place.
            if (!Object.keys(st).length && origKey === undefined) return
            fmt.push([r, c, st])
            if (r > maxR) maxR = r
            if (c + 1 > maxC) maxC = c + 1
          })
        })
      }
      // Merged ranges (section B): the editor's own list, as it stands now. The grid reaches to
      // their far corner so the saved sheet has those rows and columns.
      var merges = []
      if (formatKept) {
        ;(s.mergeData || []).forEach(function (m) {
          if (!m || m.endRow < m.startRow || m.endColumn < m.startColumn) return
          if (m.startRow === m.endRow && m.startColumn === m.endColumn) return
          merges.push([m.startRow, m.startColumn, m.endRow, m.endColumn])
          if (m.endRow > maxR) maxR = m.endRow
          if (m.endColumn + 1 > maxC) maxC = m.endColumn + 1
        })
      }
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
      if (formatKept) {
        if (fmt.length) one.fmt = fmt
        // Always sent when the format is kept: an empty list means "nothing is merged now".
        one.merges = merges
        // Sizes only where they differ from what the file had at that index.
        var sizes = function (data, was, def, n) {
          var o = {}
          var any = false
          for (var k = 0; k < n; k++) {
            var w = (data || {})[k] && data[k][def.key]
            var have = was[String(k)]
            if (typeof w === 'number' && w > 0) { if (w !== have) { o[k] = Math.round(w); any = true } }
            else if (have !== undefined) { o[k] = def.dflt; any = true }
          }
          return any ? o : null
        }
        var nC = Math.max(rect[0] ? rect[0].length : 0, lastTag(s.columnData))
        var nR = Math.max(rect.length, lastTag(s.rowData))
        var cw = sizes(s.columnData, ld ? ld.w : {}, { key: 'w', dflt: DEF_COL_W }, nC)
        var rh = sizes(s.rowData, ld ? ld.h : {}, { key: 'h', dflt: DEF_ROW_H }, nR)
        if (cw) one.colWidths = cw
        if (rh) one.rowHeights = rh
      }
      out.push(one)
    })
    return out
  }

  // The grid's own undo / redo stack (Univer keeps cell values, rows, columns, formats and the row tags
  // above together). The workbook is focused first, so the step lands in this grid and not elsewhere.
  function step(dir) {
    if (readonly) return false
    try {
      var st = status()
      if (!(dir === 'undo' ? st.undos : st.redos)) return false
      if (dir === 'undo') wb.undo(); else wb.redo()
      return true
    } catch (e) { return false }
  }
  function status() {
    try {
      var s = api._injector.get(IUndoRedoService).getUndoRedoStatus(wb.getId())
      return { undos: Number(s && s.undos) || 0, redos: Number(s && s.redos) || 0 }
    } catch (e) { return { undos: 0, redos: 0 } }
  }

  return {
    getSheets: read,
    undo: function () { return step('undo') },
    redo: function () { return step('redo') },
    historyStatus: status,
    // #557: the freeze of the sheet in front, as the two boxes hold it ({rows, cols}).
    getFreeze: function () { var ws = activeSheet(); return ws ? freezeCounts(ws.getFreeze()) : { rows: 0, cols: 0 } },
    isDirty: function () { return dirty },
    clearDirty: function () { dirty = false },
    dispose: function () {
      if (watcher) { try { watcher.disconnect() } catch (e) { /* ignore */ } }
      disposables.forEach(function (d) { try { d && d.dispose && d.dispose() } catch (e) { /* ignore */ } })
      try { made.univer.dispose() } catch (e) { /* ignore */ }
    },
  }
}

window.MarveenUniver = { mount: mount, version: '1.0.3-reset' }
