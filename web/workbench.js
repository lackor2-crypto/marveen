/* AI MUNKAPAD -- felulet (kanban #336, 740b432a, 1. fazis: vaz + adatmodell).
 *
 * Kulon fajl, szandekosan: a Munkapad a Projektek modulra ul ra, de a kodja
 * nem keveredik bele az app.js-be (fork-barat -- az upstream-merge utkozes
 * igy egyetlen gombra es egy esemenyagra korlatozodik).
 *
 * Ami MOST mukodik: a harom paneles vaz, a munkadarabok listaja, uj
 * munkadarab letrehozasa a feluletrol, es a kontextus-panel. Ami MEG NEM: az
 * agent-chat (2. fazis) es a preview/editor (3. fazis) -- ezek a helyukon
 * allnak, kikapcsolva, kiirva hogy mikor jonnek.
 *
 * Az app.js-bol hasznalt globalisok: t, escapeHtml, escapeAttr, showToast,
 * _prjOpenProject.
 */
(function () {
  'use strict'

  var WB = {
    open: false,
    projectId: null,
    project: null,
    items: null,
    selectedId: null,
    detail: null,
    formOpen: false,
    busy: false,
    // --- sablonok (#406, 11. pont) ---
    // null = meg nem jott meg; a hiba KULON all, nem "nincs sablon".
    templates: null,
    templatesLang: null,
    templatesError: null,
    tplBusy: null,
    error: null,
    // Mobilon egyszerre egy panel latszik; asztalin mind a harom.
    panel: 'items',
    // --- agent-chat (3. fazis) ---
    // Beszelgetesek KULCS szerint: a kivalasztott munkadarabe kulon, a
    // munkadarab nelkuli (projekt-szintu) kulon. Igy a valtogatas nem keveri
    // ossze oket, es nem is vesz el semmi.
    chat: {},
    chatStatus: null,
    chatStatusError: null,
    chatStreaming: false,
    chatAbort: null,
    chatDraft: '',
    chatSetupOpen: false,
    chatSetupBusy: false,
    chatConfig: null,
    // --- reszek (vegyes munkadarab, 3. fazis) ---
    partEdit: null,
    partNewOpen: false,
    partBusy: false,
    // --- kepessegek / fuggosegek (8. fazis) ---
    // `caps === null` NEM azt jelenti, hogy nincs egy kepesseg sem: azt, hogy
    // meg nem kerdeztuk meg. A ketto kulon latszik a kepernyon is.
    capsOpen: false,
    caps: null,
    capsError: null,
    capsBusy: null,
    // --- rajzvaszon (9. fazis) ---
    // `canvas === null` = MEG NEM kerdeztuk meg (vagy hiba volt); a
    // `canvas.exists === false` = megkerdeztuk, es meg nincs rajz. A ketto
    // KULON allapot, kulon mondattal a kepernyon.
    canvas: null,
    canvasError: null,
    canvasBusy: false,
    canvasEdit: null,
    canvasStamp: null,
    // Melyik elemet jelolte ki a felhasznalo a vasznon (huzogatas, kartya
    // d4b05d82). Csak a KIEMELEST jelenti, a szerkeszto urlapot nem nyitja.
    canvasSel: null,
    // --- PDF-nezegeto (kartya f7d423e7) ---
    // A kirajzolt lapok DOM-csomopontja TULELI a render()-t, ezert itt all,
    // nem a felulet HTML-jeben. A `pdfLib === null` = meg nem kertuk le a
    // konyvtarat; a betoltes HIBAJA kulon, a `pdf.error`-ban latszik.
    pdf: null,
    pdfLib: null,
    pdfLibPromise: null,
    // --- elonezet (4. fazis) ---
    preview: null,
    previewVersion: null,
    versionBusy: false,
    // --- kozvetlen szovegszerkesztes (#406, 4. pont) ---
    textEdit: null,
    // --- verziok egymas mellett (#406, 5. pont) ---
    // null = nincs nyitva; kulonben {itemId, left, right, pos, sides}.
    compare: null,
    // --- export + kuldes (#406, 6. pont) ---
    exportOpen: null,
    send: null,
    pngBusy: false,
    // --- osztott nezet (#406, 1. pont) ---
    // 'split' = bal oldalt a chat, jobb oldalt az ELO munkadarab (a szakmaban
    // bevett "chat + artifact" elrendezes); 'classic' = a harom panel, alatta a
    // chat. A valasztas a bongeszoben marad meg (nincs szerver-oldali allapot).
    layout: readLayout(),
    liveTimer: null,
    // --- projekt-idovonal (#406, 7. pont) ---
    // `tl === null` = meg nem kerdeztuk meg; ures tomb = megkerdeztuk, es
    // tenyleg nincs esemeny. A `tlSources` a forrasok, amikbe NEM lattunk bele.
    tlOpen: false,
    tl: null,
    tlError: null,
    tlSources: [],
    tlMore: false,
    tlNext: null,
    tlBusy: false,
    // --- kereses a projektben (#406, 8. pont) ---
    // `search === null` = meg nem kerestunk; a hiba KULON all.
    searchOpen: false,
    searchQ: '',
    search: null,
    searchError: null,
    searchBusy: false,
    // --- jovahagyas munkadarabra (#406, 9. pont) ---
    approvalBusy: false,
    // --- heti osszefoglalo (#406, 13. pont) ---
    // `weekly === null` = meg nem toltottuk be; a hiba KULON all.
    wkOpen: false,
    weekly: null,
    wkError: null,
    wkShown: null,
    // --- kis teendok hataridovel (#406, 14. pont) ---
    // `todos === null` = meg nem toltottuk be; a hiba KULON all, hogy a "nem
    // tudtam betolteni" sose latsszon "nincs teendo"-nek.
    todos: null,
    tdError: null,
    tdBusy: false,
    pinBusy: false,
    tdOpen: false,
    tdRem: null,
    tdRemError: null,
    tdRemBusy: false,
    // --- dontesnaplo (#406, 10. pont) ---
    // `decisions === null` = meg nem toltottuk be; a hiba KULON all, hogy a
    // "nem tudtam betolteni" sose latsszon "meg nincs dontes"-nek.
    decOpen: false,
    decisions: null,
    // --- atadocsomag (#406, 12. pont) ---
    hoOpen: false,
    hoScope: 'done',
    hoPlan: null,
    hoError: null,
    decError: null,
    decBusy: false,
    decEdit: null,
    // --- projekt-attekinto (#406, 2. pont) ---
    // `overview === null` = MEG NEM kerdeztuk meg; a hiba KULON all, hogy a
    // "nem tudtam lekerdezni" sose latsszon "nincs semmi"-nek.
    overview: null,
    overviewError: null,
    // --- behuzas es feltoltes (#406, 3. pont) ---
    // `upload === null` = nincs folyamatban; kulonben {done, total}.
    upload: null,
  }

  /** A mentett elrendezes. Ha a bongeszo nem enged tarolni (privat mod, regi
   *  bongeszo), az osztott nezet az alap -- a hiba nem akaszthatja meg a Munkapadot. */
  function readLayout() {
    try {
      var v = window.localStorage && window.localStorage.getItem('marveen.workbench.layout')
      return v === 'classic' ? 'classic' : 'split'
    } catch (_e) { return 'split' }
  }

  function saveLayout(v) {
    try { if (window.localStorage) window.localStorage.setItem('marveen.workbench.layout', v) } catch (_e) { /* nem baj: csak most ervenyes */ }
  }

  function esc(s) { return window.escapeHtml(s == null ? '' : String(s)) }
  function escA(s) { return window.escapeAttr(s == null ? '' : String(s)) }
  function t(key, params) { return window.t(key, params || {}) }

  function root() { return document.getElementById('projectsRoot') }

  function when(sec) {
    if (!sec) return '-'
    try { return new Date(sec * 1000).toLocaleString() } catch (_e) { return '-' }
  }

  function api(method, url, body) {
    var full = url + (url.indexOf('?') < 0 ? '?' : '&') + 'lang=' + encodeURIComponent(window._lang || 'hu')
    var opts = { method: method }
    if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body) }
    return fetch(full, opts).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        if (!res.ok) {
          // A test HIBANAL is kell: a szerver ott adja a reszleteket (a VALODI
          // hibauzenetet), es azt meg kell tudnunk mutatni.
          return { ok: false, status: res.status, code: data && data.error, data: data, message: (data && data.message) || t('workbench.err.http', { status: res.status }) }
        }
        return { ok: true, status: res.status, data: data }
      })
    }).catch(function () {
      return { ok: false, status: 0, code: 'network', message: t('workbench.err.network') }
    })
  }

  // ---- adatbetoltes ---------------------------------------------------------

  function load(projectId) {
    return api('GET', '/api/workbench/items?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (WB.projectId !== projectId) return
      if (!r.ok) { WB.error = r.message; WB.items = []; render(); return }
      WB.error = null
      WB.project = r.data.project
      WB.items = r.data.items || []
      loadOverview(projectId)
      loadTodos(projectId)
      if (WB.templates === null || WB.templatesLang !== (window._lang || 'hu')) loadTemplates()
      if (WB.selectedId && !WB.items.some(function (i) { return i.id === WB.selectedId })) WB.selectedId = null
      render()
    })
  }

  // ---- kituzes (#406, 21bcb1f4) ---------------------------------------------
  //
  // A sorrendet a szerver adja vissza (friss lista), a felulet nem rendez maga.

  function togglePin(id) {
    if (WB.pinBusy || archived()) return
    var it = (WB.items || []).filter(function (x) { return x.id === id })[0]
    if (!it) return
    var pinned = it.pinned_at == null
    var pid = WB.projectId
    WB.pinBusy = true
    render()
    return api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/pin', { pinned: pinned }).then(function (r) {
      WB.pinBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (r.data && Array.isArray(r.data.items)) WB.items = r.data.items
      window.showToast(t(pinned ? 'workbench.pin.added' : 'workbench.pin.removed'))
      render()
    })
  }

  // ---- kis teendok hataridovel (#406, 14. pont) -------------------------------
  // A projekt osszes teendoje EGY listaban jon; a szerkeszto a kivalasztott
  // munkadarabet szuri ki belole. A naptarba egy .ics fajl viszi at (barmely
  // naptar felveszi), semmi nem megy ki a geprol magatol.

  function loadTodos(projectId) {
    var pid = projectId || WB.projectId
    if (!pid) return
    return api('GET', '/api/workbench/todos?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.tdError = r.message; WB.todos = null; render(); return }
      WB.tdError = null
      WB.todos = (r.data && r.data.todos) || []
      render()
    })
  }

  /** A mai nap (a bongeszo helyi ideje szerint), YYYY-MM-DD. */
  function todayStr() {
    var d = new Date()
    function p(n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  function tdDueState(td) {
    if (td.done_at != null || !td.due_date) return ''
    var today = todayStr()
    if (td.due_date < today) return 'overdue'
    if (td.due_date === today) return 'today'
    return 'upcoming'
  }

  function tdDueLabel(td) {
    if (!td.due_date) return ''
    var d
    try {
      var a = td.due_date.split('-')
      d = new Date(+a[0], +a[1] - 1, +a[2]).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
    } catch (_e) { d = td.due_date }
    var st = tdDueState(td)
    return st === 'overdue' ? t('workbench.td.overdue', { date: d })
      : st === 'today' ? t('workbench.td.today', { date: d })
        : t('workbench.td.due', { date: d })
  }

  /** Egy YYYY-MM-DD nap a felulet nyelven, a megadott formaban. */
  function tdDateText(ymd, opts) {
    try {
      var a = ymd.split('-')
      return new Date(+a[0], +a[1] - 1, +a[2]).toLocaleDateString(undefined, opts)
    } catch (_e) { return ymd }
  }

  /** Ismetlodes (otlet 11dfd5a9): "↻ hetente (hetfo)" / "↻ havonta, 1-jen". */
  function tdRepeatLabel(td) {
    if (!td.repeat || !td.due_date) return ''
    if (td.repeat === 'weekly') return t('workbench.td.repeat_weekly_label', { weekday: tdDateText(td.due_date, { weekday: 'long' }) })
    return t('workbench.td.repeat_monthly_label', { day: td.repeat_day || +td.due_date.slice(8, 10) })
  }

  function tdRowHtml(td, withItem) {
    var ro = archived() || WB.tdBusy ? ' disabled' : ''
    var done = td.done_at != null
    var st = tdDueState(td)
    var ics = td.due_date && !done
      ? ' <a class="wb-linklike" href="/api/workbench/todos/' + encodeURIComponent(td.id) + '/ics?lang=' + encodeURIComponent(window._lang || 'hu') + '" download>'
        + esc(t('workbench.td.to_calendar')) + '</a>' : ''
    return '<li class="wb-td-row' + (done ? ' wb-td-done' : '') + (st ? ' wb-td-' + st : '') + '">'
      + '<button type="button" class="wb-td-check" data-wb-act="td-toggle" data-wb-todo="' + escA(td.id) + '" aria-pressed="' + done + '"'
      + ' aria-label="' + escA(t(done ? 'workbench.td.undo' : 'workbench.td.tick')) + '"' + ro + '>' + (done ? '✓' : '') + '</button>'
      + '<div class="wb-td-body"><span class="wb-td-text">' + esc(td.text) + '</span>'
      + (td.due_date ? ' <span class="wb-td-due">' + esc(tdDueLabel(td)) + '</span>' : '')
      + (td.repeat && td.due_date ? ' <span class="wb-td-repeat">' + esc(tdRepeatLabel(td)) + '</span>' : '')
      + (withItem ? ' <button type="button" class="wb-linklike" data-wb-act="td-item" data-wb-item-id="' + escA(td.work_item_id) + '">'
        + esc(td.item_title || '') + '</button>' : '')
      + ics
      + (td.repeat && !done && !archived() ? ' <button type="button" class="wb-linklike" data-wb-act="td-norepeat" data-wb-todo="' + escA(td.id) + '"' + ro + '>'
        + esc(t('workbench.td.repeat_stop')) + '</button>' : '')
      + (archived() ? '' : ' <button type="button" class="wb-linklike" data-wb-act="td-delete" data-wb-todo="' + escA(td.id) + '"' + ro + '>'
        + esc(t('workbench.td.delete')) + '</button>')
      + '</div></li>'
  }

  /** A szerkesztoben: a kivalasztott munkadarab teendoi + uj teendo. */
  function todosBoxHtml() {
    if (!WB.detail) return ''
    var id = WB.detail.item.id
    var body
    if (WB.tdError) body = '<p class="wb-error">' + esc(WB.tdError) + '</p>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-retry">' + esc(t('workbench.tpl.retry')) + '</button>'
    else if (WB.todos === null) body = '<p class="wb-hint">' + esc(t('workbench.td.loading')) + '</p>'
    else {
      var mine = WB.todos.filter(function (x) { return x.work_item_id === id })
      body = mine.length
        ? '<ul class="wb-td-list">' + mine.map(function (x) { return tdRowHtml(x, false) }).join('') + '</ul>'
        : '<p class="wb-hint">' + esc(t('workbench.td.empty_item')) + '</p>'
    }
    var form = archived() ? '' : '<form id="wbTdForm" class="wb-td-form">'
      + '<input class="wb-input" id="wbTdText" type="text" maxlength="300" placeholder="' + escA(t('workbench.td.placeholder')) + '"'
      + ' aria-label="' + escA(t('workbench.td.text_label')) + '">'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.due_label'))
      + ' <input class="wb-input" id="wbTdDue" type="date"></label>'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.repeat_label'))
      + ' <select class="wb-input" id="wbTdRepeat">'
      + '<option value="">' + esc(t('workbench.td.repeat_none')) + '</option>'
      + '<option value="weekly">' + esc(t('workbench.td.repeat_weekly')) + '</option>'
      + '<option value="monthly">' + esc(t('workbench.td.repeat_monthly')) + '</option>'
      + '</select></label>'
      + '<button type="submit" class="btn-primary"' + (WB.tdBusy ? ' disabled' : '') + '>' + esc(t('workbench.td.add')) + '</button>'
      + '</form>'
    return '<details class="wb-td-box" open><summary>' + esc(t('workbench.td.title_item')) + '</summary>' + form + body + '</details>'
  }

  // ---- teendo-emlekezteto (#406, otlet a5ecabbe) ------------------------------
  // Csak a tulajdonos SAJAT csatornajara megy. A panel megmondja, ha nincs hova.

  function loadReminder() {
    return api('GET', '/api/workbench/todo-reminder').then(function (r) {
      if (!r.ok) { WB.tdRemError = r.message; WB.tdRem = null; render(); return }
      WB.tdRemError = null
      WB.tdRem = (r.data && r.data.reminder) || null
      render()
    })
  }

  function tdTimeText(sec) {
    try { return new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch (_e) { return String(sec) }
  }

  function reminderBoxHtml() {
    if (WB.tdRemError) {
      return '<div class="wb-td-rem"><p class="wb-error">' + esc(WB.tdRemError) + '</p>'
        + '<button type="button" class="btn-secondary" data-wb-act="td-rem-retry">' + esc(t('workbench.tpl.retry')) + '</button></div>'
    }
    var rm = WB.tdRem
    if (!rm) return '<div class="wb-td-rem"><p class="wb-hint">' + esc(t('workbench.td.rem.loading')) + '</p></div>'
    var ro = archived() || WB.tdRemBusy ? ' disabled' : ''
    var days = [0, 1, 2, 3, 7].map(function (n) {
      return '<option value="' + n + '"' + (rm.days_before === n ? ' selected' : '') + '>' + esc(t('workbench.td.rem.days_' + n)) + '</option>'
    }).join('')
    var status
    if (rm.channel !== 'ok') status = '<p class="wb-hint wb-td-rem-warn">' + esc(t('workbench.td.rem.no_channel')) + '</p>'
    else if (rm.last_error) status = '<p class="wb-error">' + esc(t('workbench.td.rem.last_error', { when: tdTimeText(rm.last_error_at || 0) })) + ' ' + esc(rm.last_error) + '</p>'
    else if (rm.last_sent_at) status = '<p class="wb-hint">' + esc(t('workbench.td.rem.last_sent', { when: tdTimeText(rm.last_sent_at) })) + '</p>'
    else status = '<p class="wb-hint">' + esc(t('workbench.td.rem.never_sent')) + '</p>'
    return '<details class="wb-td-rem"' + (rm.channel !== 'ok' ? ' open' : '') + '><summary>'
      + esc(rm.enabled ? t('workbench.td.rem.summary_on', { time: rm.time, when: t('workbench.td.rem.days_' + rm.days_before) }) : t('workbench.td.rem.summary_off'))
      + '</summary>'
      + '<p class="wb-hint">' + esc(t('workbench.td.rem.intro')) + '</p>'
      + '<div class="wb-td-form">'
      + '<label class="wb-td-date-label"><input type="checkbox" id="wbTdRemOn"' + (rm.enabled ? ' checked' : '') + ro + '> ' + esc(t('workbench.td.rem.enabled')) + '</label>'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.rem.when')) + ' <select class="wb-input" id="wbTdRemDays"' + ro + '>' + days + '</select></label>'
      + '<label class="wb-td-date-label">' + esc(t('workbench.td.rem.at')) + ' <input class="wb-input" id="wbTdRemTime" type="time" value="' + escA(rm.time) + '"' + ro + '></label>'
      + '<button type="button" class="btn-primary" data-wb-act="td-rem-save"' + ro + '>' + esc(t('workbench.td.rem.save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-rem-test"' + (WB.tdRemBusy ? ' disabled' : '') + '>' + esc(t('workbench.td.rem.test')) + '</button>'
      + '</div>'
      + status
      + '</details>'
  }

  function reminderRequest(method, url, body, okKey) {
    if (WB.tdRemBusy) return
    WB.tdRemBusy = true
    render()
    return api(method, url, body).then(function (r) {
      WB.tdRemBusy = false
      if (!r.ok) {
        var detail = r.data && r.data.detail ? ' ' + r.data.detail : ''
        window.showToast(r.message + detail)
        render()
        return loadReminder()
      }
      window.showToast(t(okKey))
      if (r.data && r.data.reminder) { WB.tdRem = r.data.reminder; render(); return }
      return loadReminder()
    })
  }

  function saveReminderFromForm() {
    var on = document.getElementById('wbTdRemOn')
    var days = document.getElementById('wbTdRemDays')
    var time = document.getElementById('wbTdRemTime')
    var body = { enabled: !!(on && on.checked) }
    if (days && days.value !== undefined && days.value !== '') body.days_before = Number(days.value)
    if (time && time.value) body.time = time.value
    reminderRequest('PUT', '/api/workbench/todo-reminder', body, 'workbench.td.rem.saved')
  }

  /** Eszkozsor-panel: a projekt MINDEN teendoje, lejart / ma / kozelgo / hatarido nelkul / kesz. */
  function todosPanelHtml() {
    if (!WB.tdOpen) return ''
    var body = ''
    if (WB.tdError) {
      body = '<p class="wb-error">' + esc(WB.tdError) + '</p>'
        + '<button type="button" class="btn-secondary" data-wb-act="td-retry">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (WB.todos === null) {
      body = '<p class="wb-hint">' + esc(t('workbench.td.loading')) + '</p>'
    } else if (!WB.todos.length) {
      body = '<p class="wb-hint">' + esc(t('workbench.td.empty_project')) + '</p>'
    } else {
      var groups = { overdue: [], today: [], upcoming: [], nodate: [], done: [] }
      WB.todos.forEach(function (x) {
        if (x.done_at != null) groups.done.push(x)
        else if (!x.due_date) groups.nodate.push(x)
        else groups[tdDueState(x)].push(x)
      })
      var hasDue = groups.overdue.length + groups.today.length + groups.upcoming.length > 0
      body = (hasDue ? '<p><a class="btn-secondary wb-td-ics-all" href="/api/workbench/todos/ics?project=' + encodeURIComponent(WB.projectId)
        + '&lang=' + encodeURIComponent(window._lang || 'hu') + '" download>' + esc(t('workbench.td.all_to_calendar')) + '</a></p>' : '')
        + ['overdue', 'today', 'upcoming', 'nodate', 'done'].map(function (g) {
          if (!groups[g].length) return ''
          return '<h3 class="wb-search-group">' + esc(t('workbench.td.group.' + g, { n: groups[g].length })) + '</h3>'
            + '<ul class="wb-td-list">' + groups[g].map(function (x) { return tdRowHtml(x, true) }).join('') + '</ul>'
        }).join('')
    }
    return '<section class="wb-caps-panel wb-td-panel" id="wbTdPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.td.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.td.intro')) + '</p>'
      + reminderBoxHtml()
      + body
      + '</section>'
  }

  function tdRequest(method, url, body, toastKey) {
    if (WB.tdBusy) return
    var pid = WB.projectId
    WB.tdBusy = true
    render()
    return api(method, url, body).then(function (r) {
      WB.tdBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (toastKey === 'add') {
        var el = document.getElementById('wbTdText'); if (el) el.value = ''
        var d = document.getElementById('wbTdDue'); if (d) d.value = ''
        var rp = document.getElementById('wbTdRepeat'); if (rp) rp.value = ''
      }
      // Ismetlodo teendo kipipalasa: megmondjuk, mikorra jott a kovetkezo.
      var nx = toastKey === 'done' && r.data && r.data.next
      window.showToast(nx && nx.due_date
        ? t('workbench.td.toast.done_next', { date: tdDateText(nx.due_date, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) })
        : t('workbench.td.toast.' + toastKey))
      return loadTodos(pid)
    })
  }

  function addTodoFromForm() {
    if (!WB.detail) return
    var el = document.getElementById('wbTdText')
    var text = el && typeof el.value === 'string' ? el.value.trim() : ''
    if (!text) { window.showToast(t('workbench.td.empty_text')); return }
    var due = document.getElementById('wbTdDue')
    var rp = document.getElementById('wbTdRepeat')
    var repeat = (rp && rp.value) || ''
    if (repeat && !(due && due.value)) { window.showToast(t('workbench.td.repeat_needs_due')); return }
    tdRequest('POST', '/api/workbench/todos', { item_id: WB.detail.item.id, text: text, due_date: (due && due.value) || '', repeat: repeat }, 'add')
  }

  // ---- projekt-attekinto (#406, 2. pont) -------------------------------------

  function loadOverview(projectId) {
    return api('GET', '/api/workbench/overview?project=' + encodeURIComponent(projectId)).then(function (r) {
      if (WB.projectId !== projectId) return
      if (!r.ok) { WB.overviewError = r.message; render(); return }
      WB.overviewError = null
      WB.overview = (r.data && r.data.overview) || null
      render()
    })
  }

  function ovItemsHtml(items) {
    if (!items || !items.length) return ''
    return '<ul class="wb-ov-list">' + items.map(function (it) {
      return '<li><button type="button" class="wb-linklike" data-wb-item="' + escA(it.id) + '">' + esc(it.title) + '</button></li>'
    }).join('') + '</ul>'
  }

  function ovTile(cls, title, count, body) {
    return '<div class="wb-ov-tile ' + cls + '">'
      + '<div class="wb-ov-title">' + esc(title) + '</div>'
      + (count === null ? '' : '<div class="wb-ov-num">' + esc(String(count)) + '</div>')
      + body + '</div>'
  }

  /** Egy pillantasra: nyitott, jovahagyasra var, friss kesz, utoljara valtozott
   *  fajl. Minden szam MERT: ha egy forras nem valaszolt, azt kimondjuk, es a
   *  helyere nem irunk nullat. */
  function overviewHtml() {
    if (WB.overviewError) {
      return '<section class="wb-ov" aria-label="' + escA(t('workbench.ov.title')) + '">'
        + '<p class="wb-preview-bad">' + esc(t('workbench.ov.error', { message: WB.overviewError })) + '</p></section>'
    }
    // Minden jovahagyas KULON kis kartya: sorszam + cim + datum, ahogy a
    // kanban-tablan (Boss, 2026-09-26, TG 6535: "ez a kettő olyan, mintha egy
    // lenne"). Kartya nelkuli jegynel a leiras elso sora a cim.
    function ovApprovalHtml(a) {
      var head = a.card_seq
        ? '<span class="wb-ov-apv-seq">#' + esc(String(a.card_seq)) + '</span> ' + esc(a.card_title || a.description)
        : esc(a.description)
      return '<li class="wb-ov-approval">'
        + '<span class="wb-ov-apv-title">' + head + '</span>'
        + (a.requested_at ? '<span class="wb-ov-apv-when">' + esc(t('workbench.ov.apv_when', { when: when(a.requested_at) })) + '</span>' : '')
        + '</li>'
    }
    var o = WB.overview
    if (!o) return '<section class="wb-ov"><p class="wb-muted">' + esc(t('workbench.ov.loading')) + '</p></section>'

    var cards = o.cards || {}
    var openBody = ovItemsHtml(o.open && o.open.items)
      + (cards.open === null
        ? '<p class="wb-hint wb-preview-bad">' + esc(t('workbench.ov.cards_unknown', { message: cards.error || '' })) + '</p>'
        : '<p class="wb-hint">' + esc(t('workbench.ov.cards_open', { n: cards.open || 0 })) + '</p>')
      + (o.open && o.open.count ? '' : '<p class="wb-hint">' + esc(t('workbench.ov.open_none')) + '</p>')

    var ap = o.approvals || {}
    var reviewCount = (o.review && o.review.count) || 0
    var waitBody = ovItemsHtml(o.review && o.review.items)
      + (ap.count === null
        ? '<p class="wb-hint wb-preview-bad">' + esc(t('workbench.ov.approvals_unknown', { message: ap.error || '' })) + '</p>'
        : (ap.items && ap.items.length
          ? '<ul class="wb-ov-list wb-ov-approvals">' + ap.items.map(ovApprovalHtml).join('') + '</ul>'
          : ''))
      + (reviewCount || ap.count ? '' : '<p class="wb-hint">' + esc(t('workbench.ov.wait_none')) + '</p>')
      + (ap.count ? '<p><button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.ov.goto_approvals')) + '</button></p>' : '')
    var waitCount = ap.count === null ? null : reviewCount + (ap.count || 0)

    var rd = o.recent_done || {}
    var doneBody = ovItemsHtml(rd.items)
      + (rd.count ? '' : '<p class="wb-hint">' + esc(t('workbench.ov.done_none', { days: rd.days || 14 })) + '</p>')

    var lf = o.last_file
    var fileBody = lf
      ? '<p class="wb-ov-file">' + esc(lf.name) + '</p>'
        + '<p class="wb-hint">' + esc(t('workbench.ov.file_in', { when: when(lf.at) })) + ' '
        + '<button type="button" class="wb-linklike" data-wb-item="' + escA(lf.item_id) + '">' + esc(lf.item_title) + '</button></p>'
      : '<p class="wb-hint">' + esc(t('workbench.ov.file_none')) + '</p>'

    return '<section class="wb-ov" aria-label="' + escA(t('workbench.ov.title')) + '">'
      + ovTile('wb-ov-open', t('workbench.ov.open'), (o.open && o.open.count) || 0, openBody)
      + ovTile('wb-ov-wait' + (waitCount ? ' wb-ov-attn' : ''), t('workbench.ov.wait'), waitCount, waitBody)
      + ovTile('wb-ov-done', t('workbench.ov.done', { days: rd.days || 14 }), rd.count || 0, doneBody)
      + ovTile('wb-ov-file-tile', t('workbench.ov.file'), null, fileBody)
      + '</section>'
  }

  /** Egy munkadarab lesz az aktualis: kozepen az o szerkesztoje, a chat az o
   *  beszelgetese. A lista, a valto es a lepteto gombok mind ezt hivjak. */
  function selectItem(id) {
    if (!id) return
    WB.selectedId = id
    WB.panel = 'editor'
    // Mas munkadarab: a felig nyitott resz-szerkesztes nem szivaroghat at.
    WB.partEdit = null
    WB.partNewOpen = false
    loadDetail(WB.selectedId)
    // Mas munkadarab = MAS beszelgetes: a hozza tartozot toltjuk be.
    loadChatHistory()
  }

  function loadDetail(id) {
    WB.detail = null
    WB.textEdit = null
    if (WB.img && WB.img.itemId !== id) WB.img = null
    if (WB.compare && WB.compare.itemId !== id) WB.compare = null
    WB.preview = null
    WB.previewVersion = null
    WB.versionBusy = false
    WB.canvas = null
    WB.canvasError = null
    WB.canvasEdit = null
    // Mas munkadarab = mas vaszon: a kijeloles nem szivaroghat at.
    WB.canvasSel = null
    render()
    loadPreview(id, null)
    return api('GET', '/api/workbench/items/' + encodeURIComponent(id)).then(function (r) {
      if (WB.selectedId !== id) return
      if (!r.ok) { window.showToast(r.message); return }
      WB.detail = r.data
      render()
      // A rajz-fajta munkadarabnal magatol megnezzuk, van-e mar vaszon. Mas
      // fajtanal nem kerdezunk feleslegesen -- ott az elonezet mondja meg, ha
      // megis rajz all mogotte.
      if (canvasKind(r.data && r.data.item)) loadCanvas(id)
    })
  }

  // ---- panelek --------------------------------------------------------------

  /** Archivalt projektben nem keletkezik uj munkadarab -- a meglevok latszanak. */
  function archived() { return !!(WB.project && WB.project.archived) }

  function typeLabel(type) { return t('workbench.type.' + type) }
  function statusLabel(status) { return t('workbench.status.' + status) }

  function itemsPanelHtml() {
    var body
    if (WB.items === null) {
      body = '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    } else if (WB.error) {
      body = '<div class="info-box depo-bad">' + esc(WB.error) + '</div>'
    } else if (!WB.items.length) {
      body = '<div class="wb-empty">'
        + '<p class="wb-empty-title">' + esc(t('workbench.empty.title')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.empty.hint')) + '</p>'
        + '</div>'
    } else {
      body = '<ul class="wb-items">' + WB.items.map(function (it, i) {
        var on = it.id === WB.selectedId
        // A csillag KULON gomb a sorban (gombba gomb nem agyazhato), es nem
        // data-wb-item: a kattintas nem nyitja meg a munkadarabot (#406, 21bcb1f4).
        var pinned = it.pinned_at != null
        var pinLabel = t(pinned ? 'workbench.pin.remove' : 'workbench.pin.add')
        return '<li class="wb-item-row' + (pinned ? ' wb-item-pinned' : '') + '">'
          + '<button type="button" class="wb-item-pin" data-wb-act="item-pin" data-wb-pin="' + escA(it.id) + '" aria-pressed="' + pinned + '"'
          + ' aria-label="' + escA(pinLabel) + '" title="' + escA(pinLabel) + '"' + (archived() || WB.pinBusy ? ' disabled' : '') + '>'
          + (pinned ? '★' : '☆') + '</button>'
          + '<button type="button" class="wb-item' + (on ? ' wb-item-active' : '') + '" data-wb-item="' + escA(it.id) + '"' + (on ? ' aria-current="true"' : '') + '>'
          + '<span class="wb-item-title">' + esc((i + 1) + '. ' + it.title) + '</span>'
          + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span>'
          + '</button></li>'
      }).join('') + '</ul>'
    }
    return '<section class="wb-panel wb-panel-items' + (WB.panel === 'items' ? ' wb-panel-current' : '') + '" data-wb-panel-body="items" data-wb-drop="new">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.items')) + (WB.items && WB.items.length ? ' (' + WB.items.length + ')' : '') + '</h2>'
      + '<p class="wb-hint">' + esc(t(WB.layout === 'split' ? 'workbench.items.switch_hint_split' : 'workbench.items.switch_hint')) + '</p>'
      + body
      + (archived()
        ? '<p class="wb-hint">' + esc(t('workbench.archived_hint')) + '</p>'
        : (WB.formOpen ? newFormHtml() : '<button type="button" class="btn-primary wb-new-btn" data-wb-act="new">' + esc(t('workbench.new_item')) + '</button>')
          + templatesHtml()
          + uploadZoneHtml())
      + '</section>'
  }

  // ---- behuzas es feltoltes (#406, 3. pont) ----------------------------------
  //
  // Harom ut vezet ugyanoda: (1) fajl ráhúzása a Munkapadra, (2) a "Fajlok
  // kivalasztasa" gomb -- telefonon ez nyitja a galeriat / kamerat --, es
  // (3) beillesztes (Ctrl+V) a vagolaprol. A fajl a PROJEKT mappajaba kerul,
  // sosem ir felul semmit (foglalt nevnel uj nevet kap).
  //
  // HOVA: a munkadarab-listara (vagy barhova mashova) ejtve UJ munkadarab lesz
  // belole; a megnyitott munkadarabra ejtve abba kerul -- a kep uj RESZ lesz,
  // mas fajl uj VERZIO.

  function uploadZoneHtml() {
    var busy = WB.upload
    return '<div class="wb-drop">'
      + '<p class="wb-drop-text">' + esc(busy
        ? t('workbench.upload.progress', { done: busy.done, total: busy.total })
        : t('workbench.upload.drop_new')) + '</p>'
      + '<label class="btn-secondary wb-part-upload" for="wbUploadNew">' + esc(t('workbench.upload.pick')) + '</label>'
      + '<input type="file" id="wbUploadNew" class="wb-file-input" multiple>'
      + '<p class="wb-hint">' + esc(t('workbench.upload.hint')) + '</p>'
      + '</div>'
  }

  /** Nyers bajtok a szervernek; a valasz mindig {ok, data, message}. A
   *  hibanal a SZERVER mondata megy tovabb (a gepi kod csak tartalek). */
  function postFile(url, file) {
    return fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        if (!res.ok) return { ok: false, data: data, message: (data && data.message) || t('workbench.err.http', { status: res.status }) }
        return { ok: true, data: data }
      })
    }).catch(function () { return { ok: false, message: t('workbench.err.network') } })
  }

  function isImageFile(f) {
    if (f && typeof f.type === 'string' && f.type.indexOf('image/') === 0) return true
    return /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test((f && f.name) || '')
  }

  /** `target === 'item'`: a megnyitott munkadarabba (kep -> resz, mas -> uj
   *  verzio). Kulonben minden fajlbol UJ munkadarab. Egymas utan megy, hogy a
   *  szamlalo pontos legyen, es egy hiba ne vigye el a tobbit. */
  function uploadFiles(fileList, target) {
    var files = []
    for (var i = 0; fileList && i < fileList.length; i++) if (fileList[i]) files.push(fileList[i])
    if (!files.length || WB.upload || !WB.projectId) return Promise.resolve()
    if (archived()) { window.showToast(t('workbench.archived_hint')); return Promise.resolve() }
    var intoItem = target === 'item' && WB.selectedId ? WB.selectedId : null
    var projectId = WB.projectId
    var lang = encodeURIComponent(window._lang || 'hu')
    WB.upload = { done: 0, total: files.length }
    render()
    var created = []
    var errors = []
    var chain = Promise.resolve()
    files.forEach(function (f) {
      chain = chain.then(function () {
        var name = encodeURIComponent(f.name || 'fajl')
        var type = encodeURIComponent(f.type || '')
        var url
        if (intoItem) {
          url = '/api/workbench/items/' + encodeURIComponent(intoItem)
            + (isImageFile(f) ? '/parts/image?new_version=1&' : '/document?')
            + 'name=' + name + '&type=' + type + '&lang=' + lang
        } else {
          url = '/api/workbench/items/upload?project=' + encodeURIComponent(projectId)
            + '&name=' + name + '&type=' + type + '&lang=' + lang
        }
        return postFile(url, f).then(function (r) {
          if (WB.upload) WB.upload.done++
          if (!r.ok) errors.push((f.name ? f.name + ': ' : '') + r.message)
          else if (!intoItem && r.data && r.data.item) created.push(r.data.item)
          if (WB.projectId === projectId) render()
        })
      })
    })
    return chain.then(function () {
      WB.upload = null
      if (WB.projectId !== projectId) return
      var ok = files.length - errors.length
      if (errors.length) window.showToast(errors.join(' \u2014 '))
      if (ok) {
        window.showToast(intoItem
          ? t('workbench.upload.done_item', { n: ok })
          : t('workbench.upload.done_new', { n: ok }))
      }
      if (intoItem) {
        if (WB.selectedId === intoItem) loadDetail(intoItem)
        load(projectId)
      } else {
        load(projectId)
        // Egy fajl = egy uj munkadarab: azt nyitjuk meg, hogy latsszon.
        if (created.length === 1) selectItem(created[0].id)
        else render()
      }
    })
  }

  function hasFiles(e) {
    var dt = e && e.dataTransfer
    if (!dt) return false
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true
    }
    return !!(dt.files && dt.files.length)
  }

  function inWorkbench(e) {
    return !!(e && e.target && typeof e.target.closest === 'function' && e.target.closest('.wb-root'))
  }

  function dropTarget(e) {
    var zone = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-wb-drop]') : null
    var kind = zone && typeof zone.getAttribute === 'function' ? zone.getAttribute('data-wb-drop') : null
    return kind === 'item' && WB.selectedId ? 'item' : 'new'
  }

  function setDragging(on) {
    var el = root()
    var box = el && typeof el.querySelector === 'function' ? el.querySelector('.wb-root') : null
    if (box && box.classList) box.classList.toggle('wb-dragging', !!on)
  }

  function newFormHtml() {
    var types = ['document', 'image', 'graphic', 'video', 'note']
    return '<form class="wb-form" id="wbNewForm">'
      + '<label class="wb-label" for="wbNewTitle">' + esc(t('workbench.new.name_label')) + '</label>'
      + '<input class="wb-input" id="wbNewTitle" type="text" maxlength="200" placeholder="' + escA(t('workbench.new.name_placeholder')) + '" autocomplete="off">'
      + '<label class="wb-label" for="wbNewType">' + esc(t('workbench.new.type_label')) + '</label>'
      + '<select class="wb-input" id="wbNewType">'
      + types.map(function (ty) { return '<option value="' + escA(ty) + '">' + esc(typeLabel(ty)) + '</option>' }).join('')
      + '</select>'
      + '<p class="wb-hint">' + esc(t('workbench.new.type_hint')) + '</p>'
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="create"' + (WB.busy ? ' disabled' : '') + '>'
      + esc(WB.busy ? t('workbench.new.creating') : t('workbench.new.create')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="cancel-new">' + esc(t('common.cancel')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.table.new_hint')) + '</p>'
      + '<div class="wb-form-actions"><button type="button" class="btn-secondary" data-wb-act="create-table"' + (WB.busy ? ' disabled' : '') + '>'
      + esc(t('workbench.table.new')) + '</button></div>'
      + '</form>'
  }

  // ---- sablonok (#406, 11. pont) --------------------------------------------
  //
  // Egy kattintas: uj munkadarab, a szerkezet mar benne (ajanlat, level,
  // kozossegi poszt, meghivo). A sablonok a szerverrol jonnek a felulet
  // nyelven; friss telepitesen is ott vannak, nincs mit beallitani.

  function loadTemplates() {
    var lang = window._lang || 'hu'
    return api('GET', '/api/workbench/templates').then(function (r) {
      if (!r.ok) { WB.templatesError = r.message; render(); return }
      WB.templatesError = null
      WB.templates = (r.data && r.data.templates) || []
      WB.templatesLang = lang
      render()
    })
  }

  function templatesHtml() {
    var body
    if (WB.templatesError) {
      body = '<div class="info-box depo-bad">' + esc(t('workbench.tpl.load_failed', { error: WB.templatesError })) + '</div>'
        + '<button type="button" class="btn-secondary" data-wb-act="tpl-retry">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (WB.templates === null) {
      body = '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    } else if (!WB.templates.length) {
      body = '<p class="wb-muted">' + esc(t('workbench.tpl.none')) + '</p>'
    } else {
      body = '<div class="wb-tpl-list">' + WB.templates.map(function (tp) {
        var busy = WB.tplBusy === tp.id
        return '<button type="button" class="wb-tpl-btn" data-wb-act="tpl-use" data-wb-tpl="' + escA(tp.id) + '"'
          + (WB.tplBusy ? ' disabled' : '') + ' title="' + escA(tp.description) + '">'
          + '<span class="wb-tpl-name">' + esc(busy ? t('workbench.tpl.creating') : tp.name) + '</span>'
          + '<span class="wb-tpl-desc">' + esc(tp.description) + '</span>'
          + '</button>'
      }).join('') + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.tpl.hint')) + '</p>'
    }
    return '<div class="wb-tpl">'
      + '<p class="wb-label">' + esc(t('workbench.tpl.title')) + '</p>'
      + body
      + '</div>'
  }

  function useTemplate(id) {
    if (!id || WB.tplBusy || archived()) return
    WB.tplBusy = id
    render()
    api('POST', '/api/workbench/templates/use', { project_id: WB.projectId, template: id }).then(function (r) {
      WB.tplBusy = null
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      window.showToast(t('workbench.tpl.created', { title: r.data.item.title }))
      // Rogton megnyitjuk: a szerkezet mar ott van, lehet atirni.
      selectItem(r.data.item.id)
      load(WB.projectId)
    })
  }

  // ---- reszek: VEGYES munkadarab (3. fazis) ---------------------------------
  //
  // Boss, 2026-09-21: "egy munkadarabban lehet egyszerre kep ES szoveg (pl.
  // Facebook-poszt: foto + iras)". A jovahagyott irany a kompozit modell: a
  // munkadarab KONTENER, a tartalom RESZEKBOL all. A fajta csak cimke.

  function partsOf() { return (WB.detail && WB.detail.parts) || [] }

  /** A kep megjelenitese a MEGLEVO fajl-kiszolgalon at (Intezo, #164) -- nem
   *  masoljuk be a bajtokat sehova. A parameter neve `rel` (NEM `path`): a
   *  `/api/life/file` ezt olvassa, a `path`-szal 404-et adna vissza. */
  function partImageSrc(part) {
    return '/api/life/file?rel=' + encodeURIComponent(part.asset_path || '')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
  }

  function partBodyHtml(part) {
    if (WB.partEdit === part.id) {
      var value = WB.partDraft && WB.partDraft.id === part.id
        ? WB.partDraft.value
        : (part.kind === 'text' ? (part.text || '') : (part.caption || ''))
      return '<form class="wb-part-form" id="wbPartForm">'
        + (part.kind === 'image'
          ? '<label class="wb-label" for="wbPartText">' + esc(t('workbench.parts.caption_label')) + '</label>'
          : '')
        + '<textarea class="wb-input wb-part-input" id="wbPartText" rows="' + (part.kind === 'text' ? 6 : 2) + '"'
        + ' placeholder="' + escA(t(part.kind === 'text' ? 'workbench.parts.text_placeholder' : 'workbench.parts.caption_placeholder')) + '">'
        + esc(value) + '</textarea>'
        + '<div class="wb-form-actions">'
        + '<button type="submit" class="btn-primary" data-wb-act="part-save" data-wb-part="' + escA(part.id) + '"' + (WB.partBusy ? ' disabled' : '') + '>'
        + esc(WB.partBusy ? t('workbench.parts.saving') : t('workbench.parts.save')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="part-cancel">' + esc(t('common.cancel')) + '</button>'
        + '</div></form>'
    }
    if (part.kind === 'image') {
      return '<img class="wb-part-image" src="' + escA(partImageSrc(part)) + '" alt="' + escA(part.caption || t('workbench.parts.image_alt')) + '">'
        + '<p class="' + (part.caption ? 'wb-part-caption' : 'wb-muted') + '">'
        + esc(part.caption || t('workbench.parts.no_caption')) + '</p>'
    }
    return '<p class="wb-part-text">' + esc(part.text || '') + '</p>'
  }

  function partHtml(part, index, total) {
    // Archivalt projekt = CSAK OLVASHATO: a szerkeszto gombok el sem keszulnek,
    // hogy ne kinaljunk olyat, amit a szerver ugyis visszautasit.
    var tools = archived() ? '' : ('<span class="wb-part-tools">'
      + '<button type="button" class="wb-part-btn" data-wb-act="part-up" data-wb-part="' + escA(part.id) + '"'
      + (index === 0 ? ' disabled' : '') + ' title="' + escA(t('workbench.parts.up')) + '">&uarr;</button>'
      + '<button type="button" class="wb-part-btn" data-wb-act="part-down" data-wb-part="' + escA(part.id) + '"'
      + (index === total - 1 ? ' disabled' : '') + ' title="' + escA(t('workbench.parts.down')) + '">&darr;</button>'
      + '<button type="button" class="wb-part-btn" data-wb-act="part-edit" data-wb-part="' + escA(part.id) + '">'
      + esc(t('workbench.parts.edit')) + '</button>'
      + '<button type="button" class="wb-part-btn wb-part-btn-bad" data-wb-act="part-remove" data-wb-part="' + escA(part.id) + '">'
      + esc(t('workbench.parts.remove')) + '</button>'
      + '</span>')
    return '<li class="wb-part" data-wb-part-row="' + escA(part.id) + '">'
      + '<div class="wb-part-head">'
      + '<span class="wb-pill">' + esc(t(part.kind === 'image' ? 'workbench.parts.image_kind' : 'workbench.parts.text_kind')) + '</span>'
      + tools + '</div>'
      + partBodyHtml(part)
      + '</li>'
  }

  /** Kimondjuk, hogy a mentes nem ir felul semmit -- es hol tartunk. */
  function editVersionHintHtml() {
    if (archived() || !WB.detail) return ''
    var cur = null
    var it = WB.detail.item
    ;(WB.detail.versions || []).forEach(function (v) { if (it && v.id === it.current_version_id) cur = v })
    return '<p class="wb-hint wb-edit-hint">' + esc(cur
      ? t('workbench.edit.hint_n', { n: cur.version_no })
      : t('workbench.edit.hint')) + '</p>'
  }

  function partsHtml() {
    var parts = partsOf()
    var list = parts.length
      ? '<ul class="wb-parts">' + parts.map(function (p, i) { return partHtml(p, i, parts.length) }).join('') + '</ul>'
      : '<p class="wb-muted wb-parts-empty">' + esc(t('workbench.parts.empty')) + '</p>'
    var adder = WB.partNewOpen
      ? '<form class="wb-part-form" id="wbPartNewForm">'
        + '<textarea class="wb-input wb-part-input" id="wbPartNewText" rows="5" placeholder="'
        + escA(t('workbench.parts.text_placeholder')) + '"></textarea>'
        + '<div class="wb-form-actions">'
        + '<button type="submit" class="btn-primary" data-wb-act="part-add-text"' + (WB.partBusy ? ' disabled' : '') + '>'
        + esc(WB.partBusy ? t('workbench.parts.saving') : t('workbench.parts.save')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="part-cancel">' + esc(t('common.cancel')) + '</button>'
        + '</div></form>'
      : ''
    return '<div class="wb-parts-block">'
      + editVersionHintHtml()
      + '<h4 class="wb-parts-title">' + esc(t('workbench.parts.title'))
      + (parts.length ? ' <span class="wb-muted">(' + esc(parts.length === 1 ? t('workbench.parts.count_one') : t('workbench.parts.count', { n: parts.length })) + ')</span>' : '')
      + '</h4>'
      + list
      + adder
      + (archived() ? '' : '<div class="wb-part-actions">'
        + '<button type="button" class="btn-secondary" data-wb-act="part-new-text">' + esc(t('workbench.parts.add_text')) + '</button>'
        + '<label class="btn-secondary wb-part-upload" for="wbPartImage">' + esc(WB.partBusy ? t('workbench.parts.uploading') : t('workbench.parts.add_image')) + '</label>'
        + '<input type="file" id="wbPartImage" accept="image/*" class="wb-file-input">'
        + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.parts.image_hint')) + '</p>')
      + '</div>'
  }

  // ---- elonezet (4. fazis) ---------------------------------------------------
  //
  // A bajtokat a MEGLEVO fajl-kiszolgalo adja (`/api/life/file?rel=`), a PDF-et
  // maga a bongeszo jeleniti meg: igy friss telepitesen, halozat nelkul is megy,
  // es nincs uj csomag-fuggoseg. Ami nem mutathato meg, arra EMBERI mondat jon
  // a szervertol -- es kulon mondat arra, ha "nem latok oda" (nincs Raktar,
  // nincs projektmappa, eltunt a fajl), mint arra, ha "meg nincs semmi".
  /** `keep === true`: a MOSTANI elonezet a helyen marad, amig az uj meg nem
   *  jon. Ez akkor helyes, ha UGYANARROL a munkadarabrol kerunk friss adatot
   *  (pl. a vaszon egy muvelete utan): kulonben a kep es a huzogato reteg
   *  minden mozdulat utan eltunne egy pillanatra, es a masodik huzast mar nem
   *  lehetne elkezdeni. Munkadarab- vagy verzio-valtasnal NEM szabad megtartani:
   *  ott a regi kep MAS dolgot mutatna, mint amit a felhasznalo kert. */
  function loadPreview(itemId, versionId, keep) {
    if (!keep) WB.preview = null
    // Az elozo munkadarab atalakitasi hibaja NEM tartozik ehhez: toroljuk.
    WB.convertError = null
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/preview'
      + (versionId ? '?version=' + encodeURIComponent(versionId) + '&' : '?')
      + 'lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        // Kozben mashova kattintott: a regi valasz nem irhatja felul a kepernyot.
        if (WB.selectedId !== itemId) return
        WB.preview = data && typeof data === 'object'
          ? data
          : { available: false, message: t('workbench.err.http', { status: res.status }) }
        render()
      })
    }).catch(function () {
      if (WB.selectedId !== itemId) return
      WB.preview = { available: false, message: t('workbench.err.network') }
      render()
    })
  }

  function previewVersionPickerHtml() {
    var versions = (WB.preview && WB.preview.versions) || (WB.detail && WB.detail.versions) || []
    if (versions.length < 2) return ''
    var cur = WB.previewVersion || (WB.preview && WB.preview.version_id) || ''
    return '<label class="wb-label" for="wbPreviewVersion">' + esc(t('workbench.preview.version_label')) + '</label>'
      + '<select class="wb-input wb-preview-version" id="wbPreviewVersion" data-wb-act="preview-version">'
      + versions.map(function (v) {
        return '<option value="' + escA(v.id) + '"' + (v.id === cur ? ' selected' : '') + '>'
          + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) })) + '</option>'
      }).join('') + '</select>'
  }

  function previewBodyHtml(p) {
    // IRODAI DOKUMENTUM (7. fazis): amit latsz, az a belole keszult PDF -- ezt
    // KI IS MONDJUK, hogy senki ne higgye, hogy a .docx-et szerkeszti itt.
    if (p.kind === 'office') {
      return pdfSlotHtml(p.url)
        + '<p class="wb-hint">' + esc(t('workbench.preview.office_from_pdf')) + '</p>'
        + '<p class="wb-hint"><a href="' + escA(p.url) + '&download=1" target="_blank" rel="noopener">'
        + esc(t('workbench.preview.office_download_pdf')) + '</a>'
        + (p.rel
          ? ' &middot; <a href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
            + esc(t('workbench.preview.office_download_source')) + '</a>'
          : '')
        + '</p>'
    }
    if (p.kind === 'pdf') {
      return pdfSlotHtml(p.url)
        + '<p class="wb-hint"><a href="' + escA(p.url) + '" target="_blank" rel="noopener">' + esc(t('workbench.preview.open_new_tab')) + '</a>'
        + ' &middot; <a href="' + escA(p.url) + '&download=1" target="_blank" rel="noopener">' + esc(t('workbench.preview.download')) + '</a></p>'
    }
    if (p.kind === 'canvas') {
      // A rajzot a SZERVER rajzolja ki SVG-be: a bongeszonek nem kell hozza
      // semmilyen kulso konyvtar, es a letoltott kep ugyanez a kep. A
      // huzogatashoz csak egy ATLATSZO doboz-reteg kerul fole -- a kepet
      // tovabbra sem a bongeszo rajzolja.
      return canvasStageHtml(p.name || t('workbench.preview.title'))
        + '<p class="wb-hint"><a href="' + escA(canvasSvgUrl(WB.selectedId, true)) + '" target="_blank" rel="noopener">'
        + esc(t('workbench.canvas.download')) + '</a></p>'
    }
    if (p.kind === 'image') {
      // KEPSZERKESZTES (#406, 16. pont): csak a mostani verzio, nem archivalt projektben.
      if (imgState()) return imageEditorHtml()
      return (imgCanEdit(p) ? '<p><button type="button" class="btn-primary" data-wb-act="img-open">' + esc(t('workbench.img.open')) + '</button></p>' : '')
        + '<img class="wb-preview-image" src="' + escA(p.url) + '" alt="' + escA(p.name || t('workbench.preview.title')) + '">'
    }
    if (p.kind === 'video') {
      return '<video class="wb-preview-video" src="' + escA(p.url) + '" controls></video>'
    }
    if (p.kind === 'audio') {
      return '<audio class="wb-preview-audio" src="' + escA(p.url) + '" controls></audio>'
    }
    if (p.kind === 'text') {
      if (WB.textEdit && WB.textEdit.itemId === WB.selectedId) return textEditHtml()
      // KOZVETLEN SZERKESZTES (#406, 4. pont): csak a MOSTANI verziot, es csak
      // ha az egeszet latjuk -- a levagott elonezet visszairasa a fajl vegenek
      // elvesztese lenne.
      var current = !WB.previewVersion || (WB.detail && WB.detail.item && WB.previewVersion === WB.detail.item.current_version_id)
      var canEdit = !archived() && !p.truncated && current
      return (canEdit
        ? '<p><button type="button" class="btn-secondary" data-wb-act="text-edit">' + esc(t('workbench.edit.text_open')) + '</button></p>'
        : '')
        + '<pre class="wb-preview-text">' + esc(p.text || '') + '</pre>'
        + (p.truncated ? '<p class="wb-hint">' + esc(t('workbench.preview.truncated')) + '</p>' : '')
        + (!archived() && !current ? '<p class="wb-hint">' + esc(t('workbench.edit.text_old_version')) + '</p>' : '')
    }
    return ''
  }

  function textEditHtml() {
    var busy = WB.textEdit && WB.textEdit.busy
    return '<form class="wb-part-form" id="wbTextEditForm">'
      + '<label class="wb-label" for="wbTextEdit">' + esc(t('workbench.edit.text_label')) + '</label>'
      + '<textarea class="wb-input wb-part-input wb-text-edit" id="wbTextEdit" rows="16">' + esc(WB.textEdit.value) + '</textarea>'
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="text-save"' + (busy ? ' disabled' : '') + '>'
      + esc(busy ? t('workbench.parts.saving') : t('workbench.edit.text_save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="text-cancel">' + esc(t('common.cancel')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.edit.text_hint')) + '</p>'
      + '</form>'
  }

  function openTextEdit() {
    var p = WB.preview
    if (!p || p.kind !== 'text' || p.truncated || archived() || !WB.selectedId) return
    WB.textEdit = { itemId: WB.selectedId, value: p.text || '', busy: false }
    render()
    var el = document.getElementById('wbTextEdit')
    if (el && typeof el.focus === 'function') el.focus()
  }

  function saveTextEdit() {
    if (!WB.textEdit || WB.textEdit.busy || !WB.selectedId) return
    var el = document.getElementById('wbTextEdit')
    if (el && typeof el.value === 'string') WB.textEdit.value = el.value
    var itemId = WB.selectedId
    WB.textEdit.busy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/text', { text: WB.textEdit.value }).then(function (r) {
      if (WB.selectedId !== itemId || !WB.textEdit) return
      WB.textEdit.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.textEdit = null
      applyVersions(r.data)
      window.showToast(t('workbench.edit.text_saved', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
    })
  }

  // ---- TABLAZAT-SZERKESZTES (#406, 15. pont) --------------------------------
  //
  // Az .xlsx / .csv munkadarab racskent: a cellak helyben irhatok, a mentes UJ
  // fajlt es UJ verziot csinal (a szerver foltozza az eredetit, a formazas
  // marad). A racs tartalma az ALLAPOTBAN el (minden gepeles oda megy), igy egy
  // kozben erkezo ujrarajzolas (chat, attekinto) nem torli a begepelt cellat,
  // es a fokuszt is visszatesszuk ugyanarra a cellara.

  var TABLE_PAGE = 100

  function isTableName(name) { return /\.(xlsx|xlsm|csv|tsv)$/i.test(String(name || '')) }

  function tableOpen() { return !!(WB.table && WB.table.itemId === WB.selectedId) }

  function tableEditable() {
    var tb = WB.table
    return !!(tb && tb.data && tb.data.current && !archived())
  }

  function tableSheet() {
    var tb = WB.table
    return tb && tb.sheets ? tb.sheets[tb.sheet] || null : null
  }

  function tableButtonHtml(p) {
    if (!p || !p.rel || !isTableName(p.name)) return ''
    if (!p.available && p.reason !== 'needs_conversion') return ''
    return '<p><button type="button" class="btn-primary" data-wb-act="table-open"' + (WB.table && WB.table.loading ? ' disabled' : '') + '>'
      + esc(t(archived() ? 'workbench.table.open_readonly' : 'workbench.table.open')) + '</button></p>'
  }

  function openTable(itemId, versionId) {
    if (!itemId) return
    WB.table = { itemId: itemId, loading: true, busy: false, data: null, sheets: null, sheet: 0, page: 0, sel: { r: 0, c: 0 }, dirty: false, error: null }
    render()
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/table' + (versionId ? '?version=' + encodeURIComponent(versionId) : '')
    api('GET', url).then(function (r) {
      if (!WB.table || WB.table.itemId !== itemId) return
      WB.table.loading = false
      if (!r.ok) {
        WB.table.error = { message: r.message, detail: r.data && r.data.detail }
        render()
        return
      }
      WB.table.data = r.data
      // Munkapeldany: a szerver valaszat nem irjuk at, igy latszik, mi valtozott.
      WB.table.sheets = (r.data.sheets || []).map(function (s) {
        return { name: s.name, rows: (s.rows || []).map(function (row) { return row.slice() }) }
      })
      if (!WB.table.sheets.length) WB.table.sheets = [{ name: '', rows: [['']] }]
      render()
    })
  }

  function closeTable() {
    if (WB.table && WB.table.dirty && !window.confirm(t('workbench.table.discard_confirm'))) return
    WB.table = null
    render()
  }

  function tableCols(rows) {
    var n = 0
    for (var i = 0; i < rows.length; i++) if (rows[i].length > n) n = rows[i].length
    return n
  }

  function colLetter(i) {
    var n = i + 1
    var s = ''
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
    return s
  }

  function tableTabsHtml() {
    var tb = WB.table
    if (!tb.sheets || tb.sheets.length < 2) return ''
    return '<div class="wb-table-tabs" role="tablist">' + tb.sheets.map(function (s, i) {
      return '<button type="button" role="tab" class="' + (i === tb.sheet ? 'btn-primary' : 'btn-secondary') + '"'
        + ' aria-selected="' + (i === tb.sheet) + '" data-wb-act="table-sheet" data-wb-sheet="' + i + '">' + esc(s.name || String(i + 1)) + '</button>'
    }).join('') + '</div>'
  }

  function tableToolsHtml() {
    if (!tableEditable()) return ''
    var csv = WB.table.data.format === 'csv'
    var b = function (act, key) {
      return '<button type="button" class="btn-secondary" data-wb-act="' + act + '">' + esc(t(key)) + '</button>'
    }
    if (csv) {
      return '<div class="wb-table-tools">'
        + b('table-row-add', 'workbench.table.row_insert')
        + b('table-row-del', 'workbench.table.row_delete')
        + b('table-col-add', 'workbench.table.col_insert')
        + b('table-col-del', 'workbench.table.col_delete')
        + '</div>'
    }
    return '<div class="wb-table-tools">'
      + b('table-row-add', 'workbench.table.row_append')
      + b('table-row-del', 'workbench.table.row_remove_last')
      + b('table-col-add', 'workbench.table.col_append')
      + b('table-col-del', 'workbench.table.col_remove_last')
      + '</div>'
  }

  function tableGridHtml() {
    var sh = tableSheet()
    if (!sh) return ''
    var rows = sh.rows
    var nCols = tableCols(rows)
    var pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE))
    var page = Math.min(WB.table.page, pages - 1)
    WB.table.page = page
    var from = page * TABLE_PAGE
    var to = Math.min(rows.length, from + TABLE_PAGE)
    var ro = tableEditable() ? '' : ' readonly'
    var html = '<div class="wb-table-scroll"><table class="wb-tgrid"><thead><tr><th class="wb-tgrid-corner"></th>'
    for (var c = 0; c < nCols; c++) html += '<th scope="col">' + colLetter(c) + '</th>'
    html += '</tr></thead><tbody>'
    for (var r = from; r < to; r++) {
      html += '<tr><th scope="row">' + (r + 1) + '</th>'
      for (var c2 = 0; c2 < nCols; c2++) {
        var v = rows[r][c2] == null ? '' : rows[r][c2]
        html += '<td><input class="wb-cell" type="text" id="wbCell_' + r + '_' + c2 + '" value="' + escA(v) + '"'
          + ' aria-label="' + escA(colLetter(c2) + (r + 1)) + '"' + ro + '></td>'
      }
      html += '</tr>'
    }
    html += '</tbody></table></div>'
    if (pages > 1) {
      html += '<div class="wb-table-pager">'
        + '<button type="button" class="btn-secondary" data-wb-act="table-page-prev"' + (page === 0 ? ' disabled' : '') + '>' + esc(t('workbench.table.page_prev')) + '</button>'
        + '<span class="wb-muted">' + esc(t('workbench.table.page_info', { from: from + 1, to: to, total: rows.length })) + '</span>'
        + '<button type="button" class="btn-secondary" data-wb-act="table-page-next"' + (page >= pages - 1 ? ' disabled' : '') + '>' + esc(t('workbench.table.page_next')) + '</button>'
        + '</div>'
    }
    return html
  }

  function tableHtml() {
    var tb = WB.table
    if (tb.loading) return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    var close = '<button type="button" class="btn-secondary" data-wb-act="table-close">' + esc(t('workbench.table.close')) + '</button>'
    if (tb.error) {
      return '<div class="wb-table"><p class="wb-preview-bad">' + esc(tb.error.message || '') + '</p>'
        + (tb.error.detail ? '<p class="wb-hint">' + esc(tb.error.detail) + '</p>' : '')
        + '<div class="wb-form-actions">' + close + '</div></div>'
    }
    var d = tb.data
    var hints = []
    if (!d.current) hints.push(t('workbench.table.old_version'))
    else if (archived()) hints.push(t('workbench.table.readonly_archived'))
    else {
      hints.push(t('workbench.table.hint_save'))
      hints.push(t(d.format === 'csv' ? 'workbench.table.hint_csv' : 'workbench.table.hint_xlsx'))
      hints.push(t('workbench.table.hint_formula'))
      if (d.format === 'xlsx') hints.push(t('workbench.table.hint_dates'))
    }
    return '<div class="wb-table">'
      + tableTabsHtml() + tableToolsHtml() + tableGridHtml()
      + '<div class="wb-form-actions">'
      + (tableEditable()
        ? '<button type="button" class="btn-primary" data-wb-act="table-save"' + (tb.busy ? ' disabled' : '') + '>'
          + esc(tb.busy ? t('workbench.parts.saving') : t('workbench.table.save')) + '</button>'
        : '')
      + close + '</div>'
      + hints.map(function (h) { return '<p class="wb-hint">' + esc(h) + '</p>' }).join('')
      + '</div>'
  }

  /** Egy cella tartalma az allapotba (gepeles kozben, ujrarajzolas NELKUL). */
  function tableCellInput(id, value) {
    var m = /^wbCell_(\d+)_(\d+)$/.exec(String(id || ''))
    var sh = tableSheet()
    if (!m || !sh || !tableEditable()) return false
    var r = Number(m[1])
    var c = Number(m[2])
    if (!sh.rows[r]) return false
    sh.rows[r][c] = String(value == null ? '' : value)
    WB.table.sel = { r: r, c: c }
    WB.table.dirty = true
    return true
  }

  function rowHasContent(row) {
    for (var i = 0; i < row.length; i++) if (row[i] !== '' && row[i] != null) return true
    return false
  }

  function tableStructure(what) {
    var sh = tableSheet()
    if (!sh || !tableEditable()) return
    var rows = sh.rows
    var nCols = Math.max(1, tableCols(rows))
    var csv = WB.table.data.format === 'csv'
    var sel = WB.table.sel
    var i
    if (what === 'row-add') {
      var blank = []
      for (i = 0; i < nCols; i++) blank.push('')
      var at = csv ? Math.min(rows.length, sel.r + 1) : rows.length
      rows.splice(at, 0, blank)
      WB.table.sel = { r: at, c: sel.c }
      WB.table.page = Math.floor(at / TABLE_PAGE)
    } else if (what === 'row-del') {
      if (rows.length <= 1) return
      var rIdx = csv ? Math.min(sel.r, rows.length - 1) : rows.length - 1
      if (rowHasContent(rows[rIdx]) && !window.confirm(t('workbench.table.row_delete_confirm', { n: rIdx + 1 }))) return
      rows.splice(rIdx, 1)
      WB.table.sel = { r: Math.max(0, Math.min(rIdx, rows.length - 1)), c: sel.c }
    } else if (what === 'col-add') {
      var cAt = csv ? Math.min(nCols, sel.c + 1) : nCols
      for (i = 0; i < rows.length; i++) {
        while (rows[i].length < nCols) rows[i].push('')
        rows[i].splice(cAt, 0, '')
      }
      WB.table.sel = { r: sel.r, c: cAt }
    } else if (what === 'col-del') {
      if (nCols <= 1) return
      var cIdx = csv ? Math.min(sel.c, nCols - 1) : nCols - 1
      var used = false
      for (i = 0; i < rows.length; i++) if (rows[i][cIdx]) used = true
      if (used && !window.confirm(t('workbench.table.col_delete_confirm', { c: colLetter(cIdx) }))) return
      for (i = 0; i < rows.length; i++) rows[i].splice(cIdx, 1)
      WB.table.sel = { r: sel.r, c: Math.max(0, Math.min(cIdx, nCols - 2)) }
    }
    WB.table.dirty = true
    render()
  }

  function saveTable() {
    var tb = WB.table
    if (!tb || tb.busy || !tableEditable() || !WB.selectedId) return
    var itemId = WB.selectedId
    tb.busy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(itemId) + '/table', {
      base_version: tb.data.version_id,
      sheets: tb.sheets,
      delimiter: tb.data.delimiter,
    }).then(function (r) {
      if (!WB.table || WB.table.itemId !== itemId) return
      WB.table.busy = false
      if (!r.ok) {
        render()
        window.showToast(r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : ''))
        return
      }
      WB.table = null
      applyVersions(r.data)
      window.showToast(t('workbench.table.saved', { n: r.data && r.data.version ? r.data.version.version_no : '', name: (r.data && r.data.name) || '' }))
    })
  }

  function createTable() {
    var titleEl = document.getElementById('wbNewTitle')
    if (!titleEl || WB.busy || archived()) return
    var title = String(titleEl.value || '').trim()
    if (!title) { window.showToast(t('workbench.table.title_required')); return }
    WB.busy = true
    render()
    api('POST', '/api/workbench/items/new-table', { project_id: WB.projectId, title: title }).then(function (r) {
      WB.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      WB.selectedId = r.data.item.id
      WB.panel = 'editor'
      WB.detail = { item: r.data.item, versions: r.data.versions, project: WB.project }
      window.showToast(t('workbench.table.created', { name: r.data.name || '' }))
      load(WB.projectId)
      loadDetail(r.data.item.id)
      openTable(r.data.item.id, null)
    })
  }

  // ---- KEPSZERKESZTES EGERREL (#406, 16. pont) -------------------------------
  //
  // Minden a bongeszoben tortenik (canvas), a gepre nem kell kepszerkeszto. A
  // lepesek sorrendje rogzitett: forgatas/tukrozes -> vagas -> meret ->
  // hatter kivetele -> felirat. Mentes: a kesz kep UJ fajl + UJ verzio (a regi
  // kep megmarad). A vagokeret egerrel ES ujjal is huzhato (Pointer Events), es
  // szamokkal is megadhato -- a ket ut ugyanazt az allapotot irja.

  var IMG_PREVIEW_MAX = 900
  var IMG_MAX_SIDE = 8000
  var IMG_MAX_PIXELS = 16000000
  var IMG_ASPECTS = { free: 0, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16 }

  function imgRotSize(w, h, rot) { return rot % 180 ? { w: h, h: w } : { w: w, h: h } }

  function imgClampCrop(c, W, H) {
    var w = Math.max(1, Math.min(W, Math.round(c.w)))
    var h = Math.max(1, Math.min(H, Math.round(c.h)))
    var x = Math.max(0, Math.min(W - w, Math.round(c.x)))
    var y = Math.max(0, Math.min(H - h, Math.round(c.y)))
    return { x: x, y: y, w: w, h: h }
  }

  /** A legnagyobb, adott aranyu, kozepre igazitott keret. */
  function imgAspectCrop(W, H, ratio) {
    if (!ratio) return { x: 0, y: 0, w: W, h: H }
    var w = W
    var h = Math.round(W / ratio)
    if (h > H) { h = H; w = Math.round(H * ratio) }
    return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: w, h: h }
  }

  /** A kimeneti meret: a kert szelesseg, aranyosan, a bongeszo canvas-hataran belul. */
  function imgOutSize(crop, outW) {
    var w = Math.max(1, Math.round(Number(outW) || crop.w))
    var h = Math.max(1, Math.round(crop.h * w / crop.w))
    var k = Math.min(1, IMG_MAX_SIDE / Math.max(w, h), Math.sqrt(IMG_MAX_PIXELS / (w * h)))
    return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) }
  }

  /** Egyszinu hatter kivetele: a kattintott pontbol ARASZTASSAL a hasonlo
   *  szinu, OSSZEFUGGO kepponteket atlatszova teszi. Igy a targyon beluli,
   *  veletlenul ugyanolyan szinu folt megmarad. `tol`: 0-255, csatornankent. */
  function imgFloodKey(data, W, H, seeds, tol) {
    var seen = new Uint8Array(W * H)
    var cleared = 0
    for (var s = 0; s < seeds.length; s++) {
      var sx = Math.max(0, Math.min(W - 1, Math.floor(seeds[s].x)))
      var sy = Math.max(0, Math.min(H - 1, Math.floor(seeds[s].y)))
      var si = (sy * W + sx) * 4
      var r0 = data[si]
      var g0 = data[si + 1]
      var b0 = data[si + 2]
      var stack = [sy * W + sx]
      while (stack.length) {
        var p = stack.pop()
        if (seen[p]) continue
        var i = p * 4
        if (Math.abs(data[i] - r0) > tol || Math.abs(data[i + 1] - g0) > tol || Math.abs(data[i + 2] - b0) > tol) continue
        seen[p] = 1
        if (data[i + 3] !== 0) { data[i + 3] = 0; cleared++ }
        var x = p % W
        if (x > 0) stack.push(p - 1)
        if (x < W - 1) stack.push(p + 1)
        if (p >= W) stack.push(p - W)
        if (p < W * (H - 1)) stack.push(p + W)
      }
    }
    return cleared
  }

  function imgState() { return WB.img && WB.img.itemId === WB.selectedId ? WB.img : null }

  function imgCanEdit(p) {
    var current = !WB.previewVersion || (WB.detail && WB.detail.item && WB.previewVersion === WB.detail.item.current_version_id)
    return !!(p && p.available && p.kind === 'image' && p.url && !archived() && current)
  }

  function openImageEditor() {
    var p = WB.preview
    if (!imgCanEdit(p) || !WB.detail) return
    var itemId = WB.selectedId
    WB.img = {
      itemId: itemId, baseVersion: WB.detail.item.current_version_id, name: p.name || '', src: p.url,
      loading: true, error: null, el: null, W: 0, H: 0, rot: 0, flip: false,
      crop: null, aspect: 'free', outW: 0,
      caption: { text: '', pos: 'bottom', size: 6, color: 'white', band: true },
      bg: { pick: false, seeds: [], tol: 32 }, rotUrl: '', outUrl: '', busy: false, dirty: false,
    }
    render()
    loadImg(p.url).then(function (im) {
      var st = imgState()
      if (!st || st.itemId !== itemId) return
      st.el = im
      st.W = im.naturalWidth || im.width
      st.H = im.naturalHeight || im.height
      st.loading = false
      imgResetGeometry(st)
      render()
      imgRefresh(true)
    }).catch(function () {
      var st = imgState()
      if (!st) return
      st.loading = false
      st.error = t('workbench.img.load_failed')
      render()
    })
  }

  function imgResetGeometry(st) {
    var rs = imgRotSize(st.W, st.H, st.rot)
    st.crop = imgAspectCrop(rs.w, rs.h, IMG_ASPECTS[st.aspect] || 0)
    st.outW = st.crop.w
    st.bg.seeds = []
  }

  /** A forgatott/tukrozott teljes kep egy canvason. */
  function imgRotated(st, scale) {
    var rs = imgRotSize(st.W, st.H, st.rot)
    var cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(rs.w * scale))
    cv.height = Math.max(1, Math.round(rs.h * scale))
    var ctx = cv.getContext('2d')
    ctx.save()
    ctx.translate(cv.width / 2, cv.height / 2)
    ctx.rotate(st.rot * Math.PI / 180)
    if (st.flip) ctx.scale(-1, 1)
    ctx.drawImage(st.el, -st.W * scale / 2, -st.H * scale / 2, st.W * scale, st.H * scale)
    ctx.restore()
    return cv
  }

  /** A KESZ kep. `maxSide`: elonezethez kicsinyitve, mentesnel teljes meretben. */
  function imgOutput(st, maxSide) {
    var out = imgOutSize(st.crop, st.outW)
    var k = maxSide ? Math.min(1, maxSide / Math.max(out.w, out.h)) : 1
    var ow = Math.max(1, Math.round(out.w * k))
    var oh = Math.max(1, Math.round(out.h * k))
    // A forrast csak akkora felbontasban forgatjuk, amekkora a kimenethez kell.
    var srcScale = Math.min(1, Math.max(ow / st.crop.w, oh / st.crop.h) * 1.001)
    var rot = imgRotated(st, srcScale)
    var cv = document.createElement('canvas')
    cv.width = ow
    cv.height = oh
    var ctx = cv.getContext('2d')
    ctx.drawImage(rot, st.crop.x * srcScale, st.crop.y * srcScale, st.crop.w * srcScale, st.crop.h * srcScale, 0, 0, ow, oh)
    if (st.bg.seeds.length) {
      var id = ctx.getImageData(0, 0, ow, oh)
      imgFloodKey(id.data, ow, oh, st.bg.seeds.map(function (s) { return { x: s.x * ow, y: s.y * oh } }), st.bg.tol)
      ctx.putImageData(id, 0, 0)
    }
    var cap = st.caption
    if (cap.text && cap.text.trim()) {
      var fs = Math.max(8, Math.round(oh * cap.size / 100))
      ctx.font = 'bold ' + fs + 'px sans-serif'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'center'
      var lines = wrapLines(ctx, cap.text.trim(), ow * 0.9)
      var lh = Math.round(fs * 1.25)
      var bh = lines.length * lh + Math.round(fs * 0.6)
      var top = cap.pos === 'top' ? 0 : cap.pos === 'middle' ? Math.round((oh - bh) / 2) : oh - bh
      if (cap.band) {
        ctx.fillStyle = cap.color === 'black' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'
        ctx.fillRect(0, top, ow, bh)
      }
      ctx.fillStyle = cap.color === 'black' ? '#111111' : '#ffffff'
      lines.forEach(function (ln, i) { ctx.fillText(ln, ow / 2, top + Math.round(fs * 0.3) + i * lh) })
    }
    return cv
  }

  function imgOutType(st) {
    if (st.bg.seeds.length) return 'image/png'
    return /\.jpe?g$/i.test(st.name) ? 'image/jpeg' : /\.webp$/i.test(st.name) ? 'image/webp' : 'image/png'
  }

  /** Az elonezet frissitese, ujrarajzolas NELKUL (a mezok fokusza marad). */
  function imgRefresh(rotChanged) {
    var st = imgState()
    if (!st || !st.el || typeof document.createElement !== 'function') return
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(function () {
      st.timer = null
      try {
        if (rotChanged || !st.rotUrl) {
          var rs = imgRotSize(st.W, st.H, st.rot)
          st.rotUrl = imgRotated(st, Math.min(1, IMG_PREVIEW_MAX / Math.max(rs.w, rs.h))).toDataURL('image/jpeg', 0.85)
          var stageImg = document.getElementById('wbImgStageImg')
          if (stageImg) stageImg.src = st.rotUrl
        }
        st.outUrl = imgOutput(st, IMG_PREVIEW_MAX).toDataURL('image/png')
        var outImg = document.getElementById('wbImgOut')
        if (outImg) outImg.src = st.outUrl
        else render()
      } catch (e) {
        st.error = t('workbench.img.render_failed', { message: (e && e.message) || '' })
        render()
      }
    }, 120)
  }

  function imgCropStyle(st) {
    var rs = imgRotSize(st.W, st.H, st.rot)
    var pc = function (v, of) { return (Math.round(10000 * v / of) / 100) + '%' }
    return 'left:' + pc(st.crop.x, rs.w) + ';top:' + pc(st.crop.y, rs.h) + ';width:' + pc(st.crop.w, rs.w) + ';height:' + pc(st.crop.h, rs.h)
  }

  function imgNum(id, label, value) {
    return '<label class="wb-img-num"><span>' + esc(label) + '</span><input class="wb-input" type="number" inputmode="numeric" min="0" id="' + id + '" value="' + escA(value) + '"></label>'
  }

  function imageEditorHtml() {
    var st = imgState()
    var close = '<button type="button" class="btn-secondary" data-wb-act="img-close">' + esc(t('workbench.img.close')) + '</button>'
    if (st.loading) return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    if (st.error && !st.crop) return '<p class="wb-preview-bad">' + esc(st.error) + '</p><div class="wb-form-actions">' + close + '</div>'
    var out = imgOutSize(st.crop, st.outW)
    var cap = st.caption
    var aspects = Object.keys(IMG_ASPECTS).map(function (k) {
      return '<button type="button" class="' + (st.aspect === k ? 'btn-primary' : 'btn-secondary') + '" aria-pressed="' + (st.aspect === k) + '" data-wb-act="img-aspect" data-wb-aspect="' + escA(k) + '">'
        + esc(k === 'free' ? t('workbench.img.aspect_free') : k) + '</button>'
    }).join('')
    var sel = function (id, value, opts) {
      return '<select class="wb-input" id="' + id + '">' + opts.map(function (o) {
        return '<option value="' + escA(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
      }).join('') + '</select>'
    }
    return '<div class="wb-img">'
      + (st.error ? '<p class="wb-preview-bad">' + esc(st.error) + '</p>' : '')
      + '<div class="wb-img-cols">'
      // --- bal: vagas
      + '<div class="wb-img-col"><h5>' + esc(t('workbench.img.crop_title')) + '</h5>'
      + '<div class="wb-img-stage" id="wbImgStage"><img id="wbImgStageImg" alt="" draggable="false" src="' + escA(st.rotUrl || st.src) + '">'
      + '<div class="wb-img-crop" data-wb-crop="move" style="' + imgCropStyle(st) + '">'
      + ['nw', 'ne', 'sw', 'se'].map(function (h) { return '<span class="wb-img-h wb-img-h-' + h + '" data-wb-crop="' + h + '"></span>' }).join('')
      + '</div></div>'
      + '<p class="wb-hint">' + esc(t('workbench.img.crop_hint')) + '</p>'
      + '<div class="wb-img-row">' + aspects + '</div>'
      + '<div class="wb-img-row">'
      + imgNum('wbImgCx', 'X', st.crop.x) + imgNum('wbImgCy', 'Y', st.crop.y)
      + imgNum('wbImgCw', t('workbench.img.width'), st.crop.w) + imgNum('wbImgCh', t('workbench.img.height'), st.crop.h)
      + '</div>'
      + '<div class="wb-img-row">'
      + '<button type="button" class="btn-secondary" data-wb-act="img-rot-left">' + esc(t('workbench.img.rotate_left')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-rot-right">' + esc(t('workbench.img.rotate_right')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-flip" aria-pressed="' + !!st.flip + '">' + esc(t('workbench.img.flip')) + '</button>'
      + '</div></div>'
      // --- jobb: eredmeny
      + '<div class="wb-img-col"><h5>' + esc(t('workbench.img.result_title')) + '</h5>'
      + '<div class="wb-img-result' + (st.bg.pick ? ' wb-img-picking' : '') + '"><img id="wbImgOut" alt="' + escA(t('workbench.img.result_title')) + '" draggable="false"'
      + (st.bg.pick ? ' data-wb-img-pick="1"' : '') + ' src="' + escA(st.outUrl || st.rotUrl || st.src) + '"></div>'
      + '<p class="wb-muted">' + esc(t('workbench.img.out_size', { w: out.w, h: out.h })) + '</p>'
      + '<div class="wb-img-row">' + imgNum('wbImgOutW', t('workbench.img.out_width'), st.outW)
      + '<button type="button" class="btn-secondary" data-wb-act="img-size-orig">' + esc(t('workbench.img.size_orig')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-size-half">50%</button></div>'
      + '<h5>' + esc(t('workbench.img.caption_title')) + '</h5>'
      + '<input class="wb-input" type="text" id="wbImgCapText" maxlength="300" placeholder="' + escA(t('workbench.img.caption_placeholder')) + '" value="' + escA(cap.text) + '">'
      + '<div class="wb-img-row">'
      + sel('wbImgCapPos', cap.pos, [['top', t('workbench.img.pos_top')], ['middle', t('workbench.img.pos_middle')], ['bottom', t('workbench.img.pos_bottom')]])
      + sel('wbImgCapColor', cap.color, [['white', t('workbench.img.color_white')], ['black', t('workbench.img.color_black')]])
      + '<label class="wb-img-num"><span>' + esc(t('workbench.img.caption_size')) + '</span><input type="range" id="wbImgCapSize" min="2" max="20" value="' + escA(cap.size) + '"></label>'
      + '<label class="wb-img-check"><input type="checkbox" id="wbImgCapBand"' + (cap.band ? ' checked' : '') + '> ' + esc(t('workbench.img.caption_band')) + '</label>'
      + '</div>'
      + '<h5>' + esc(t('workbench.img.bg_title')) + '</h5>'
      + '<div class="wb-img-row">'
      + '<button type="button" class="' + (st.bg.pick ? 'btn-primary' : 'btn-secondary') + '" aria-pressed="' + !!st.bg.pick + '" data-wb-act="img-bg-pick">' + esc(t(st.bg.pick ? 'workbench.img.bg_picking' : 'workbench.img.bg_pick')) + '</button>'
      + (st.bg.seeds.length ? '<button type="button" class="btn-secondary" data-wb-act="img-bg-clear">' + esc(t('workbench.img.bg_clear', { n: st.bg.seeds.length })) + '</button>' : '')
      + '<label class="wb-img-num"><span>' + esc(t('workbench.img.bg_tol')) + '</span><input type="range" id="wbImgTol" min="0" max="120" value="' + escA(st.bg.tol) + '"></label>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.img.bg_hint')) + '</p>'
      + '</div></div>'
      + '<div class="wb-form-actions">'
      + '<button type="button" class="btn-primary" data-wb-act="img-save"' + (st.busy ? ' disabled' : '') + '>' + esc(st.busy ? t('workbench.parts.saving') : t('workbench.img.save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="img-reset">' + esc(t('workbench.img.reset')) + '</button>'
      + close + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.img.save_hint')) + '</p>'
      + '</div>'
  }

  function imgClose() {
    var st = imgState()
    if (st && st.dirty && !window.confirm(t('workbench.img.discard_confirm'))) return
    WB.img = null
    render()
  }

  function imgSetAspect(key) {
    var st = imgState()
    if (!st || !st.crop || !(key in IMG_ASPECTS)) return
    st.aspect = key
    var rs = imgRotSize(st.W, st.H, st.rot)
    st.crop = imgAspectCrop(rs.w, rs.h, IMG_ASPECTS[key])
    st.outW = st.crop.w
    st.bg.seeds = []
    st.dirty = true
    render()
    imgRefresh(false)
  }

  function imgRotate(delta) {
    var st = imgState()
    if (!st || !st.crop) return
    st.rot = (st.rot + delta + 360) % 360
    imgResetGeometry(st)
    st.dirty = true
    render()
    imgRefresh(true)
  }

  /** Egy mezo az allapotba. Az ujrarajzolast csak a szam-mezok kerik (a keret
   *  helye valtozik); a szoveges mezo alatt csak az elonezet frissul. */
  function imgField(id, el) {
    var st = imgState()
    if (!st || !st.crop) return false
    var v = el.value
    var rs = imgRotSize(st.W, st.H, st.rot)
    if (id === 'wbImgCx' || id === 'wbImgCy' || id === 'wbImgCw' || id === 'wbImgCh') {
      var n = Number(v)
      if (!Number.isFinite(n)) return true
      var c = { x: st.crop.x, y: st.crop.y, w: st.crop.w, h: st.crop.h }
      if (id === 'wbImgCx') c.x = n
      else if (id === 'wbImgCy') c.y = n
      else if (id === 'wbImgCw') c.w = n
      else c.h = n
      st.crop = imgClampCrop(c, rs.w, rs.h)
      st.aspect = 'free'
      st.outW = st.crop.w
      st.bg.seeds = []
      var box = document.querySelector && document.querySelector('[data-wb-crop="move"]')
      if (box && box.setAttribute) box.setAttribute('style', imgCropStyle(st))
    } else if (id === 'wbImgOutW') {
      var w = Number(v)
      if (Number.isFinite(w) && w > 0) st.outW = Math.min(IMG_MAX_SIDE, Math.round(w))
    } else if (id === 'wbImgCapText') st.caption.text = String(v || '')
    else if (id === 'wbImgCapPos') st.caption.pos = v
    else if (id === 'wbImgCapColor') st.caption.color = v
    else if (id === 'wbImgCapSize') st.caption.size = Math.max(2, Math.min(20, Number(v) || 6))
    else if (id === 'wbImgCapBand') st.caption.band = !!el.checked
    else if (id === 'wbImgTol') st.bg.tol = Math.max(0, Math.min(120, Number(v) || 0))
    else return false
    st.dirty = true
    imgRefresh(false)
    return true
  }

  function imgSave() {
    var st = imgState()
    if (!st || st.busy || !st.crop || !WB.selectedId) return
    var itemId = WB.selectedId
    var type = imgOutType(st)
    st.busy = true
    st.error = null
    render()
    var fail = function (msg) {
      var s2 = imgState()
      if (!s2) return
      s2.busy = false
      render()
      window.showToast(msg)
    }
    var cv
    try { cv = imgOutput(st, 0) } catch (e) { fail(t('workbench.img.render_failed', { message: (e && e.message) || '' })); return }
    cv.toBlob(function (blob) {
      if (!blob) { fail(t('workbench.img.render_failed', { message: '' })); return }
      var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/image-edit?base_version=' + encodeURIComponent(st.baseVersion || '')
        + '&lang=' + encodeURIComponent(window._lang || 'hu')
      fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || type }, body: blob }).then(function (res) {
        return res.json().catch(function () { return null }).then(function (data) {
          if (!res.ok) { fail((data && data.message) || t('workbench.err.http', { status: res.status })); return }
          WB.img = null
          applyVersions(data)
          window.showToast(t('workbench.img.saved', { n: data && data.version ? data.version.version_no : '', name: (data && data.name) || '' }))
        })
      }).catch(function () { fail(t('workbench.err.network')) })
    }, type, type === 'image/png' ? undefined : 0.92)
  }

  // Vagokeret huzasa (eger + erintes). Huzas kozben csak a doboz stilusa
  // valtozik; elengedeskor kerul az allapotba, es akkor frissul az eredmeny.
  var imgDrag = null

  function imgDragApply(d, clientX, clientY) {
    var st = imgState()
    if (!st) return null
    var rs = imgRotSize(st.W, st.H, st.rot)
    var dx = (clientX - d.x0) * rs.w / (d.rect.width || 1)
    var dy = (clientY - d.y0) * rs.h / (d.rect.height || 1)
    var c = { x: d.crop.x, y: d.crop.y, w: d.crop.w, h: d.crop.h }
    var ratio = IMG_ASPECTS[st.aspect] || 0
    if (d.mode === 'move') { c.x += dx; c.y += dy; return imgClampCrop(c, rs.w, rs.h) }
    var right = c.x + c.w
    var bottom = c.y + c.h
    if (d.mode === 'nw' || d.mode === 'sw') c.x = Math.min(right - 8, Math.max(0, c.x + dx))
    if (d.mode === 'nw' || d.mode === 'ne') c.y = Math.min(bottom - 8, Math.max(0, c.y + dy))
    c.w = d.mode === 'ne' || d.mode === 'se' ? Math.max(8, Math.min(rs.w - c.x, c.w + dx)) : right - c.x
    c.h = d.mode === 'sw' || d.mode === 'se' ? Math.max(8, Math.min(rs.h - c.y, c.h + dy)) : bottom - c.y
    if (ratio) {
      c.h = c.w / ratio
      if (c.y + c.h > rs.h) { c.h = rs.h - c.y; c.w = c.h * ratio }
      if (d.mode === 'nw' || d.mode === 'ne') c.y = bottom - c.h
      if (d.mode === 'nw' || d.mode === 'sw') c.x = right - c.w
    }
    return imgClampCrop(c, rs.w, rs.h)
  }

  function previewHtml() {
    var p = WB.preview
    if (!p) return '<div class="wb-preview"><p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    // A sajat reszeit (szoveg + kep) a reszlista mutatja: nem duplazzuk meg.
    if (p.available && p.kind === 'parts') return ''
    var head = '<div class="wb-preview-head"><h4>' + esc(t('workbench.preview.title')) + '</h4>'
      + (p.name ? '<span class="wb-muted">' + esc(p.name) + '</span>' : '')
      + previewVersionPickerHtml() + '</div>'
    // TABLAZAT (#406, 15. pont): nyitva a racs -> az van a helyen.
    if (tableOpen()) return '<div class="wb-preview">' + head + tableHtml() + '</div>'
    var tableBtn = tableButtonHtml(p)
    if (!p.available && p.reason === 'needs_conversion') {
      // NEM HIBA, hanem TEENDO: ebbol a dokumentumbol tudunk elonezetet
      // csinalni. A gomb mellett ott a letoltes is -- ha a gepen nincs meg a
      // LibreOffice, a felhasznalo attol meg hozzafer a sajat fajljahoz.
      return '<div class="wb-preview">' + head + tableBtn
        + '<p class="wb-muted">' + esc(p.message || t('workbench.preview.none')) + '</p>'
        + '<p><button type="button" class="btn-primary" data-wb-act="preview-convert"' + (WB.convertBusy ? ' disabled' : '') + '>'
        + esc(WB.convertBusy ? t('workbench.preview.converting') : t('workbench.preview.convert')) + '</button></p>'
        + (WB.convertError
          ? '<p class="wb-preview-bad">' + esc(WB.convertError.message || '') + '</p>'
            + (WB.convertError.detail ? '<p class="wb-hint">' + esc(WB.convertError.detail) + '</p>' : '')
            + '<p><button type="button" class="wb-btn" data-wb-act="preview-convert-retry"' + (WB.convertBusy ? ' disabled' : '') + '>'
            + esc(t('workbench.preview.convert_retry')) + '</button></p>'
          : '')
        + (p.rel
          ? '<p class="wb-hint"><a href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
            + esc(t('workbench.preview.download')) + '</a></p>'
          : '')
        + '</div>'
    }
    if (!p.available) {
      // A "nem latok oda" fajtak hangosak, a "meg nincs semmi" baratsagos.
      var loud = p.reason && p.reason !== 'no_source' && p.reason !== 'unsupported'
      return '<div class="wb-preview">' + head
        + '<p class="' + (loud ? 'wb-preview-bad' : 'wb-muted') + '">' + esc(p.message || t('workbench.preview.none')) + '</p>'
        + (p.reason === 'unsupported' && p.rel
          ? '<p class="wb-hint"><a href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
            + esc(t('workbench.preview.download')) + '</a></p>'
          : '')
        + (p.detail ? '<p class="wb-hint">' + esc(p.detail) + '</p>' : '')
        + '</div>'
    }
    return '<div class="wb-preview">' + head + tableBtn + previewBodyHtml(p) + '</div>'
  }


  // ---- PDF-NEZEGETO (kartya f7d423e7) ---------------------------------------
  //
  // MIERT NEM A BONGESZO SAJAT NEZEGETOJE (a korabbi `<iframe>`): minden
  // bongeszo mast mutat -- mas eszkozsav, mas gorgetes, van, amelyik le se
  // rajzolja, csak letoltest ajanl. A tulajdonos EGYSEGES nezetet kert, ezert a
  // lapokat mi magunk rajzoljuk ki a pdf.js-sel.
  //
  // MIERT NEM CDN-ROL: a pdf.js a SAJAT kiszolgalonkrol jon (`/vendor/pdfjs/`,
  // a `pdfjs-dist` csomagbol), igy egy frissen telepitett, halozat nelkuli
  // gepen is mukodik. Ha a csomag nincs fent, azt KIMONDJUK a potlo paranccsal
  // egyutt -- a szerver 404-enek a TORZSEBOL olvassuk ki az okot, nem
  // talalgatunk.
  //
  // MIERT KULON DOM-CSOMOPONT: a `render()` az egesz felulet innerHTML-jet
  // ujraepiti (egy gepelés a chatben is ujrarajzol). Ha a kirajzolt lapok abban
  // ulnenek, minden billentyuleutesnel ujra kellene rajzolni oket. Ezert a
  // nezegeto sajat, TARTOS csomopontban el, amit a render() utan egyszeruen
  // visszateszunk a helyere.

  /** A nezegeto HELYE a felulet HTML-jeben. Ures marad: a tartalmat a
   *  render() utan futo `pdfMount()` teszi bele, mert a kirajzolt lapoknak
   *  TUL kell elniuk az ujrarajzolast. */
  function pdfSlotHtml(url) {
    return '<div class="wb-pdf-slot" data-wb-pdf="' + escA(url) + '"></div>'
  }

  var PDFJS_LIB_URL = '/vendor/pdfjs/build/pdf.min.mjs'
  var PDFJS_WORKER_URL = '/vendor/pdfjs/build/pdf.worker.min.mjs'
  var PDFJS_VENDOR_BASE = '/vendor/pdfjs/'
  /** Nagyitas-fokozatok. A "lapszelesseg" (fit) kulon allapot, nem fokozat. */
  var PDF_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
  /** Ennel tobb lapot nem rajzolunk ki egyszerre elore, ha nincs
   *  IntersectionObserver: egy 900 oldalas PDF kulonben megfogna a bongeszot. */
  var PDF_EAGER_PAGES = 5

  /** Van-e annyi DOM, amennyi a nezegetohoz kell. A teszt-kornyezet (es egy
   *  nagyon regi bongeszo) keveset ad: ott a nezegeto NEM indul el, es a
   *  felulet tobbi resze valtozatlanul mukodik. */
  function pdfDomOk() {
    return !!(typeof document !== 'undefined' && document.createElement && document.querySelector)
  }

  /** A pdf.js konyvtar betoltese -- egyszer, keresre. Amig nem nezel PDF-et,
   *  egyetlen bajt sem toltodik le belole. */
  function pdfLoadLib() {
    if (WB.pdfLib) return Promise.resolve(WB.pdfLib)
    if (WB.pdfLibPromise) return WB.pdfLibPromise
    WB.pdfLibPromise = import(PDFJS_LIB_URL).then(function (mod) {
      var lib = (mod && mod.getDocument) ? mod : (mod && mod.default) || mod
      if (!lib || !lib.getDocument) throw new Error('pdfjs_shape')
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
      WB.pdfLib = lib
      return lib
    }).catch(function (err) {
      // A kovetkezo probalkozas induljon tisztan.
      WB.pdfLibPromise = null
      // NEM TALALGATUNK: megkerdezzuk magat a forrast, mi a baj.
      return pdfWhyLibFailed().then(function (why) { throw why })
    })
    return WB.pdfLibPromise
  }

  /** A betoltes-hiba VALODI oka. A kiszolgalo 404-e JSON-t ad, benne az ember
   *  altal olvashato mondattal (nincs telepitve a csomag -> potlo parancs). Ha
   *  ezt sem erjuk el, azt mondjuk ki, hogy nem tudjuk -- nem gyartunk okot. */
  function pdfWhyLibFailed() {
    var url = PDFJS_LIB_URL + '?lang=' + encodeURIComponent(window._lang || 'hu')
    return fetch(url).then(function (res) {
      if (res.status === 404) {
        return res.json().then(function (body) {
          return {
            message: (body && body.message) || t('workbench.pdf.failed'),
            detail: (body && body.detail) || '',
          }
        }).catch(function () {
          return { message: t('workbench.pdf.failed'), detail: '' }
        })
      }
      return { message: t('workbench.pdf.failed'), detail: t('workbench.pdf.failed_http', { status: res.status }) }
    }).catch(function () {
      return { message: t('workbench.pdf.failed'), detail: t('workbench.pdf.failed_offline') }
    })
  }

  function pdfState() {
    if (!WB.pdf) {
      WB.pdf = {
        url: null, host: null, pagesEl: null, doc: null, pages: 0,
        zoom: 1, fit: true, error: null, detail: null, loading: false, seq: 0,
        rendered: null, observer: null, current: 1,
      }
    }
    return WB.pdf
  }

  /** Mindent elenged, ami az elozo dokumentumhoz tartozott. */
  function pdfReset() {
    var s = pdfState()
    s.seq += 1
    if (s.observer && s.observer.disconnect) { try { s.observer.disconnect() } catch (e) {} }
    if (s.doc && s.doc.destroy) { try { s.doc.destroy() } catch (e) {} }
    s.url = null; s.host = null; s.pagesEl = null; s.doc = null; s.pages = 0
    s.error = null; s.detail = null; s.loading = false; s.rendered = null
    s.observer = null; s.current = 1
  }

  /** A `render()` utan: a helyorzobe visszatesszuk a tartos nezegetot, vagy
   *  (uj dokumentumnal) elindítjuk a betoltest. */
  function pdfMount() {
    if (!pdfDomOk()) return
    var slot = document.querySelector('[data-wb-pdf]')
    if (!slot) {
      // Nincs PDF a kepernyon: a memoriat sem tartjuk feleslegesen.
      if (WB.pdf && WB.pdf.url) pdfReset()
      return
    }
    var url = slot.getAttribute('data-wb-pdf')
    var s = pdfState()
    if (s.url !== url) { pdfReset(); s = pdfState(); s.url = url; pdfBuildHost(); pdfOpen(url) }
    if (s.host && s.host.parentNode !== slot) slot.appendChild(s.host)
  }

  /** A tartos csomopont: eszkozsav + lapok. Egyszer epul fel, utana csak a
   *  tartalma valtozik -- ezert nem vesznek el a mar kirajzolt lapok. */
  function pdfBuildHost() {
    var s = pdfState()
    var host = document.createElement('div')
    host.className = 'wb-pdf'
    var bar = document.createElement('div')
    bar.className = 'wb-pdf-bar'
    bar.innerHTML = '<button type="button" class="wb-pdf-btn" data-pdf="prev" title="' + escA(t('workbench.pdf.prev')) + '">&#8249;</button>'
      + '<span class="wb-pdf-pos" data-pdf-pos></span>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="next" title="' + escA(t('workbench.pdf.next')) + '">&#8250;</button>'
      + '<span class="wb-pdf-sep"></span>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="out" title="' + escA(t('workbench.pdf.zoom_out')) + '">&minus;</button>'
      + '<span class="wb-pdf-zoom" data-pdf-zoom></span>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="in" title="' + escA(t('workbench.pdf.zoom_in')) + '">+</button>'
      + '<button type="button" class="wb-pdf-btn" data-pdf="fit">' + esc(t('workbench.pdf.fit_width')) + '</button>'
    var pages = document.createElement('div')
    pages.className = 'wb-pdf-pages'
    host.appendChild(bar)
    host.appendChild(pages)
    // Sajat figyelo: a nagyitas NE rajzolja ujra az egesz Munkapadot.
    bar.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-pdf]') : null
      if (!btn) return
      pdfToolbarAction(btn.getAttribute('data-pdf'))
    })
    // A gorgetes mondja meg, hanyadik lapot latod eppen.
    pages.addEventListener('scroll', function () { pdfSyncPosition() })
    s.host = host
    s.pagesEl = pages
    s.barEl = bar
  }

  function pdfToolbarAction(what) {
    var s = pdfState()
    if (!s.doc) return
    if (what === 'prev') { pdfGoTo(s.current - 1); return }
    if (what === 'next') { pdfGoTo(s.current + 1); return }
    if (what === 'fit') { s.fit = true; pdfRelayout(); return }
    var i = PDF_ZOOMS.indexOf(s.zoom)
    if (i < 0) i = PDF_ZOOMS.indexOf(1)
    if (what === 'in') i = Math.min(PDF_ZOOMS.length - 1, i + 1)
    if (what === 'out') i = Math.max(0, i - 1)
    s.fit = false
    s.zoom = PDF_ZOOMS[i]
    pdfRelayout()
  }

  function pdfGoTo(n) {
    var s = pdfState()
    if (!s.pagesEl || n < 1 || n > s.pages) return
    var el = s.pagesEl.querySelector('[data-pdf-page="' + n + '"]')
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' })
    s.current = n
    pdfUpdateBar()
  }

  /** Melyik lap van a nezet tetejen. A gorgetesbol szamoljuk, nem tippelunk. */
  function pdfSyncPosition() {
    var s = pdfState()
    if (!s.pagesEl) return
    var kids = s.pagesEl.children
    var top = s.pagesEl.scrollTop
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop + kids[i].offsetHeight > top + 8) {
        var n = parseInt(kids[i].getAttribute('data-pdf-page'), 10)
        if (n && n !== s.current) { s.current = n; pdfUpdateBar() }
        return
      }
    }
  }

  function pdfUpdateBar() {
    var s = pdfState()
    if (!s.barEl) return
    var pos = s.barEl.querySelector('[data-pdf-pos]')
    var zoom = s.barEl.querySelector('[data-pdf-zoom]')
    if (pos) pos.textContent = s.pages ? t('workbench.pdf.page_of', { n: s.current, total: s.pages }) : ''
    if (zoom) zoom.textContent = s.fit ? t('workbench.pdf.fit_short') : Math.round(s.zoom * 100) + '%'
  }

  /** A dokumentum megnyitasa. Hiba eseten a nezegeto helyen EMBERI mondat all,
   *  es ott a letoltes-ut is: a fajljahoz a felhasznalo akkor is hozzafer. */
  function pdfOpen(url) {
    var s = pdfState()
    var mySeq = s.seq
    s.loading = true
    pdfShowMessage(t('workbench.pdf.loading'), '')
    pdfLoadLib().then(function (lib) {
      if (s.seq !== mySeq) return null
      return lib.getDocument({
        url: url,
        // A pdf.js ezekbol tolti be a karakterkeszlet-terkepeket, a beepitett
        // betutipusokat es a kep-dekodereket. Enelkul a keleti szoveg es a
        // be nem agyazott betutipus helyen ures folt lenne.
        cMapUrl: PDFJS_VENDOR_BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: PDFJS_VENDOR_BASE + 'standard_fonts/',
        wasmUrl: PDFJS_VENDOR_BASE + 'wasm/',
        iccUrl: PDFJS_VENDOR_BASE + 'iccs/',
      }).promise
    }).then(function (doc) {
      if (!doc || s.seq !== mySeq) return
      s.doc = doc
      s.pages = doc.numPages
      s.loading = false
      s.error = null
      pdfBuildPages()
    }).catch(function (err) {
      if (s.seq !== mySeq) return
      s.loading = false
      s.error = (err && err.message) || t('workbench.pdf.failed')
      s.detail = (err && err.detail) || ''
      pdfShowMessage(s.error, s.detail)
    })
  }

  function pdfShowMessage(message, detail) {
    var s = pdfState()
    if (!s.pagesEl) return
    s.pagesEl.innerHTML = '<p class="wb-pdf-msg">' + esc(message) + '</p>'
      + (detail ? '<p class="wb-pdf-detail">' + esc(detail) + '</p>' : '')
    pdfUpdateBar()
  }

  /** Lap-helyek letrehozasa a VALODI meretekkel, majd a lathato lapok
   *  kirajzolasa. A helyorzo azert kap pontos meretet, hogy a gorgeto ne
   *  ugraljon, amikor egy lap elkeszul. */
  function pdfBuildPages() {
    var s = pdfState()
    if (!s.doc || !s.pagesEl) return
    s.rendered = {}
    s.pagesEl.innerHTML = ''
    var mySeq = s.seq
    s.doc.getPage(1).then(function (page) {
      if (s.seq !== mySeq) return
      var base = page.getViewport({ scale: 1 })
      s.baseW = base.width
      s.baseH = base.height
      for (var n = 1; n <= s.pages; n++) {
        var d = document.createElement('div')
        d.className = 'wb-pdf-page'
        d.setAttribute('data-pdf-page', String(n))
        s.pagesEl.appendChild(d)
      }
      pdfRelayout()
    }).catch(function (err) {
      if (s.seq !== mySeq) return
      pdfShowMessage(t('workbench.pdf.failed'), (err && err.message) || '')
    })
  }

  /** A megjelenitendo meretarany. "Lapszelesseg" eseten a panel szelessegehez
   *  igazodik -- ha a panel szelesseget meg nem tudjuk (0), akkor 1-es
   *  aranyt hasznalunk, es nem talalgatunk kepernyomeretet. */
  function pdfScale() {
    var s = pdfState()
    if (!s.fit) return s.zoom
    var w = s.pagesEl ? s.pagesEl.clientWidth : 0
    if (!w || !s.baseW) return 1
    return Math.max(0.2, (w - 24) / s.baseW)
  }

  /** Ujrameretezes: a mar kirajzolt lapokat eldobjuk, es a lathatokat ujra
   *  rajzoljuk. Igy a nagyitas eles marad, nem felnagyitott kep. */
  function pdfRelayout() {
    var s = pdfState()
    if (!s.pagesEl || !s.doc) return
    var scale = pdfScale()
    s.rendered = {}
    var kids = s.pagesEl.children
    for (var i = 0; i < kids.length; i++) {
      kids[i].innerHTML = ''
      kids[i].style.width = Math.round(s.baseW * scale) + 'px'
      kids[i].style.height = Math.round(s.baseH * scale) + 'px'
    }
    pdfObserve()
    pdfUpdateBar()
  }

  /** Csak azt rajzoljuk ki, ami lathato (vagy kozel van hozza). Ha a bongeszo
   *  nem tud IntersectionObservert, az elso par lap jon, es gorgetesre a tobbi
   *  -- nem marad ures a kepernyo. */
  function pdfObserve() {
    var s = pdfState()
    if (s.observer && s.observer.disconnect) { try { s.observer.disconnect() } catch (e) {} }
    s.observer = null
    var kids = s.pagesEl.children
    if (typeof IntersectionObserver === 'function') {
      s.observer = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) pdfDrawPage(parseInt(entries[i].target.getAttribute('data-pdf-page'), 10))
        }
      }, { root: s.pagesEl, rootMargin: '200px 0px' })
      for (var j = 0; j < kids.length; j++) s.observer.observe(kids[j])
      return
    }
    for (var k = 0; k < Math.min(kids.length, PDF_EAGER_PAGES); k++) pdfDrawPage(k + 1)
    s.pagesEl.addEventListener('scroll', pdfDrawNearby)
  }

  function pdfDrawNearby() {
    var s = pdfState()
    if (!s.pagesEl) return
    var kids = s.pagesEl.children
    var top = s.pagesEl.scrollTop
    var bottom = top + s.pagesEl.clientHeight + 400
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop + kids[i].offsetHeight >= top && kids[i].offsetTop <= bottom) {
        pdfDrawPage(parseInt(kids[i].getAttribute('data-pdf-page'), 10))
      }
    }
  }

  function pdfDrawPage(n) {
    var s = pdfState()
    if (!n || !s.doc || !s.rendered || s.rendered[n]) return
    s.rendered[n] = true
    var mySeq = s.seq
    var scale = pdfScale()
    s.doc.getPage(n).then(function (page) {
      if (s.seq !== mySeq) return
      var holder = s.pagesEl.querySelector('[data-pdf-page="' + n + '"]')
      if (!holder) return
      // A kepernyo sursege (retina) nelkul a szoveg elmosodna.
      var dpr = (window.devicePixelRatio || 1)
      var viewport = page.getViewport({ scale: scale * dpr })
      var canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      canvas.style.width = Math.round(viewport.width / dpr) + 'px'
      canvas.style.height = Math.round(viewport.height / dpr) + 'px'
      holder.innerHTML = ''
      holder.appendChild(canvas)
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise
    }).catch(function (err) {
      if (s.seq !== mySeq) return
      // EGY lap hibaja nem doli el az egesz dokumentumot: csak azt a lapot
      // jelezzuk, a tobbi marad olvashato.
      s.rendered[n] = false
      var holder = s.pagesEl && s.pagesEl.querySelector('[data-pdf-page="' + n + '"]')
      if (holder) holder.innerHTML = '<p class="wb-pdf-msg">' + esc(t('workbench.pdf.page_failed', { n: n })) + '</p>'
        + '<p class="wb-pdf-detail">' + esc((err && err.message) || '') + '</p>'
    })
  }


  // ---- rajzvaszon (9. fazis, spec 9) -----------------------------------------
  //
  // A rajz STRUKTURALT: elemekbol all, mindegyiknek STABIL azonositoja van.
  // Ezert nem "kepet festunk", hanem ELEMEKET allitunk -- es pontosan ugyanazt
  // a muveletkeszletet hasznalja a lenti gomb es az agent (`canvas.edit`).
  //
  // Miert nincs itt CDN-rol toltodo rajzolo konyvtar: a kepet a SZERVER
  // rajzolja ki (SVG), igy a Munkapad egy FRISSEN telepitett, halozat nelkuli
  // gepen is mukodik, es a letoltott kep pontosan az, amit a kepernyon latsz.
  // A vonszolasos (eger-huzos) szerkesztes kesobbi bovites lehet; a strukturalt
  // szerkesztes ettol fuggetlenul teljes.

  // A kep-URL vegere tett jelzo. Azert NEM eleg a `Date.now()`: ket mentes
  // eshet ugyanabba az ezredmasodpercbe, es akkor a bongeszo a REGI kepet
  // mutatna tovabb. A szamlalo mindig valtozik.
  var canvasStampSeq = 0
  function bumpCanvasStamp() {
    canvasStampSeq += 1
    WB.canvasStamp = String(Date.now()) + '-' + canvasStampSeq
  }

  /** Rajz-vaszon fajtak: ezeknel ajanljuk fel magatol a rajzolast. */
  function canvasKind(item) {
    return !!item && (item.type === 'graphic' || item.type === 'image')
  }

  function canvasSvgUrl(itemId, download) {
    return '/api/workbench/items/' + encodeURIComponent(itemId) + '/canvas.svg'
      + '?lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')
      // A kep a vaszonnal egyutt valtozik: a bongeszo gyorsitotara kulonben a
      // mentes ELOTTI kepet mutatna tovabb.
      + '&v=' + encodeURIComponent(WB.canvasStamp || '0')
      + (download ? '&download=1' : '')
  }

  function loadCanvas(itemId) {
    WB.canvasError = null
    return api('GET', '/api/workbench/items/' + encodeURIComponent(itemId) + '/canvas').then(function (r) {
      if (WB.selectedId !== itemId) return
      if (!r.ok) {
        // A "nem latok oda" NEM ures rajz: kulon, hangos allapot, a rendszer
        // sajat uzenetevel egyutt.
        WB.canvas = null
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
      } else {
        WB.canvas = r.data
        bumpCanvasStamp()
      }
      render()
    })
  }

  function canvasObjects() {
    return (WB.canvas && WB.canvas.canvas && WB.canvas.canvas.objects) || []
  }

  function canvasObject(id) {
    var list = canvasObjects()
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i]
    return null
  }

  /** Egy koteg muvelet elkuldese. UGYANAZ az ut, amit az agent hasznal. */
  function canvasOps(ops) {
    if (!WB.selectedId || WB.canvasBusy) return
    WB.canvasBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas/ops', { ops: ops }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        // A hiba OKAT a szerver mondja meg (melyik elem, melyik mezo) -- nem
        // talaljuk ki helyette.
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
        render()
        return
      }
      WB.canvasError = null
      WB.canvasEdit = null
      WB.canvas = {
        canvas: r.data.canvas, exists: true, rel: r.data.rel, name: r.data.name,
        version_id: r.data.version && r.data.version.id,
        version_no: r.data.version && r.data.version.version_no,
      }
      bumpCanvasStamp()
      if (WB.detail && r.data.item) { WB.detail.item = r.data.item }
      if (WB.detail && r.data.versions) { WB.detail.versions = r.data.versions }
      window.showToast(r.data.renamed
        ? t('workbench.canvas.renamed', { name: r.data.name })
        : (r.data.message || t('workbench.canvas.saved')))
      // A kozepso panel elonezete is a vaszonrol szol: ujra kell kerni -- de a
      // mostani kep a helyen marad, amig az uj meg nem jon (nincs villogas).
      loadPreview(WB.selectedId, null, true)
      render()
    })
  }

  /** Az ures vaszon LETREHOZASA. Addig nincs fajl, amig a felhasznalo el nem
   *  kezdi -- es ez a gomb az, ami elkezdi. */
  function startCanvas() {
    if (!WB.selectedId || WB.canvasBusy) return
    WB.canvasBusy = true
    render()
    api('PUT', '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/canvas', {
      canvas: { width: 1080, height: 1080, background: '#ffffff', objects: [] },
    }).then(function (r) {
      WB.canvasBusy = false
      if (!r.ok) {
        WB.canvasError = { message: r.message, detail: (r.data && r.data.detail) || '' }
        render()
        return
      }
      WB.canvasError = null
      WB.canvas = {
        canvas: r.data.canvas, exists: true, rel: r.data.rel, name: r.data.name,
        version_id: r.data.version && r.data.version.id,
        version_no: r.data.version && r.data.version.version_no,
      }
      bumpCanvasStamp()
      if (WB.detail && r.data.item) { WB.detail.item = r.data.item }
      if (WB.detail && r.data.versions) { WB.detail.versions = r.data.versions }
      loadPreview(WB.selectedId, null)
      render()
    })
  }

  function numField(id, fallback) {
    var el = document.getElementById(id)
    if (!el) return fallback
    var n = Number(el.value)
    return isFinite(n) ? n : fallback
  }

  function fieldValue(id, fallback) {
    var el = document.getElementById(id)
    return el ? el.value : fallback
  }

  function checked(id) {
    var el = document.getElementById(id)
    return !!(el && el.checked)
  }

  /** A szerkeszto urlap mentese: EGY `update` muvelet, ugyanaz, amit az agent
   *  kuldene. Igy a ket ut nem csuszhat szet. */
  function saveCanvasObject(id) {
    var o = canvasObject(id)
    if (!o) return
    var patch = {
      x: numField('wbCanX', o.x), y: numField('wbCanY', o.y),
      width: numField('wbCanW', o.width), height: numField('wbCanH', o.height),
    }
    if (o.type === 'text') {
      patch.text = fieldValue('wbCanText', o.text)
      patch.fontSize = numField('wbCanFontSize', o.fontSize)
      patch.color = fieldValue('wbCanColor', o.color)
      patch.align = fieldValue('wbCanAlign', o.align)
      patch.bold = checked('wbCanBold')
      patch.italic = checked('wbCanItalic')
    } else if (o.type === 'rect') {
      patch.fill = fieldValue('wbCanFill', o.fill)
      patch.radius = numField('wbCanRadius', o.radius)
    } else {
      patch.fit = fieldValue('wbCanFit', o.fit)
      patch.alt = fieldValue('wbCanAlt', o.alt)
    }
    canvasOps([{ op: 'update', id: id, patch: patch }])
  }

  /** A munkadarab MAR feltoltott kepei -- ezekbol lehet valasztani a vaszonra.
   *  Ha meg nincs egy sem, azt KIMONDJUK, es megmondjuk, hol lehet feltolteni. */
  function canvasImageChoices() {
    return partsOf().filter(function (p) { return p.kind === 'image' && p.asset_path })
  }

  function canvasAddText() {
    canvasOps([{
      op: 'add',
      object: { type: 'text', text: t('workbench.canvas.new_text'), x: 80, y: 80, width: 600, height: 120, fontSize: 64, color: '#111111' },
    }])
  }

  function canvasAddRect() {
    canvasOps([{ op: 'add', object: { type: 'rect', x: 80, y: 260, width: 400, height: 240, fill: '#dddddd', radius: 16 } }])
  }

  function canvasAddImage() {
    var src = fieldValue('wbCanNewImage', '')
    if (!src) return
    canvasOps([{ op: 'add', object: { type: 'image', src: src, x: 80, y: 80, width: 480, height: 360, fit: 'contain' } }])
  }

  /** A gyors gombok: KOZEPRE, NAGYOBB, KISEBB, ELORE, HATRA. Mindegyik
   *  ugyanazt a muveletet kuldi, amit az agent is kuldene -- a "tedd 30%-kal
   *  nagyobbra es kozepre" egy gombbal es egy mondattal ugyanaz. */
  function canvasQuickOp(op, id) {
    if (!id) return
    if (op === 'center') canvasOps([{ op: 'center', id: id, axis: 'both' }])
    else if (op === 'bigger') canvasOps([{ op: 'scale', id: id, factor: 1.3 }])
    else if (op === 'smaller') canvasOps([{ op: 'scale', id: id, factor: 1 / 1.3 }])
    else if (op === 'front') canvasOps([{ op: 'order', id: id, to: 'front' }])
    else if (op === 'back') canvasOps([{ op: 'order', id: id, to: 'back' }])
  }

  /** Elem kivetele. A korabbi allapot NEM vesz el (uj verzio keletkezik), de
   *  a kerdest attol meg felteszunk: a felhasznalo ne veletlenul torolje. */
  function canvasRemoveObject(id) {
    if (!id || WB.canvasBusy) return
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.canvas.remove_confirm'))) return
    canvasOps([{ op: 'remove', id: id }])
  }

  // ---- huzogatos szerkesztes: a doboz-reteg (kartya d4b05d82) ---------------
  //
  // A KEPET tovabbra is a szerver rajzolja SVG-be -- ezert egyezik a letoltott
  // kep a latottal. A huzogatashoz csak egy ATLATSZO reteg kerul a kep fole:
  // elemenkent egy doboz, szazalekban megadott helyen, igy a kep barmilyen
  // meretben jelenhet meg, a dobozok vele egyutt mozdulnak.

  /** Az objektum-doboz also/felso hatara VASZON-egysegben. A szerver 1 es
   *  8000 kozott fogadja el (CANVAS_MAX_SIZE); 8 alatt nincs mit megfogni. */
  var CANVAS_OBJ_MIN = 8
  var CANVAS_OBJ_MAX = 8000
  var CANVAS_GRIPS = ['nw', 'ne', 'sw', 'se']

  /** A huzas UJ dobozat szamolja ki. Tiszta fuggveny: `dx`/`dy` mar
   *  VASZON-egysegben ertendo, es a kimenet kerekitett egesz. Atmeretezesnel a
   *  megfogott sarok ATELLENES pontja marad helyben -- ez az, amit a kez var. */
  function canvasDragBox(from, mode, dx, dy) {
    var x = from.x, y = from.y, w = from.width, h = from.height
    if (mode === 'move') {
      x = from.x + dx
      y = from.y + dy
    } else {
      var west = mode === 'nw' || mode === 'sw'
      var north = mode === 'nw' || mode === 'ne'
      w = west ? from.width - dx : from.width + dx
      h = north ? from.height - dy : from.height + dy
      if (w < CANVAS_OBJ_MIN) w = CANVAS_OBJ_MIN
      if (h < CANVAS_OBJ_MIN) h = CANVAS_OBJ_MIN
      if (w > CANVAS_OBJ_MAX) w = CANVAS_OBJ_MAX
      if (h > CANVAS_OBJ_MAX) h = CANVAS_OBJ_MAX
      if (west) x = from.x + from.width - w
      if (north) y = from.y + from.height - h
    }
    return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
  }

  /** A doboz helye SZAZALEKBAN: a kep kicsinyitve is jo helyen all, es nem
   *  kell megmernunk a kepernyon elfoglalt meretet a kirajzolashoz. */
  function canvasBoxStyle(box, doc) {
    var pct = function (v, total) { return (Math.round((10000 * v) / total) / 100) + '%' }
    return 'left:' + pct(box.x, doc.width) + ';top:' + pct(box.y, doc.height)
      + ';width:' + pct(box.width, doc.width) + ';height:' + pct(box.height, doc.height)
  }

  function canvasBoxHtml(o, doc) {
    return '<div class="wb-can-box' + (WB.canvasSel === o.id ? ' wb-can-box-sel' : '') + '"'
      + ' data-wb-box="' + escA(o.id) + '" tabindex="0" role="button"'
      + ' title="' + escA(canvasObjectLabel(o)) + '"'
      + ' aria-label="' + escA(t('workbench.canvas.drag_aria', { name: canvasObjectLabel(o) })) + '"'
      + ' style="' + escA(canvasBoxStyle(o, doc)) + '">'
      + CANVAS_GRIPS.map(function (g) {
        return '<span class="wb-can-grip wb-can-grip-' + g + '" data-wb-grip="' + g + '" aria-hidden="true"></span>'
      }).join('')
      + '</div>'
  }

  /** A vaszon elonezete: a szerver rajzolta kep + (ha lehet) a huzogato reteg.
   *  Amikor a reteg NEM jelenik meg, azt KIMONDJUK, es megmondjuk, mi helyette
   *  az ut -- a nema hianyzas a legrosszabb valasz. */
  function canvasStageHtml(name) {
    var img = '<img class="wb-preview-image" src="' + escA(canvasSvgUrl(WB.selectedId, false)) + '"'
      + ' alt="' + escA(name) + '">'
    // A NULLA itt ket dolgot jelenthet: "meg nem toltottuk be a rajz adatait"
    // (nem tudunk dobozt rajzolni) vagy "ures a vaszon" (van reteg, nincs
    // benne doboz). A kettot KULON kezeljuk.
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc) {
      return '<div class="wb-can-stage">' + img + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_unavailable')) + '</p>'
    }
    if (archived()) {
      return '<div class="wb-can-stage">' + img + '</div>'
        + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_archived')) + '</p>'
    }
    return '<div class="wb-can-stage" data-wb-stage="1">' + img
      + '<div class="wb-can-layer">'
      + canvasObjects().map(function (o) { return canvasBoxHtml(o, doc) }).join('')
      + '</div>'
      + '<span class="wb-can-live" id="wbCanLive" aria-live="polite"></span>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.canvas.drag_hint')) + '</p>'
  }

  function canvasFormHtml(o) {
    var common = '<div class="wb-can-grid">'
      + '<label class="wb-label" for="wbCanX">' + esc(t('workbench.canvas.label_x')) + '</label>'
      + '<input class="wb-input" id="wbCanX" type="number" value="' + escA(String(o.x)) + '">'
      + '<label class="wb-label" for="wbCanY">' + esc(t('workbench.canvas.label_y')) + '</label>'
      + '<input class="wb-input" id="wbCanY" type="number" value="' + escA(String(o.y)) + '">'
      + '<label class="wb-label" for="wbCanW">' + esc(t('workbench.canvas.label_width')) + '</label>'
      + '<input class="wb-input" id="wbCanW" type="number" value="' + escA(String(o.width)) + '">'
      + '<label class="wb-label" for="wbCanH">' + esc(t('workbench.canvas.label_height')) + '</label>'
      + '<input class="wb-input" id="wbCanH" type="number" value="' + escA(String(o.height)) + '">'
      + '</div>'
    var own = ''
    if (o.type === 'text') {
      own = '<label class="wb-label" for="wbCanText">' + esc(t('workbench.canvas.label_text')) + '</label>'
        + '<textarea class="wb-input" id="wbCanText" rows="3">' + esc(o.text || '') + '</textarea>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFontSize">' + esc(t('workbench.canvas.label_font_size')) + '</label>'
        + '<input class="wb-input" id="wbCanFontSize" type="number" min="4" max="1200" value="' + escA(String(o.fontSize)) + '">'
        + '<label class="wb-label" for="wbCanColor">' + esc(t('workbench.canvas.label_color')) + '</label>'
        + '<input class="wb-input" id="wbCanColor" type="color" value="' + escA(o.color || '#111111') + '">'
        + '<label class="wb-label" for="wbCanAlign">' + esc(t('workbench.canvas.label_align')) + '</label>'
        + '<select class="wb-input" id="wbCanAlign">'
        + ['left', 'center', 'right'].map(function (a) {
          return '<option value="' + a + '"' + (o.align === a ? ' selected' : '') + '>' + esc(t('workbench.canvas.align_' + a)) + '</option>'
        }).join('') + '</select>'
        + '</div>'
        + '<p class="wb-can-checks">'
        + '<label><input type="checkbox" id="wbCanBold"' + (o.bold ? ' checked' : '') + '> ' + esc(t('workbench.canvas.label_bold')) + '</label>'
        + '<label><input type="checkbox" id="wbCanItalic"' + (o.italic ? ' checked' : '') + '> ' + esc(t('workbench.canvas.label_italic')) + '</label>'
        + '</p>'
    } else if (o.type === 'rect') {
      own = '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFill">' + esc(t('workbench.canvas.label_fill')) + '</label>'
        + '<input class="wb-input" id="wbCanFill" type="color" value="' + escA(o.fill || '#dddddd') + '">'
        + '<label class="wb-label" for="wbCanRadius">' + esc(t('workbench.canvas.label_radius')) + '</label>'
        + '<input class="wb-input" id="wbCanRadius" type="number" min="0" value="' + escA(String(o.radius)) + '">'
        + '</div>'
    } else {
      own = '<p class="wb-hint">' + esc(o.src || '') + '</p>'
        + '<div class="wb-can-grid">'
        + '<label class="wb-label" for="wbCanFit">' + esc(t('workbench.canvas.label_fit')) + '</label>'
        + '<select class="wb-input" id="wbCanFit">'
        + ['contain', 'cover'].map(function (f) {
          return '<option value="' + f + '"' + (o.fit === f ? ' selected' : '') + '>' + esc(t('workbench.canvas.fit_' + f)) + '</option>'
        }).join('') + '</select>'
        + '<label class="wb-label" for="wbCanAlt">' + esc(t('workbench.canvas.label_alt')) + '</label>'
        + '<input class="wb-input" id="wbCanAlt" type="text" value="' + escA(o.alt || '') + '">'
        + '</div>'
    }
    return '<form class="wb-can-form" id="wbCanForm">' + own + common
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="canvas-save" data-wb-obj="' + escA(o.id) + '"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(WB.canvasBusy ? t('workbench.canvas.saving') : t('workbench.canvas.save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="canvas-cancel">' + esc(t('common.cancel')) + '</button>'
      + '</div></form>'
  }

  function canvasObjectLabel(o) {
    if (o.type === 'text') return t('workbench.canvas.obj_text', { text: (o.text || '').slice(0, 40) })
    if (o.type === 'rect') return t('workbench.canvas.obj_rect')
    return t('workbench.canvas.obj_image', { name: (o.src || '').split('/').pop() })
  }

  function canvasObjectHtml(o) {
    var btn = function (act, op, label) {
      return '<button type="button" class="wb-part-btn" data-wb-act="' + act + '" data-wb-op="' + op + '" data-wb-obj="' + escA(o.id) + '"'
        + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(label) + '</button>'
    }
    return '<li class="wb-can-obj">'
      + '<div class="wb-can-obj-head">'
      + '<span class="wb-pill">' + esc(t('workbench.canvas.type_' + o.type)) + '</span>'
      + '<span class="wb-can-obj-name">' + esc(canvasObjectLabel(o)) + '</span>'
      + '<code class="wb-can-id">' + esc(o.id) + '</code>'
      + '</div>'
      + '<div class="wb-can-obj-actions">'
      + btn('canvas-op', 'center', t('workbench.canvas.center'))
      + btn('canvas-op', 'bigger', t('workbench.canvas.bigger'))
      + btn('canvas-op', 'smaller', t('workbench.canvas.smaller'))
      + btn('canvas-op', 'front', t('workbench.canvas.front'))
      + btn('canvas-op', 'back', t('workbench.canvas.back'))
      + '<button type="button" class="wb-part-btn" data-wb-act="canvas-edit" data-wb-obj="' + escA(o.id) + '">'
      + esc(t('workbench.canvas.edit')) + '</button>'
      + '<button type="button" class="wb-part-btn wb-part-btn-bad" data-wb-act="canvas-remove" data-wb-obj="' + escA(o.id) + '"'
      + (WB.canvasBusy ? ' disabled' : '') + '>' + esc(t('workbench.canvas.remove')) + '</button>'
      + '</div>'
      + (WB.canvasEdit === o.id ? canvasFormHtml(o) : '')
      + '</li>'
  }

  function canvasAddHtml() {
    var images = canvasImageChoices()
    return '<div class="wb-can-add">'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-text"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_text')) + '</button>'
      + '<button type="button" class="wb-btn" data-wb-act="canvas-add-rect"' + (WB.canvasBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.canvas.add_rect')) + '</button>'
      + (images.length
        ? '<select class="wb-input wb-can-pick" id="wbCanNewImage">'
          + images.map(function (p) {
            return '<option value="' + escA(p.asset_path) + '">' + esc((p.asset_path || '').split('/').pop()) + '</option>'
          }).join('') + '</select>'
          + '<button type="button" class="wb-btn" data-wb-act="canvas-add-image"' + (WB.canvasBusy ? ' disabled' : '') + '>'
          + esc(t('workbench.canvas.add_image')) + '</button>'
        // A nulla itt "meg nincs feltoltott kep" -- es megmondjuk, HOL lehet.
        : '<span class="wb-hint">' + esc(t('workbench.canvas.no_images')) + '</span>')
      + '</div>'
  }

  function canvasHtml() {
    var it = WB.detail && WB.detail.item
    if (!it) return ''
    var isCanvas = !!(WB.canvas && WB.canvas.exists) || (WB.preview && WB.preview.kind === 'canvas')
    // Nem rajz-fajta munkadarabnal es rajz nelkul nincs mit mutatni -- ne
    // alljon ott egy ures doboz.
    if (!canvasKind(it) && !isCanvas) return ''
    var head = '<div class="wb-can-head"><h4>' + esc(t('workbench.canvas.title')) + '</h4>'
      + (WB.canvas && WB.canvas.canvas
        ? '<span class="wb-muted">' + esc(t('workbench.canvas.size', { w: WB.canvas.canvas.width, h: WB.canvas.canvas.height })) + '</span>'
        : '')
      + '</div>'
    if (WB.canvasError) {
      return '<div class="wb-can">' + head
        + '<p class="wb-preview-bad">' + esc(WB.canvasError.message || '') + '</p>'
        + (WB.canvasError.detail ? '<p class="wb-hint">' + esc(WB.canvasError.detail) + '</p>' : '')
        + '<p><button type="button" class="wb-btn" data-wb-act="canvas-refresh">' + esc(t('workbench.canvas.refresh')) + '</button></p>'
        + '</div>'
    }
    if (WB.canvas === null) {
      return '<div class="wb-can">' + head + '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p></div>'
    }
    if (!WB.canvas.exists) {
      // MEG NINCS RAJZ. Ez kezdoallapot, nem hiba -- es van belole ut tovabb.
      return '<div class="wb-can">' + head
        + '<div class="wb-empty">'
        + '<p class="wb-empty-title">' + esc(t('workbench.canvas.none_title')) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.canvas.none_hint')) + '</p>'
        + '<p><button type="button" class="btn-primary" data-wb-act="canvas-start"' + (WB.canvasBusy || archived() ? ' disabled' : '') + '>'
        + esc(WB.canvasBusy ? t('workbench.canvas.starting') : t('workbench.canvas.start')) + '</button></p>'
        + '</div></div>'
    }
    var objects = canvasObjects()
    return '<div class="wb-can">' + head
      + '<p class="wb-hint">' + esc(t('workbench.canvas.intro')) + '</p>'
      + (archived() ? '' : canvasAddHtml())
      + (objects.length
        ? '<ul class="wb-can-objs">' + objects.map(canvasObjectHtml).join('') + '</ul>'
        : '<p class="wb-muted">' + esc(t('workbench.canvas.empty')) + '</p>')
      + '<p class="wb-hint"><a href="' + escA(canvasSvgUrl(it.id, true)) + '" target="_blank" rel="noopener">'
      + esc(t('workbench.canvas.download')) + '</a></p>'
      + '</div>'
  }

  /** Munkadarab-valto a szerkeszto tetejen (#359, Boss 1249): a munkadarabok
   *  kozott innen is valtani lehet, akkor is, ha a lista nem latszik (mobilon
   *  egyszerre egy panel van kint, es a kattintas ide, a kozepso panelre visz). */
  function switcherHtml() {
    var items = WB.items || []
    if (items.length < 2) return ''
    var idx = -1
    for (var i = 0; i < items.length; i++) if (items[i].id === WB.selectedId) idx = i
    var opts = (idx < 0 ? '<option value="" selected>' + esc(t('workbench.switch.choose')) + '</option>' : '')
      + items.map(function (it, j) {
        return '<option value="' + escA(it.id) + '"' + (j === idx ? ' selected' : '') + '>' + esc((j + 1) + '. ' + it.title) + '</option>'
      }).join('')
    var prev = idx > 0 ? items[idx - 1].id : ''
    var next = idx >= 0 && idx < items.length - 1 ? items[idx + 1].id : (idx < 0 ? items[0].id : '')
    return '<div class="wb-switch">'
      + '<button type="button" class="btn-secondary btn-compact" data-wb-item="' + escA(prev) + '"' + (prev ? '' : ' disabled')
      + ' title="' + escA(t('workbench.switch.prev')) + '" aria-label="' + escA(t('workbench.switch.prev')) + '">‹</button>'
      + '<label class="wb-switch-label" for="wbSwitch">' + esc(t('workbench.switch.label')) + '</label>'
      + '<select class="wb-input wb-switch-select" id="wbSwitch">' + opts + '</select>'
      + '<button type="button" class="btn-secondary btn-compact" data-wb-item="' + escA(next) + '"' + (next ? '' : ' disabled')
      + ' title="' + escA(t('workbench.switch.next')) + '" aria-label="' + escA(t('workbench.switch.next')) + '">›</button>'
      + '</div>'
  }

  /** Osztott nezetben a jobb oldal akkor sem ures, ha meg nincs kivalasztva
   *  semmi: a munkadarabok egy kattintasra ott vannak, es uj is indithato. */
  function splitPickHtml() {
    var items = WB.items || []
    var list = items.length
      ? '<ul class="wb-split-pick">' + items.slice(0, 8).map(function (it) {
        return '<li><button type="button" class="wb-item" data-wb-item="' + escA(it.id) + '">'
          + '<span class="wb-item-title">' + esc(it.title) + '</span>'
          + '<span class="wb-item-meta">' + esc(typeLabel(it.type)) + ' · ' + esc(statusLabel(it.status)) + '</span>'
          + '</button></li>'
      }).join('') + '</ul>'
      : ''
    var more = items.length > 8 ? '<p class="wb-hint">' + esc(t('workbench.split.more', { n: items.length - 8 })) + '</p>' : ''
    var add = archived() ? '' : '<p><button type="button" class="btn-secondary" data-wb-act="new">' + esc(t('workbench.new_item')) + '</button></p>'
    return list + more + add
  }

  // ---- verziok egymas mellett + egygombos visszavonas (#406, 5. pont) --------
  //
  // VISSZAVONAS: a mostani elotti verzio allapota lesz UJ verziokent (a
  // visszaallitas nem torol semmit, ezert nem kell megerositeni -- ez a szakmai
  // gyakorlat: a visszavonhato lepes nem kerdez). A "visszavonas visszavonasa"
  // ugyanez: a lista legfelso verzioja ott marad.
  //
  // OSSZEHASONLITAS: ket verzio egymas mellett. Kepnel/rajznal egy csuszka
  // huzza szet a ket kepet (elotte / utana); szovegnel a torolt es az uj szavak
  // kiemelve. Telefonon a ket oszlop egymas ala kerul, a csuszka ujjal is megy.

  function versionsSorted() {
    var list = ((WB.detail && WB.detail.versions) || []).slice()
    list.sort(function (a, b) { return b.version_no - a.version_no })
    return list
  }

  function currentVersion() {
    var it = WB.detail && WB.detail.item
    var found = null
    versionsSorted().forEach(function (v) { if (it && v.id === it.current_version_id) found = v })
    return found
  }

  /** A mostani ELOTTI verzio (sorszam szerint) -- a visszavonas celja. */
  function undoTarget() {
    var cur = currentVersion()
    if (!cur) return null
    var best = null
    versionsSorted().forEach(function (v) {
      if (v.version_no < cur.version_no && (!best || v.version_no > best.version_no)) best = v
    })
    return best
  }

  function versionBarHtml() {
    var versions = versionsSorted()
    var exportBtn = '<button type="button" class="btn-secondary btn-compact" data-wb-act="' + (exportIsOpen() ? 'export-close' : 'export-open') + '"'
      + ' aria-expanded="' + exportIsOpen() + '">' + esc(t('workbench.exp.open')) + '</button>'
    if (versions.length < 2) return '<div class="wb-vbar">' + exportBtn + '</div>' + (exportIsOpen() ? exportPanelHtml() : '')
    var target = undoTarget()
    var ro = archived() || WB.versionBusy
    return '<div class="wb-vbar">'
      + (ro || !target ? '' : '<button type="button" class="btn-secondary btn-compact" data-wb-act="version-undo"'
        + ' title="' + escA(t('workbench.cmp.undo_hint', { n: target.version_no })) + '">'
        + esc(t('workbench.cmp.undo', { n: target.version_no })) + '</button>')
      + (WB.compare && WB.compare.itemId === WB.selectedId
        ? '<button type="button" class="btn-secondary btn-compact" data-wb-act="compare-close">' + esc(t('workbench.cmp.close')) + '</button>'
        : '<button type="button" class="btn-secondary btn-compact" data-wb-act="compare-open">' + esc(t('workbench.cmp.open')) + '</button>')
      + exportBtn
      + '</div>'
      + (exportIsOpen() ? exportPanelHtml() : '')
  }

  // ---- export PDF / kep + kuldes a jovahagyasi kapun at (#406, 6. pont) -----
  //
  // PDF: a munkadarab nyomtathato lapja uj lapon nyilik, es a bongeszo
  // "Mentes PDF-kent" utja keszit belole PDF-et -- kulso program nelkul,
  // telefonon is (Megosztas -> Nyomtatas). KEP: a bongeszo rajzolja PNG-be.
  // KULDES: a Munkapad SOHA nem kuld ki semmit maga; a gomb a meglevo
  // jovahagyasi kapun at jegyet nyit, es kifele csak a tulajdonos igen-je
  // utan megy barmi (a fo agens kuldi).

  function exportIsOpen() { return !!(WB.exportOpen && WB.exportOpen === WB.selectedId) }

  function itemUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + tail
  }

  function exportPageUrl(extra) {
    return itemUrl('/export.html') + '?lang=' + encodeURIComponent(window._lang || 'hu')
      + (WB.previewVersion ? '&version=' + encodeURIComponent(WB.previewVersion) : '')
      + (extra || '')
  }

  /** Mibol lehet kepet (PNG) csinalni: a kep maga, a rajz, vagy a reszek. */
  function pngSource() {
    var p = WB.preview
    if (!p) return null
    if (p.available && p.kind === 'image') return 'image'
    if (p.kind === 'canvas') return 'canvas'
    if (p.available && (p.kind === 'parts' || p.kind === 'text')) return 'blocks'
    if (!p.available && p.reason === 'no_source' && partsOf().length) return 'blocks'
    return null
  }

  function exportPanelHtml() {
    var p = WB.preview || {}
    var png = pngSource()
    var rows = []
    rows.push('<div class="wb-exp-row"><button type="button" class="btn-primary" data-wb-act="export-print">' + esc(t('workbench.exp.pdf')) + '</button>'
      + '<span class="wb-hint">' + esc(t('workbench.exp.pdf_hint')) + '</span></div>')
    if (p.kind === 'office' && p.url) {
      rows.push('<div class="wb-exp-row"><a class="btn-secondary" href="' + escA(p.url) + '&download=1" target="_blank" rel="noopener">' + esc(t('workbench.exp.office_pdf')) + '</a></div>')
    }
    rows.push('<div class="wb-exp-row">'
      + (png ? '<button type="button" class="btn-secondary" data-wb-act="export-png"' + (WB.pngBusy ? ' disabled' : '') + '>'
        + esc(WB.pngBusy ? t('workbench.exp.png_busy') : t('workbench.exp.png')) + '</button>' : '')
      + '<a class="btn-secondary" href="' + escA(exportPageUrl('&download=1')) + '" download>' + esc(t('workbench.exp.html')) + '</a>'
      + (p.rel ? '<a class="btn-secondary" href="/api/life/file?rel=' + escA(encodeURIComponent(p.rel)) + '&download=1" target="_blank" rel="noopener">'
        + esc(t('workbench.exp.source')) + '</a>' : '')
      + '</div>')
    if (!png) rows.push('<p class="wb-hint">' + esc(t('workbench.exp.png_none')) + '</p>')
    return '<div class="wb-exp" role="region" aria-label="' + escA(t('workbench.exp.open')) + '">'
      + '<h4 class="wb-exp-title">' + esc(t('workbench.exp.title')) + '</h4>'
      + rows.join('')
      + sendHtml()
      + '</div>'
  }

  function sendState() {
    var st = WB.send
    return st && st.itemId === WB.selectedId ? st : null
  }

  function sendHtml() {
    var st = sendState()
    var head = '<h4 class="wb-exp-title">' + esc(t('workbench.exp.send_title')) + '</h4>'
      + '<p class="wb-hint">' + esc(t('workbench.exp.send_gate')) + '</p>'
    if (st && st.result) {
      var status = st.result.status || 'pending'
      return head + '<div class="wb-exp-sent wb-exp-sent-' + escA(status) + '">'
        + '<p>' + esc(t('workbench.exp.send_status.' + (['pending', 'approved', 'rejected', 'timeout', 'withdrawn'].indexOf(status) >= 0 ? status : 'other'), { status: status })) + '</p>'
        + (st.statusError ? '<p class="wb-preview-bad">' + esc(t('workbench.exp.send_status_unknown', { message: st.statusError })) + '</p>' : '')
        + '<p><button type="button" class="btn-secondary btn-compact" data-wb-act="send-refresh">' + esc(t('workbench.exp.send_refresh')) + '</button> '
        + '<button type="button" class="wb-linklike" data-wb-act="goto-approvals">' + esc(t('workbench.ov.goto_approvals')) + '</button> '
        + '<button type="button" class="wb-linklike" data-wb-act="send-new">' + esc(t('workbench.exp.send_new')) + '</button></p>'
        + '</div>'
    }
    if (archived()) return head + '<p class="wb-muted">' + esc(t('workbench.archived_hint')) + '</p>'
    var p = WB.preview || {}
    var d = (st && st.draft) || {}
    var busy = st && st.busy
    return head + '<form class="wb-form wb-exp-send" id="wbSendForm">'
      + '<label class="wb-label" for="wbSendTo">' + esc(t('workbench.exp.send_to')) + '</label>'
      + '<input class="wb-input" id="wbSendTo" type="email" inputmode="email" autocomplete="email" placeholder="' + escA(t('workbench.exp.send_to_ph')) + '" value="' + escA(d.to || '') + '">'
      + '<label class="wb-label" for="wbSendSubject">' + esc(t('workbench.exp.send_subject')) + '</label>'
      + '<input class="wb-input" id="wbSendSubject" type="text" maxlength="200" value="' + escA(d.subject != null ? d.subject : ((WB.detail && WB.detail.item && WB.detail.item.title) || '')) + '">'
      + '<label class="wb-label" for="wbSendMessage">' + esc(t('workbench.exp.send_message')) + '</label>'
      + '<textarea class="wb-input" id="wbSendMessage" rows="3" maxlength="5000">' + esc(d.message || '') + '</textarea>'
      + '<label class="wb-label" for="wbSendAttach">' + esc(t('workbench.exp.send_attach')) + '</label>'
      + '<select class="wb-input" id="wbSendAttach">'
      + '<option value="html"' + (d.attachment !== 'source' ? ' selected' : '') + '>' + esc(t('workbench.exp.attach_html')) + '</option>'
      + (p.rel ? '<option value="source"' + (d.attachment === 'source' ? ' selected' : '') + '>' + esc(t('workbench.exp.attach_source', { name: p.name || '' })) + '</option>' : '')
      + '</select>'
      + (st && st.error ? '<p class="wb-preview-bad">' + esc(st.error) + '</p>' : '')
      + '<div class="wb-form-actions"><button type="submit" class="btn-primary" data-wb-act="send-request"' + (busy ? ' disabled' : '') + '>'
      + esc(busy ? t('workbench.exp.send_busy') : t('workbench.exp.send_submit')) + '</button></div>'
      + '</form>'
  }

  function fieldVal(id) {
    var el = document.getElementById(id)
    return el && typeof el.value === 'string' ? el.value : ''
  }

  function readSendDraft() {
    return {
      to: fieldVal('wbSendTo').trim(),
      subject: fieldVal('wbSendSubject'),
      message: fieldVal('wbSendMessage'),
      attachment: fieldVal('wbSendAttach') || 'html',
    }
  }

  function sendRequest() {
    if (!WB.selectedId || archived()) return
    var cur = sendState()
    if (cur && cur.busy) return
    var itemId = WB.selectedId
    var draft = readSendDraft()
    if (!draft.to) {
      WB.send = { itemId: itemId, draft: draft, error: t('workbench.exp.send_to_missing') }
      render()
      return
    }
    WB.send = { itemId: itemId, draft: draft, busy: true }
    render()
    api('POST', itemUrl('/send-request'), {
      to: draft.to, subject: draft.subject, message: draft.message, attachment: draft.attachment,
      version: WB.previewVersion || null,
    }).then(function (r) {
      if (!WB.send || WB.send.itemId !== itemId) return
      if (!r.ok) {
        WB.send = { itemId: itemId, draft: draft, error: r.message + (r.data && r.data.detail ? ' (' + r.data.detail + ')' : '') }
        render()
        return
      }
      WB.send = { itemId: itemId, draft: draft, result: { approval_id: r.data.approval_id, status: r.data.status || 'pending' } }
      render()
      window.showToast((r.data && r.data.message) || t('workbench.exp.send_status.pending'))
      load(WB.projectId)
    })
  }

  /** A jegy allapota a Jovahagyasok forrasabol -- sosem emlekezetbol. */
  function refreshSendStatus() {
    var st = sendState()
    if (!st || !st.result) return
    api('GET', '/api/approvals/' + encodeURIComponent(st.result.approval_id)).then(function (r) {
      if (WB.send !== st) return
      if (!r.ok) { st.statusError = r.message; render(); return }
      st.statusError = null
      var a = r.data && (r.data.approval || r.data)
      if (a && a.status) st.result.status = a.status
      render()
    })
  }

  function openPrint() {
    if (!WB.selectedId) return
    // Uj lap: ott a bongeszo sajat nyomtatasa (Mentes PDF-kent) megy, telefonon
    // is. Ha a felugro ablakot a bongeszo letiltja, a lap LINKKENT ott marad.
    var w = typeof window.open === 'function' ? window.open(exportPageUrl('&print=1'), '_blank', 'noopener') : null
    if (!w) window.showToast(t('workbench.exp.popup_blocked'))
  }

  function downloadBlob(blob, name) {
    if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a) }, 1000)
    return true
  }

  function loadImg(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image()
      im.onload = function () { resolve(im) }
      im.onerror = function () { reject(new Error(src)) }
      im.src = src
    })
  }

  function wrapLines(ctx, text, maxW) {
    var out = []
    String(text || '').split('\n').forEach(function (para) {
      var words = para.split(/\s+/)
      var line = ''
      words.forEach(function (w) {
        var test = line ? line + ' ' + w : w
        if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w } else line = test
      })
      out.push(line)
    })
    return out
  }

  /** A munkadarab kepe PNG-ben. A kep-fajtanal az eredeti fajl jon (nincs
   *  minosegromlas); a rajzot es a vegyes tartalmat a bongeszo rajzolja ki. */
  function exportPng() {
    var src = pngSource()
    if (!src || WB.pngBusy || !WB.detail) return
    var title = (WB.detail.item && WB.detail.item.title) || 'munkadarab'
    var p = WB.preview
    if (src === 'image') {
      window.open('/api/life/file?rel=' + encodeURIComponent(p.rel) + '&download=1', '_blank', 'noopener')
      return
    }
    WB.pngBusy = true
    render()
    var done = function (ok, msg) {
      WB.pngBusy = false
      render()
      window.showToast(ok ? t('workbench.exp.png_done') : t('workbench.exp.png_failed', { message: msg || '' }))
    }
    var width = 1080
    var pad = 48
    var blocks
    if (src === 'canvas') {
      blocks = [{ img: canvasSvgUrl(WB.selectedId, false) }]
    } else if (p && p.available && p.kind === 'text') {
      blocks = [{ text: p.text || '' }]
    } else {
      blocks = partsOf().map(function (x) { return x.kind === 'image' ? { img: partImageSrc(x), caption: x.caption } : { text: x.text || '' } })
    }
    Promise.all(blocks.map(function (b) { return b.img ? loadImg(b.img).then(function (im) { b.el = im; return b }) : Promise.resolve(b) })).then(function () {
      var cv = document.createElement('canvas')
      var ctx = cv.getContext('2d')
      ctx.font = '32px sans-serif'
      var inner = width - pad * 2
      var h = pad
      blocks.forEach(function (b) {
        if (b.el) { b.h = Math.round(b.el.naturalHeight * Math.min(1, inner / (b.el.naturalWidth || inner))); b.w = Math.round(b.el.naturalWidth * (b.h / (b.el.naturalHeight || 1))); h += b.h + (b.caption ? 44 : 0) + 24 }
        else { b.lines = wrapLines(ctx, b.text, inner); h += b.lines.length * 44 + 24 }
      })
      cv.width = width
      cv.height = Math.max(h + pad - 24, 200)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.fillStyle = '#111111'
      ctx.font = '32px sans-serif'
      ctx.textBaseline = 'top'
      var y = pad
      blocks.forEach(function (b) {
        if (b.el) {
          ctx.drawImage(b.el, pad + Math.round((inner - b.w) / 2), y, b.w, b.h)
          y += b.h
          if (b.caption) { ctx.font = 'italic 28px sans-serif'; ctx.fillText(b.caption, pad, y + 8); ctx.font = '32px sans-serif'; y += 44 }
        } else {
          b.lines.forEach(function (ln) { ctx.fillText(ln, pad, y); y += 44 })
        }
        y += 24
      })
      cv.toBlob(function (blob) {
        done(downloadBlob(blob, title.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.png'))
      }, 'image/png')
    }).catch(function (e) { done(false, e && e.message) })
  }

  function undoVersion() {
    var target = undoTarget()
    if (!target || !WB.selectedId || WB.versionBusy || archived()) return
    var cur = currentVersion()
    WB.versionBusy = true
    render()
    api('POST', versionsUrl('/' + encodeURIComponent(target.id) + '/restore'), {}).then(function (r) {
      WB.versionBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      if (WB.compare) WB.compare = null
      applyVersions(r.data)
      window.showToast(t('workbench.cmp.undone', {
        from: cur ? cur.version_no : '', to: target.version_no,
        n: r.data && r.data.version ? r.data.version.version_no : '',
      }))
    })
  }

  function openCompare() {
    var versions = versionsSorted()
    if (versions.length < 2 || !WB.selectedId) return
    var right = currentVersion() || versions[0]
    var left = undoTarget() || versions[1]
    WB.compare = { itemId: WB.selectedId, left: left.id, right: right.id, pos: 50, sides: {} }
    render()
    loadCompareSide(left.id)
    loadCompareSide(right.id)
  }

  /** Egy verzio adata az osszehasonlitashoz: az elonezet (mit mutat) + a
   *  reszei. A ketto kulon keres: ha az egyik elbukik, azt KULON mondjuk. */
  function loadCompareSide(vid) {
    var cmp = WB.compare
    if (!cmp || !vid || cmp.sides[vid]) return
    var itemId = cmp.itemId
    var side = { preview: null, parts: null, error: null }
    cmp.sides[vid] = side
    var base = '/api/workbench/items/' + encodeURIComponent(itemId)
    var still = function () { return WB.compare === cmp && WB.selectedId === itemId }
    api('GET', base + '/preview?version=' + encodeURIComponent(vid)).then(function (r) {
      if (!still()) return
      if (r.ok) side.preview = r.data
      else side.error = r.message
      render()
    })
    api('GET', base + '/versions/' + encodeURIComponent(vid) + '/parts').then(function (r) {
      if (!still()) return
      if (r.ok) side.parts = (r.data && r.data.parts) || []
      else side.error = r.message
      render()
    })
  }

  function versionLabel(vid) {
    var found = null
    versionsSorted().forEach(function (v) { if (v.id === vid) found = v })
    return found ? t('workbench.versions.line', { n: found.version_no, when: when(found.created_at) }) : '-'
  }

  function compareSelectHtml(id, value) {
    return '<select class="wb-input wb-cmp-select" id="' + id + '">' + versionsSorted().map(function (v) {
      return '<option value="' + escA(v.id) + '"' + (v.id === value ? ' selected' : '') + '>'
        + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) })) + '</option>'
    }).join('') + '</select>'
  }

  /** Kep (vagy rajz) cime egy verziohoz; `null`, ha a verzio nem kep. */
  function compareImageUrl(side, vid) {
    var p = side && side.preview
    if (!p || !p.available) return null
    if (p.kind === 'image' && p.url) return p.url
    if (p.kind === 'canvas') {
      return '/api/workbench/items/' + encodeURIComponent(WB.compare.itemId) + '/canvas.svg?version='
        + encodeURIComponent(vid) + '&lang=' + encodeURIComponent(window._lang || 'hu')
    }
    return null
  }

  /** Szo-szintu kulonbseg (LCS). Tul hosszu szovegnel nem szamolunk (a
   *  bongeszo ne akadjon meg): akkor a ket szoveg kiemeles nelkul all. */
  function diffTokens(a, b) {
    var x = String(a || '').split(/(\s+)/)
    var y = String(b || '').split(/(\s+)/)
    if (x.length * y.length > 400000) return null
    var n = x.length
    var m = y.length
    var dp = []
    for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)) }
    for (var i2 = n - 1; i2 >= 0; i2--) {
      for (var j2 = m - 1; j2 >= 0; j2--) {
        dp[i2][j2] = x[i2] === y[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1])
      }
    }
    var left = []
    var right = []
    var p = 0
    var q = 0
    while (p < n && q < m) {
      if (x[p] === y[q]) { left.push(esc(x[p])); right.push(esc(y[q])); p++; q++ }
      else if (dp[p + 1][q] >= dp[p][q + 1]) { left.push(/^\s+$/.test(x[p]) ? esc(x[p]) : '<del class="wb-cmp-del">' + esc(x[p]) + '</del>'); p++ }
      else { right.push(/^\s+$/.test(y[q]) ? esc(y[q]) : '<ins class="wb-cmp-ins">' + esc(y[q]) + '</ins>'); q++ }
    }
    for (; p < n; p++) left.push(/^\s+$/.test(x[p]) ? esc(x[p]) : '<del class="wb-cmp-del">' + esc(x[p]) + '</del>')
    for (; q < m; q++) right.push(/^\s+$/.test(y[q]) ? esc(y[q]) : '<ins class="wb-cmp-ins">' + esc(y[q]) + '</ins>')
    return { left: left.join(''), right: right.join('') }
  }

  /** Egy verzio szoveges tartalma: a szoveg-reszek egymas utan, vagy a
   *  szovegfajl. `null` = nincs benne szoveg. */
  function compareText(side) {
    if (!side) return null
    var p = side.preview
    if (p && p.available && p.kind === 'text') return String(p.text || '')
    var texts = (side.parts || []).filter(function (x) { return x.kind === 'text' }).map(function (x) { return x.text || '' })
    return texts.length ? texts.join('\n\n') : null
  }

  function compareImagesOf(side) {
    return (side && side.parts ? side.parts : []).filter(function (x) { return x.kind === 'image' })
  }

  function compareBodyHtml() {
    var cmp = WB.compare
    var L = cmp.sides[cmp.left]
    var R = cmp.sides[cmp.right]
    var errors = [L, R].filter(function (sd) { return sd && sd.error }).map(function (sd) { return sd.error })
    if (errors.length) return '<p class="wb-preview-bad">' + esc(t('workbench.cmp.error', { message: errors[0] })) + '</p>'
    if (!L || !R || !L.preview || !R.preview || L.parts === null || R.parts === null) {
      return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    }
    if (cmp.left === cmp.right) return '<p class="wb-muted">' + esc(t('workbench.cmp.same')) + '</p>'
    var out = ''
    // KEP / RAJZ: csuszka. Alul az UJ (jobb), folotte a REGI (bal), a regi
    // annyira latszik, amennyire a csuszka all.
    var li = compareImageUrl(L, cmp.left)
    var ri = compareImageUrl(R, cmp.right)
    if (li && ri) {
      out += '<div class="wb-cmp-slide">'
        + '<img class="wb-cmp-img" src="' + escA(ri) + '" alt="' + escA(versionLabel(cmp.right)) + '">'
        + '<img class="wb-cmp-img wb-cmp-top" id="wbCmpTop" src="' + escA(li) + '" alt="' + escA(versionLabel(cmp.left)) + '"'
        + ' style="clip-path: inset(0 ' + (100 - cmp.pos) + '% 0 0)">'
        + '<div class="wb-cmp-line" id="wbCmpLine" style="left: ' + cmp.pos + '%"></div>'
        + '</div>'
        + '<label class="wb-label" for="wbCmpSlider">' + esc(t('workbench.cmp.slider')) + '</label>'
        + '<input type="range" class="wb-cmp-range" id="wbCmpSlider" min="0" max="100" step="1" value="' + cmp.pos + '">'
    }
    // SZOVEG: egymas mellett, a valtozas kiemelve.
    var lt = compareText(L)
    var rt = compareText(R)
    if (lt !== null || rt !== null) {
      var d = diffTokens(lt || '', rt || '')
      out += '<div class="wb-cmp-cols">'
        + '<div class="wb-cmp-col"><div class="wb-cmp-col-head">' + esc(t('workbench.cmp.before')) + ' — ' + esc(versionLabel(cmp.left)) + '</div>'
        + '<div class="wb-cmp-text">' + (d ? d.left : esc(lt || '')) + '</div></div>'
        + '<div class="wb-cmp-col"><div class="wb-cmp-col-head">' + esc(t('workbench.cmp.after')) + ' — ' + esc(versionLabel(cmp.right)) + '</div>'
        + '<div class="wb-cmp-text">' + (d ? d.right : esc(rt || '')) + '</div></div>'
        + '</div>'
        + (d ? '' : '<p class="wb-hint">' + esc(t('workbench.cmp.too_long')) + '</p>')
        + (lt === rt ? '<p class="wb-hint">' + esc(t('workbench.cmp.text_same')) + '</p>' : '')
    }
    // KEP-RESZEK egymas mellett (a vegyes munkadarab kepei).
    var lims = compareImagesOf(L)
    var rims = compareImagesOf(R)
    if (lims.length || rims.length) {
      var col = function (list) {
        return list.length ? list.map(function (x) {
          return '<img class="wb-cmp-thumb" src="' + escA(partImageSrc(x)) + '" alt="' + escA(x.caption || t('workbench.parts.image_alt')) + '">'
        }).join('') : '<p class="wb-muted">' + esc(t('workbench.cmp.no_images')) + '</p>'
      }
      out += '<div class="wb-cmp-cols">'
        + '<div class="wb-cmp-col">' + col(lims) + '</div>'
        + '<div class="wb-cmp-col">' + col(rims) + '</div></div>'
    }
    if (!out) {
      // Pl. PDF, video: itt nem tudjuk egymasra tenni, de mindkettot meg lehet nyitni.
      var link = function (sd) {
        var p = sd.preview
        var u = p && p.available && p.url ? p.url : (p && p.rel ? '/api/life/file?rel=' + encodeURIComponent(p.rel) : null)
        return u ? '<a href="' + escA(u) + '" target="_blank" rel="noopener">' + esc((p && p.name) || t('workbench.preview.open_new_tab')) + '</a>'
          : '<span class="wb-muted">' + esc((p && p.message) || t('workbench.preview.none')) + '</span>'
      }
      out = '<p class="wb-muted">' + esc(t('workbench.cmp.unsupported')) + '</p>'
        + '<div class="wb-cmp-cols"><div class="wb-cmp-col">' + link(L) + '</div><div class="wb-cmp-col">' + link(R) + '</div></div>'
    }
    return out
  }

  function compareHtml() {
    var cmp = WB.compare
    var ro = archived() || WB.versionBusy
    var cur = currentVersion()
    return '<div class="wb-cmp">'
      + '<div class="wb-cmp-head">'
      + '<div><label class="wb-label" for="wbCmpLeft">' + esc(t('workbench.cmp.before')) + '</label>' + compareSelectHtml('wbCmpLeft', cmp.left) + '</div>'
      + '<div><label class="wb-label" for="wbCmpRight">' + esc(t('workbench.cmp.after')) + '</label>' + compareSelectHtml('wbCmpRight', cmp.right) + '</div>'
      + '</div>'
      + compareBodyHtml()
      + (ro || (cur && cur.id === cmp.left) ? '' : '<p><button type="button" class="btn-secondary" data-wb-act="version-restore" data-wb-version="' + escA(cmp.left) + '">'
        + esc(t('workbench.cmp.restore_left')) + '</button></p>')
      + '</div>'
  }

  function editorPanelHtml() {
    var inner
    if (!WB.selectedId) {
      inner = '<p class="wb-muted wb-center">' + esc(t(WB.layout === 'split' ? 'workbench.split.none' : 'workbench.editor.none')) + '</p>'
        + (WB.layout === 'split' ? splitPickHtml() : '')
    } else if (!WB.detail) {
      inner = '<p class="wb-muted wb-center">' + esc(t('workbench.loading')) + '</p>'
    } else {
      var it = WB.detail.item
      inner = '<div class="wb-editor-head"><h3>' + esc(it.title) + '</h3>'
        + '<span class="wb-pill">' + esc(typeLabel(it.type)) + '</span>'
        + '<span class="wb-pill">' + esc(statusLabel(it.status)) + '</span></div>'
        + approvalBoxHtml()
        + todosBoxHtml()
        + versionBarHtml()
        + (WB.compare && WB.compare.itemId === WB.selectedId
          ? compareHtml()
          : (archived() ? '' : '<p class="wb-hint wb-drop-item-hint">' + esc(t(WB.upload
            ? 'workbench.upload.busy'
            : 'workbench.upload.drop_item')) + '</p>')
            + previewHtml()
            + canvasHtml()
            + partsHtml())
    }
    var dropAttr = WB.selectedId && WB.detail && !archived() ? ' data-wb-drop="item"' : ''
    return '<section class="wb-panel wb-panel-editor' + (WB.panel === 'editor' ? ' wb-panel-current' : '') + '" data-wb-panel-body="editor"' + dropAttr + '>'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.editor')) + '</h2>'
      + switcherHtml()
      + inner + '</section>'
  }

  function contextPanelHtml() {
    var rows = []
    rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.project')) + '</h3>'
      + '<p>' + esc(WB.project ? WB.project.name : '-') + '</p></div>')
    if (WB.detail) {
      var it = WB.detail.item
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.work_item')) + '</h3>'
        + '<p>' + esc(it.title) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.context.created', { when: when(it.created_at) })) + '</p>'
        + '<p class="wb-muted">' + esc(t('workbench.context.updated', { when: when(it.updated_at) })) + '</p></div>')
      var versions = WB.detail.versions || []
      var ro = archived() || WB.versionBusy
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.versions')) + '</h3>'
        + (versions.length
          ? '<ul class="wb-versions">' + versions.map(function (v) {
            var current = v.id === it.current_version_id
            // A JELENLEGIT nincs mire visszaallitani; a regihez ott a gomb, es a
            // kattintas elott KIMONDJUK, hogy a kesobbi verziok megmaradnak.
            var back = (current || ro) ? '' : (' <button type="button" class="wb-linklike" data-wb-act="version-restore"'
              + ' data-wb-version="' + escA(v.id) + '">' + esc(t('workbench.versions.restore')) + '</button>')
            return '<li>' + esc(t('workbench.versions.line', { n: v.version_no, when: when(v.created_at) }))
              + (current ? ' <span class="wb-pill">' + esc(t('workbench.versions.current')) + '</span>' : '')
              + (v.restored_from_no ? ' <span class="wb-muted">'
                + esc(t('workbench.versions.restored_from', { n: v.restored_from_no })) + '</span>' : '')
              + back + '</li>'
          }).join('') + '</ul>'
          : '<p class="wb-muted">' + esc(t('workbench.context.no_versions')) + '</p>')
        + (ro ? '' : '<p><button type="button" class="wb-btn" data-wb-act="version-new">'
          + esc(t('workbench.versions.save_new')) + '</button></p>')
        // A KOR BEZARASA (spec 8): letoltod, megszerkeszted a sajat gepeden,
        // visszatoltod -- es UJ VERZIO lesz belole. A regi megmarad.
        + (ro ? '' : '<p><label class="wb-btn wb-part-upload" for="wbDocUpload">'
          + esc(WB.docBusy ? t('workbench.versions.uploading') : t('workbench.versions.upload_document')) + '</label>'
          + '<input type="file" id="wbDocUpload" class="wb-file-input"></p>'
          + '<p class="wb-hint">' + esc(t('workbench.versions.upload_document_hint')) + '</p>')
        + '<p class="wb-hint">' + esc(t('workbench.versions.hint')) + '</p>'
        + '</div>')
    } else {
      rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.work_item')) + '</h3>'
        + '<p class="wb-muted">' + esc(t('workbench.context.no_selection')) + '</p></div>')
    }
    rows.push('<div class="wb-ctx-block"><h3>' + esc(t('workbench.context.kanban')) + '</h3>'
      + '<p class="wb-muted">' + esc(t('workbench.context.kanban_soon')) + '</p></div>')
    return '<section class="wb-panel wb-panel-context' + (WB.panel === 'context' ? ' wb-panel-current' : '') + '" data-wb-panel-body="context">'
      + '<h2 class="wb-panel-title">' + esc(t('workbench.panel.context')) + '</h2>'
      + rows.join('') + '</section>'
  }

  // ---- agent-chat (3. fazis) -------------------------------------------------
  //
  // A chat SOSE szurke. Boss, 2026-09-21: "Agent-chat NE legyen szurke/letiltva,
  // meg akkor sem, ha nincs munkadarab kivalasztva." Ezert a bevitel MINDIG
  // eleheto: ha nincs szolgaltato beallitva, nem a mezot tiltjuk le, hanem a
  // valaszban mondjuk meg emberi mondattal, hogy mi hianyzik es hol lehet
  // megadni -- ugyanabbol a feluletbol, terminal nelkul.

  /** Melyik beszelgetes: a kivalasztott munkadarabe, vagy a projekte. */
  function chatKey() { return WB.selectedId || ('project:' + WB.projectId) }

  function chatState() {
    if (!WB.chat[chatKey()]) {
      WB.chat[chatKey()] = { turns: [], loaded: false, loading: false, error: null, sessionId: null }
    }
    return WB.chat[chatKey()]
  }

  /** A szolgaltato + keret allapota. Nem talalgat: amit a szerver mond, az megy ki. */
  function loadChatStatus() {
    if (!WB.projectId) return
    WB.chatStatus = null
    WB.chatStatusError = null
    api('GET', '/api/workbench/agent/status?project=' + encodeURIComponent(WB.projectId)).then(function (r) {
      if (!WB.open) return
      if (r.ok) { WB.chatStatus = r.data; WB.chatStatusError = null }
      else { WB.chatStatus = null; WB.chatStatusError = r.message }
      renderChat()
    })
  }

  /** A mar lezajlott beszelgetes visszaolvasasa. URES LISTA NEM UGYANAZ, mint a
   *  "nem latok oda": a hibat kulon mondjuk ki. */
  function loadChatHistory() {
    var st = chatState()
    if (st.loaded || st.loading || !WB.projectId) return
    st.loading = true
    var url = WB.selectedId
      ? '/api/workbench/agent/session?workItem=' + encodeURIComponent(WB.selectedId)
      : '/api/workbench/agent/session?project=' + encodeURIComponent(WB.projectId)
    api('GET', url).then(function (r) {
      st.loading = false
      if (!r.ok) { st.error = r.message; renderChat(); return }
      st.loaded = true
      st.error = null
      st.sessionId = r.data.session ? r.data.session.id : null
      var regi = (r.data.messages || []).filter(function (m) { return m.role !== 'tool' }).map(function (m) {
        // Regi (a #401 elotti) sor, ami csak nyers eszkozhivas-JSON volt: a
        // gepi szoveg helyett emberi eszkoz-sor (#406). Az eredmenyt nem
        // tudjuk, ezert nem is allitunk rola semmit.
        var raw = m.role !== 'user' ? splitRawToolText(m.content) : null
        return {
          role: m.role === 'user' ? 'user' : 'agent',
          text: raw ? '' : (m.content || ''),
          tools: raw ? raw.map(function (n) { return { name: n, status: 'history', detail: '', approvalId: '' } }) : [],
          notices: [], error: null, done: true,
          model: m.model || null,
          via: m.via_kind === 'api_key' ? { kind: 'api_key' }
            : m.via_kind === 'account' && m.via_account ? { kind: 'account', account: m.via_account } : null,
        }
      })
      // ELE fuzzuk, nem felulirjuk. A betoltes kozben a felhasznalo mar
      // irhatott (eppen azert nem szurke a mezo); a kesve beerkezo elozmeny
      // nem torolheti le a kepernyorol a sajat mondatat es a valaszt.
      st.turns = regi.concat(st.turns)
      renderChat()
    })
  }

  function chatStatusHtml() {
    if (WB.chatStatusError) {
      return '<span class="wb-chat-state wb-chat-state-bad">' + esc(WB.chatStatusError) + '</span>'
    }
    if (!WB.chatStatus) {
      return '<span class="wb-chat-state wb-muted">' + esc(t('workbench.chat.status_loading')) + '</span>'
    }
    var s = WB.chatStatus
    var bits = []
    if (s.provider && s.provider.available) {
      bits.push(esc(s.provider.account
        ? t('workbench.chat.provider_on_account', { model: s.provider.model || '-', account: s.provider.account })
        : t('workbench.chat.provider_on', { model: s.provider.model || '-' })))
    } else {
      bits.push('<span class="wb-chat-state-bad">' + esc((s.provider && s.provider.message) || t('workbench.chat.provider_off')) + '</span>')
    }
    if (s.usage) {
      // A MERETLEN keret NEM nulla szazalek.
      bits.push(s.usage.measured
        ? esc(t('workbench.chat.usage', { pct: s.usage.usedPct }))
        : esc(s.usage.message || t('workbench.chat.usage_unknown')))
    }
    if (s.allowed === false && s.blockedReason) {
      bits.push('<span class="wb-chat-state-bad">' + esc(s.blockedReason) + '</span>')
    }
    return '<span class="wb-chat-state">' + bits.join(' · ') + '</span>'
  }

  /** A modell beallitasa UGYANEBBOL a feluletbol -- terminal nelkul. Sajat
   *  API-kulcs mezo nincs (#404): egyetlen ut a bejelentkezett elofizetes. */
  function chatSetupHtml() {
    var cfg = WB.chatConfig || { WORKBENCH_MODEL: '' }
    return '<form class="wb-chat-setup" id="wbChatSetup">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_intro')) + '</p>'
      + '<label class="wb-label" for="wbChatModel">' + esc(t('workbench.chat.setup_model_label')) + '</label>'
      + '<input class="wb-input" id="wbChatModel" type="text" autocomplete="off" value="' + escA(cfg.WORKBENCH_MODEL || '') + '" placeholder="'
      + escA(t('workbench.chat.setup_model_placeholder')) + '">'
      + '<p class="wb-hint">' + esc(t('workbench.chat.setup_model_hint')) + '</p>'
      + '<div class="wb-form-actions">'
      + '<button type="submit" class="btn-primary" data-wb-act="chat-setup-save"' + (WB.chatSetupBusy ? ' disabled' : '') + '>'
      + esc(WB.chatSetupBusy ? t('workbench.chat.setup_saving') : t('workbench.chat.setup_save')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="chat-setup-close">' + esc(t('common.cancel')) + '</button>'
      + '</div></form>'
  }

  /** Az eszkoz EMBERI neve (#406). Ismeretlen (uj) eszkoznel a gepi nev marad
   *  -- inkabb latszodjon valami, mint semmi. */
  function toolLabel(name) {
    var key = 'workbench.tool.' + String(name || '')
    var s = t(key)
    return s && s !== key ? s : String(name || '')
  }

  /** Csak-eszkozhivas elozmeny-sor (a #401 elotti, nyers `{"tool":...}` szoveg)
   *  -> eszkoz-sorok. A nyers JSON soha nem kerul a kepernyore (#406, msg #15). */
  var RAW_TOOL_RX = /^\s*(\{"tool"\s*:[\s\S]*\})\s*$/
  function splitRawToolText(text) {
    var s = String(text || '')
    if (!RAW_TOOL_RX.test(s)) return null
    var names = []
    var rx = /"tool"\s*:\s*"([^"]+)"/g
    var m
    while ((m = rx.exec(s))) { if (names.indexOf(m[1]) < 0) names.push(m[1]) }
    return names.length ? names : null
  }

  /** Mit csinal MOST az agens (#406): Gondolkodik / Dolgozik (melyik eszkoz) /
   *  Valaszol / Jovahagyasra var / Kesz / Hiba / Nem jott valasz / Tetlen.
   *  A forras a stream TENYLEGES esemenyei -- nem becsles. */
  var CHAT_STALL_MS = 45000
  function chatActivity(now) {
    var st = chatState()
    var last = null
    for (var i = st.turns.length - 1; i >= 0; i--) { if (st.turns[i].role === 'agent') { last = st.turns[i]; break } }
    if (WB.chatStreaming && last) {
      var a = WB.chatActivityClock || {}
      var n = typeof now === 'number' ? now : Date.now()
      var sec = a.startedAt ? Math.max(0, Math.round((n - a.startedAt) / 1000)) : 0
      var silent = a.lastEventAt ? n - a.lastEventAt : 0
      var run = null
      var wait = null
      for (var j = last.tools.length - 1; j >= 0; j--) {
        if (!run && last.tools[j].status === 'running') run = last.tools[j]
        if (!wait && last.tools[j].status === 'needs_approval') wait = last.tools[j]
      }
      var label = run ? t('workbench.chat.act_tool', { tool: toolLabel(run.name) })
        : last.text ? t('workbench.chat.act_writing')
        : t('workbench.chat.act_thinking')
      var kind = 'busy'
      if (!run && wait) { label = t('workbench.chat.act_waiting_approval', { tool: toolLabel(wait.name) }); kind = 'wait' }
      var extra = t('workbench.chat.act_elapsed', { s: sec })
      if (silent >= CHAT_STALL_MS) {
        extra = t('workbench.chat.act_stalled', { s: Math.round(silent / 1000) })
        kind = 'stalled'
      }
      return { kind: kind, label: label, extra: extra }
    }
    if (!last) return { kind: 'idle', label: t('workbench.chat.act_idle'), extra: '' }
    if (last.error) return { kind: 'bad', label: t('workbench.chat.act_error'), extra: '' }
    if (last.aborted) return { kind: 'idle', label: t('workbench.chat.act_stopped'), extra: '' }
    if (turnIsEmpty(last)) return { kind: 'bad', label: t('workbench.chat.act_no_answer'), extra: '' }
    return { kind: 'done', label: t('workbench.chat.act_done'), extra: '' }
  }

  function turnIsEmpty(turn) {
    return !turn.text && !(turn.tools && turn.tools.length) && !(turn.notices && turn.notices.length) && !turn.error
  }

  function chatActivityHtml() {
    var a = chatActivity()
    return '<div class="wb-chat-activity wb-chat-activity-' + a.kind + '" id="wbChatActivity" role="status" aria-live="polite">'
      + '<span class="wb-chat-activity-dot" aria-hidden="true"></span>'
      + '<span class="wb-chat-activity-label">' + esc(a.label) + '</span>'
      + (a.extra ? ' <span class="wb-muted wb-chat-activity-extra">' + esc(a.extra) + '</span>' : '')
      + '</div>'
  }

  /** Masodpercenkenti frissites streameles kozben -- CSAK a jelzo sort irja
   *  at, a naplot es a beviteli mezot nem (fokusz, gorgetes marad). */
  function startChatActivityTicker() {
    stopChatActivityTicker()
    if (typeof setInterval !== 'function') return
    WB.chatActivityTimer = setInterval(function () {
      if (!WB.chatStreaming) { stopChatActivityTicker(); return }
      var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatActivity') : null
      if (el && typeof el.outerHTML === 'string') el.outerHTML = chatActivityHtml()
    }, 1000)
  }
  function stopChatActivityTicker() {
    if (WB.chatActivityTimer && typeof clearInterval === 'function') clearInterval(WB.chatActivityTimer)
    WB.chatActivityTimer = null
  }

  function toolLineHtml(tool) {
    var cls = tool.status === 'error' || tool.status === 'blocked' ? ' wb-tool-bad'
      : tool.status === 'needs_approval' ? ' wb-tool-wait' : ''
    return '<div class="wb-tool' + cls + '">'
      + '<span class="wb-tool-name" title="' + escA(tool.name) + '">' + esc(toolLabel(tool.name)) + '</span> '
      + esc(t('workbench.chat.tool_' + tool.status))
      + (tool.detail ? ' <span class="wb-muted">' + esc(tool.detail) + '</span>' : '')
      + (tool.approvalId ? ' <span class="wb-muted">' + esc(t('workbench.chat.approval_id', { id: tool.approvalId })) + '</span>' : '')
      + '</div>'
  }

  /** Melyik fiokkal / modellel ment a valasz (#402). Ha nem tudjuk (regi sor),
   *  nem irunk semmit -- nem talalgatunk. */
  function turnViaHtml(turn) {
    if (turn.role === 'user' || !turn.via) return ''
    var model = turn.model || '-'
    var line = turn.via.kind === 'api_key'
      ? t('workbench.chat.via_api_key', { model: model })
      : t('workbench.chat.via_account', { account: turn.via.account || '-', model: model })
    return '<div class="wb-turn-via">' + esc(line) + '</div>'
  }

  function turnHtml(turn) {
    var who = turn.role === 'user' ? t('workbench.chat.you') : t('workbench.chat.agent')
    var body = ''
    if (turn.text) body += '<div class="wb-turn-text">' + esc(turn.text) + '</div>'
    if (turn.tools && turn.tools.length) body += turn.tools.map(toolLineHtml).join('')
    if (turn.notices && turn.notices.length) {
      body += turn.notices.map(function (n) { return '<div class="wb-turn-notice">' + esc(n) + '</div>' }).join('')
    }
    if (turn.error) body += '<div class="info-box depo-bad">' + esc(turn.error) + '</div>'
    if (turn.aborted) body += '<div class="wb-turn-notice">' + esc(t('workbench.chat.stopped')) + '</div>'
    if (!body && turn.role === 'agent') {
      body = turn.done
        ? '<div class="wb-turn-notice">' + esc(t('workbench.chat.no_answer')) + '</div>'
        : '<div class="wb-turn-text wb-muted">' + esc(t('workbench.chat.thinking')) + '</div>'
    }
    body += turnViaHtml(turn)
    return '<div class="wb-turn wb-turn-' + (turn.role === 'user' ? 'user' : 'agent') + '">'
      + '<div class="wb-turn-who">' + esc(who) + '</div>' + body + '</div>'
  }

  function chatLogHtml() {
    var st = chatState()
    if (st.error) return '<div class="info-box depo-bad">' + esc(st.error) + '</div>'
    if (!st.loaded && st.loading) return '<p class="wb-muted">' + esc(t('workbench.loading')) + '</p>'
    if (!st.turns.length) {
      return '<p class="wb-muted wb-chat-hello">' + esc(WB.selectedId
        ? t('workbench.chat.hello_item')
        : t('workbench.chat.hello_project')) + '</p>'
    }
    return st.turns.map(turnHtml).join('')
  }

  function chatInnerHtml() {
    var streaming = WB.chatStreaming
    var max = (WB.chatStatus && WB.chatStatus.maxMessageChars) || 8000
    return '<div class="wb-chat-head">'
      + '<label class="wb-chat-label" for="wbChatInput">' + esc(t('workbench.chat.title')) + '</label>'
      + chatStatusHtml()
      + '<button type="button" class="btn-secondary wb-chat-setup-btn" data-wb-act="chat-setup">' + esc(t('workbench.chat.setup')) + '</button>'
      + '</div>'
      + (WB.chatSetupOpen ? chatSetupHtml() : '')
      + '<div class="wb-chat-log" id="wbChatLog">' + chatLogHtml() + '</div>'
      + chatActivityHtml()
      + '<div class="wb-chat-row">'
      + '<textarea class="wb-input wb-chat-input" id="wbChatInput" rows="2" maxlength="' + max + '" placeholder="'
      + escA(t('workbench.chat.placeholder')) + '">' + esc(WB.chatDraft) + '</textarea>'
      + (streaming
        ? '<button type="button" class="btn-secondary" data-wb-act="chat-stop">' + esc(t('workbench.chat.stop')) + '</button>'
        : '<button type="button" class="btn-primary" data-wb-act="chat-send">' + esc(t('workbench.chat.send')) + '</button>')
      + '</div>'
      + '<p class="wb-hint">' + esc(WB.selectedId && WB.detail
        ? t('workbench.chat.target_item', { title: WB.detail.item.title })
        : t('workbench.chat.target_project')) + '</p>'
  }

  function chatBarHtml() {
    return '<div class="wb-chat" id="wbChat">' + chatInnerHtml() + '</div>'
  }

  /** CSAK a chat-sav ujrarajzolasa: streameles kozben a teljes oldal ujraepitese
   *  elvenne a fokuszt es a gorgetest. Ha a sav nincs a DOM-ban (meg nem
   *  rajzoltunk), a teljes rajzolas lep a helyebe. */
  function renderChat() {
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChat') : null
    if (!el || typeof el.innerHTML !== 'string') { render(); return }
    var focused = false
    try { focused = !!(document.activeElement && document.activeElement.id === 'wbChatInput') } catch (_e) { focused = false }
    el.innerHTML = chatInnerHtml()
    var log = document.getElementById('wbChatLog')
    if (log && typeof log.scrollHeight === 'number') log.scrollTop = log.scrollHeight
    if (focused) {
      var input = document.getElementById('wbChatInput')
      if (input && typeof input.focus === 'function') {
        input.focus()
        try { input.selectionStart = input.selectionEnd = input.value.length } catch (_e2) { /* nem baj */ }
      }
    }
  }

  /** Egy SSE-keret (`event: x\ndata: {...}`) feldolgozasa. */
  function applyChatEvent(turn, ev) {
    if (!ev || !ev.type) return
    if (WB.chatActivityClock) WB.chatActivityClock.lastEventAt = Date.now()
    if (ev.type === 'session') { chatState().sessionId = ev.sessionId; return }
    if (ev.type === 'text') { turn.text += ev.text || ''; return }
    if (ev.type === 'tool') {
      var found = null
      for (var i = turn.tools.length - 1; i >= 0; i--) {
        if (turn.tools[i].name === ev.name && turn.tools[i].status === 'running') { found = turn.tools[i]; break }
      }
      if (found) { found.status = ev.status; found.detail = ev.detail || found.detail; found.approvalId = ev.approvalId || found.approvalId }
      else turn.tools.push({ name: ev.name, status: ev.status, detail: ev.detail || '', approvalId: ev.approvalId || '' })
      if (ev.status === 'ok' && String(ev.name || '').indexOf('workItem.') === 0) scheduleLiveRefresh()
      return
    }
    if (ev.type === 'notice') { turn.notices.push(ev.message || ev.code); return }
    if (ev.type === 'error') { turn.error = ev.message || ev.code; return }
    if (ev.type === 'done') { turn.done = true; turn.model = ev.model || null; turn.via = ev.via || null }
  }

  function parseSseChunk(turn, chunk) {
    var lines = String(chunk).split('\n')
    var data = ''
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('data:') === 0) data += lines[i].slice(5).trim()
    }
    if (!data) return
    try { applyChatEvent(turn, JSON.parse(data)) } catch (_e) { /* fel-keret: eldobjuk */ }
  }

  function finishChatTurn(turn) {
    stopChatActivityTicker()
    WB.chatStreaming = false
    WB.chatAbort = null
    if (!turn.done) turn.done = true
    renderChat()
    // Ha az agens MUNKADARABOT hozott letre vagy valtoztatott (Boss 2. keres:
    // "az agent-chatbol lehessen uj munkadarabot letrehozni"), a lista ne
    // maradjon a regi allapoton. Ujratoltjuk -- nem talalgatunk, a szerver
    // mondja meg, mi lett belole.
    var valtozott = (turn.tools || []).some(function (x) {
      return x.status === 'ok' && String(x.name || '').indexOf('workItem.') === 0
    })
    if (valtozott && WB.projectId) {
      load(WB.projectId)
      if (WB.selectedId) loadDetail(WB.selectedId)
    }
    // A keret allapota a fordulo utan mar mas: ujramerjuk, nem emlekezetbol irjuk.
    loadChatStatus()
  }

  function sendChat() {
    if (WB.chatStreaming) return
    // A mezo TENYLEGES tartalma a forras -- az `input` esemenyre epiteni
    // onmagaban keves (beillesztes, IME, automatikus kitoltes utan elmaradhat).
    var el = typeof document.getElementById === 'function' ? document.getElementById('wbChatInput') : null
    if (el && typeof el.value === 'string') WB.chatDraft = el.value
    var text = String(WB.chatDraft || '').trim()
    if (!text) return
    var st = chatState()
    st.turns.push({ role: 'user', text: text, tools: [], notices: [], error: null, done: true })
    var turn = { role: 'agent', text: '', tools: [], notices: [], error: null, done: false }
    st.turns.push(turn)
    WB.chatDraft = ''
    WB.chatStreaming = true
    WB.chatActivityClock = { startedAt: Date.now(), lastEventAt: Date.now() }
    startChatActivityTicker()
    renderChat()

    var body = { project_id: WB.projectId, work_item_id: WB.selectedId || null, message: text }
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    }
    if (typeof AbortController === 'function') {
      WB.chatAbort = new AbortController()
      opts.signal = WB.chatAbort.signal
    }
    var url = '/api/workbench/agent/message?lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url, opts).then(function (res) {
      if (!res.ok) {
        // A streameles MEGKEZDESE ELOTTI hiba rendes JSON -- azt a mondatot irjuk ki.
        return (res.json ? res.json() : Promise.resolve(null)).catch(function () { return null }).then(function (d) {
          turn.error = (d && d.message) || t('workbench.err.http', { status: res.status })
          finishChatTurn(turn)
        })
      }
      if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
        var reader = res.body.getReader()
        var dec = new TextDecoder()
        var buf = ''
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) { if (buf.trim()) parseSseChunk(turn, buf); finishChatTurn(turn); return null }
            buf += dec.decode(r.value, { stream: true })
            var parts = buf.split('\n\n')
            buf = parts.pop()
            for (var i = 0; i < parts.length; i++) parseSseChunk(turn, parts[i])
            renderChat()
            return pump()
          })
        }
        return pump()
      }
      // Nincs streamelheto test (regi bongeszo): egyben olvassuk be. A valasz
      // ugyanaz, csak nem gepelve jelenik meg.
      if (typeof res.text === 'function') {
        return res.text().then(function (txt) {
          var parts = String(txt).split('\n\n')
          for (var i = 0; i < parts.length; i++) parseSseChunk(turn, parts[i])
          finishChatTurn(turn)
        })
      }
      turn.error = t('workbench.chat.no_stream')
      finishChatTurn(turn)
      return null
    }).catch(function (e) {
      if (e && e.name === 'AbortError') turn.aborted = true
      else turn.error = t('workbench.err.network')
      finishChatTurn(turn)
    })
  }

  function stopChat() {
    if (WB.chatAbort && typeof WB.chatAbort.abort === 'function') WB.chatAbort.abort()
    else { WB.chatStreaming = false; renderChat() }
  }

  function openChatSetup() {
    WB.chatSetupOpen = true
    renderChat()
    api('GET', '/api/workbench/agent/config').then(function (r) {
      if (r.ok) WB.chatConfig = r.data
      renderChat()
    })
  }

  function saveChatSetup() {
    if (WB.chatSetupBusy) return
    var modelEl = document.getElementById('wbChatModel')
    var body = {}
    if (modelEl) body.WORKBENCH_MODEL = String(modelEl.value || '').trim()
    if (!Object.keys(body).length) { WB.chatSetupOpen = false; renderChat(); return }
    WB.chatSetupBusy = true
    renderChat()
    api('POST', '/api/workbench/agent/config', body).then(function (r) {
      WB.chatSetupBusy = false
      if (!r.ok) { renderChat(); window.showToast(r.message); return }
      WB.chatSetupOpen = false
      window.showToast(t('workbench.chat.setup_saved'))
      loadChatStatus()
      renderChat()
    })
  }

  // ---- kepessegek: mi mukodik ezen a gepen? (8. fazis, spec 1-2) ------------
  //
  // Harom dolgot kell egyszerre tudnia: (a) MI hianyzik, (b) MIRE hat, es (c)
  // MIT tegyen a felhasznalo. Aki nem programozo, annak a "not_installed" szo
  // semmit nem mond -- ezert allapot-cimke + emberi mondat + szamozott lepesek
  // + LINK jar minden sorhoz, es ahol ut vagy cim kell, ott egy mezo is,
  // amibe be tudja irni. Terminal nelkul, friss telepitesen is.
  //
  // Az EXTRA hianya SOHA nem piros (CLAUDE.md, 2026-08-11): a felhasznalo
  // nyugodjon meg attol, amit lat, ne ijedjen meg tole.
  function capStateClass(cap) {
    if (cap.state === 'ok') return 'wb-cap-ok'
    if (cap.state === 'check_failed') return 'wb-cap-warn'
    if (cap.tier === 'core') return 'wb-cap-warn'
    return 'wb-cap-neutral'
  }

  function capSettingHtml(cap) {
    var st = cap.setting
    if (!st) return ''
    var id = 'wbCapSet-' + st.key
    var hint = ''
    if (st.secret) hint = st.configured ? t('workbench.caps.secret_set') : t('workbench.caps.secret_empty')
    return '<div class="wb-cap-setting">'
      + '<label class="wb-label" for="' + escA(id) + '">' + esc(st.label) + '</label>'
      + '<input class="wb-input" id="' + escA(id) + '" type="' + (st.secret ? 'password' : 'text') + '" autocomplete="off"'
      + ' value="' + escA(st.secret ? '' : (st.value || '')) + '" placeholder="' + escA(st.placeholder || '') + '">'
      + (hint ? '<p class="wb-hint">' + esc(hint) + '</p>' : '')
      + '<button type="button" class="btn-secondary" data-wb-act="cap-save" data-wb-cap="' + escA(cap.key) + '"'
      + (WB.capsBusy === cap.key ? ' disabled' : '') + '>'
      + esc(WB.capsBusy === cap.key ? t('workbench.caps.saving') : t('workbench.caps.save')) + '</button>'
      + '</div>'
  }

  function capHtml(cap) {
    var steps = (cap.how_to || []).map(function (line) { return '<li>' + esc(line) + '</li>' }).join('')
    return '<li class="wb-cap ' + capStateClass(cap) + '">'
      + '<div class="wb-cap-head">'
      + '<strong>' + esc(cap.title) + '</strong>'
      + '<span class="wb-cap-badge">' + esc(t('workbench.caps.state.' + cap.state)) + '</span>'
      + '<span class="wb-cap-tier">' + esc(t('workbench.caps.tier.' + cap.tier)) + '</span>'
      + '</div>'
      + '<p class="wb-cap-what">' + esc(cap.what_for) + '</p>'
      + '<p class="wb-cap-msg">' + esc(cap.message) + '</p>'
      // A VALODI hibauzenet: kiirjuk, de nem helyette, hanem az emberi mondat
      // MELLE -- igy a felhasznalo tudja, mi a teendo, a hibakereso meg azt,
      // mi tortent pontosan. CSAK hibas allapotnal: egy mukodo kepesseg
      // reszlete nem hibauzenet (Boss, 2026-09-26: "Mukodik" mellett "A pontos
      // hibauzenet: signed-in Claude account" allt).
      + (cap.detail && cap.state !== 'ok' ? '<p class="wb-cap-detail"><span>' + esc(t('workbench.caps.detail')) + '</span> <code>' + esc(cap.detail) + '</code></p>' : '')
      + (steps ? '<p class="wb-cap-howto">' + esc(t('workbench.caps.howto')) + '</p><ol class="wb-cap-steps">' + steps + '</ol>' : '')
      + (cap.obtain_url ? '<p><a href="' + escA(cap.obtain_url) + '" target="_blank" rel="noopener">' + esc(t('workbench.caps.obtain')) + '</a></p>' : '')
      + capSettingHtml(cap)
      + '<div class="wb-cap-actions">'
      + (cap.testable
        ? '<button type="button" class="btn-secondary" data-wb-act="cap-test" data-wb-cap="' + escA(cap.key) + '"'
          + (WB.capsBusy === cap.key ? ' disabled' : '') + '>'
          + esc(WB.capsBusy === cap.key ? t('workbench.caps.testing') : t('workbench.caps.test')) + '</button>'
        : '')
      + '<span class="wb-cap-when">' + esc(t('workbench.caps.checked_at', { when: when(Math.floor((cap.checked_at || 0) / 1000)) })) + '</span>'
      + '</div>'
      + '</li>'
  }

  function capsPanelHtml() {
    if (!WB.capsOpen) return ''
    var body
    if (WB.capsError) body = '<p class="wb-error">' + esc(WB.capsError) + '</p>'
    // A NULLA KET DOLGOT JELENTHET: a `null` = "meg nem mertuk" (toltes), az
    // ures tomb = "tenyleg nincs egy sor sem". Nem ugyanaz, nem is igy latszik.
    else if (WB.caps === null) body = '<p class="wb-hint">' + esc(t('workbench.caps.loading')) + '</p>'
    else body = '<ul class="wb-caps">' + WB.caps.map(capHtml).join('') + '</ul>'
    return '<section class="wb-caps-panel" id="wbCapsPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.caps.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-refresh">' + esc(t('workbench.caps.refresh')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.caps.intro')) + '</p>'
      + body
      + '</section>'
  }

  function loadCaps(force) {
    WB.capsError = null
    if (force) WB.caps = null
    render()
    api('GET', '/api/workbench/capabilities' + (force ? '?force=1' : '')).then(function (r) {
      if (!r.ok) {
        // Nem allitjuk, hogy "nincs egy kepesseg sem" -- azt mondjuk, hogy
        // NEM LATTUNK ODA. A ketto nem ugyanaz.
        WB.capsError = r.message || t('workbench.caps.error')
        WB.caps = null
      } else {
        WB.caps = (r.data && r.data.capabilities) || []
      }
      render()
    })
  }

  function testCap(key) {
    WB.capsBusy = key
    render()
    api('POST', '/api/workbench/capabilities/' + encodeURIComponent(key) + '/test', {}).then(function (r) {
      WB.capsBusy = null
      if (!r.ok) { WB.capsError = r.message; render(); return }
      applyCap(r.data && r.data.capability)
      render()
    })
  }

  function saveCapSetting(key) {
    var cap = (WB.caps || []).filter(function (c) { return c.key === key })[0]
    if (!cap || !cap.setting) return
    var el = document.getElementById('wbCapSet-' + cap.setting.key)
    var value = el ? el.value : ''
    WB.capsBusy = key
    render()
    api('POST', '/api/workbench/capabilities/' + encodeURIComponent(key) + '/setting', { value: value }).then(function (r) {
      WB.capsBusy = null
      if (!r.ok) { WB.capsError = r.message; render(); return }
      applyCap(r.data && r.data.capability)
      render()
      if (r.data && r.data.message) window.showToast(r.data.message)
    })
  }

  function applyCap(cap) {
    if (!cap || !WB.caps) return
    WB.caps = WB.caps.map(function (c) { return c.key === cap.key ? cap : c })
  }

  function panelTabsHtml() {
    var tabs = [['items', 'workbench.panel.items'], ['editor', 'workbench.panel.editor'], ['context', 'workbench.panel.context']]
    return '<div class="wb-panel-tabs" role="tablist">' + tabs.map(function (p) {
      return '<button type="button" class="tab-btn' + (WB.panel === p[0] ? ' active' : '') + '" role="tab"'
        + ' aria-selected="' + (WB.panel === p[0]) + '" data-wb-panel="' + escA(p[0]) + '">' + esc(t(p[1])) + '</button>'
    }).join('') + '</div>'
  }

  // ---- jovahagyas munkadarabra (#406, 9. pont) ------------------------------
  //
  // Ugyanaz, mint a kartyaknal: "kesz, jovahagyasra var", es a tulajdonos egy
  // gombbal elfogadja vagy visszadobja. A jegy a Jovahagyasok oldalon is ott van.

  function approvalBoxHtml() {
    if (!WB.detail || archived()) return ''
    var it = WB.detail.item
    var a = WB.detail.approval || null
    var busy = WB.approvalBusy ? ' disabled' : ''
    var out = '<div class="wb-approval wb-approval-' + esc(it.status) + '">'
    if (it.status === 'review' && a && a.status === 'pending') {
      out += '<p><strong>' + esc(t('workbench.approval.pending')) + '</strong> '
        + '<span class="wb-muted">' + esc(t('workbench.approval.since', { when: when(a.requested_at) })) + '</span></p>'
        + '<textarea id="wbApprovalReason" class="wb-approval-reason" rows="2" maxlength="1000"'
        + ' placeholder="' + escA(t('workbench.approval.reason_placeholder')) + '"'
        + ' aria-label="' + escA(t('workbench.approval.reason_placeholder')) + '"></textarea>'
        + '<div class="wb-approval-btns">'
        + '<button type="button" class="btn-primary" data-wb-act="approval-approve"' + busy + '>' + esc(t('workbench.approval.approve')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="approval-reject"' + busy + '>' + esc(t('workbench.approval.reject')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="approval-withdraw"' + busy + '>' + esc(t('workbench.approval.withdraw')) + '</button>'
        + '</div>'
    } else if (it.status === 'done') {
      out += '<p>' + esc(t('workbench.approval.done')) + '</p>'
    } else {
      if (it.status === 'review') out += '<p class="wb-muted">' + esc(t('workbench.approval.closed_without_decision')) + '</p>'
      else if (a && a.status === 'rejected') {
        out += '<p class="wb-approval-rejected-note"><strong>' + esc(t('workbench.approval.rejected')) + '</strong>'
          + (a.reason ? ' ' + esc(a.reason) : '') + '</p>'
      }
      out += '<p class="wb-hint">' + esc(t('workbench.approval.intro')) + '</p>'
        + '<button type="button" class="btn-primary" data-wb-act="approval-submit"' + busy + '>' + esc(t('workbench.approval.submit')) + '</button>'
    }
    return out + '</div>'
  }

  function approvalAction(action) {
    if (!WB.detail || WB.approvalBusy) return
    var id = WB.detail.item.id
    var body = { action: action }
    if (action === 'approve' || action === 'reject') {
      var el = document.getElementById('wbApprovalReason')
      var reason = el && typeof el.value === 'string' ? el.value.trim() : ''
      if (reason) body.reason = reason
      if (action === 'reject' && !reason && !window.confirm(t('workbench.approval.reject_no_reason'))) return
    }
    WB.approvalBusy = true
    render()
    api('POST', '/api/workbench/items/' + encodeURIComponent(id) + '/approval', body).then(function (r) {
      WB.approvalBusy = false
      if (!WB.detail || WB.detail.item.id !== id) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      if (r.data && r.data.item) WB.detail.item = r.data.item
      WB.detail.approval = (r.data && r.data.approval) || null
      window.showToast(t('workbench.approval.toast.' + action))
      render()
      load(WB.projectId)
    })
  }

  // ---- kereses a projekt egeszeben (#406, 8. pont) ---------------------------
  //
  // Egy mezo, a talalatok forrasonkent csoportositva. A forras, amibe a szerver
  // NEM tudott belenezni, kulon mondatot kap -- a "nincs talalat" csak akkor
  // hangzik el, ha minden forrast tenyleg megnezett.

  function markHtml(h) {
    var s = String(h.snippet || '')
    var a = Math.max(0, Math.min(s.length, h.mark_start | 0))
    var b = Math.max(a, Math.min(s.length, h.mark_end | 0))
    return esc(s.slice(0, a)) + '<mark>' + esc(s.slice(a, b)) + '</mark>' + esc(s.slice(b))
  }

  function searchHitHtml(h) {
    var label = ''
    if (h.source === 'cards' && h.card_seq != null) label = '#' + h.card_seq + ' ' + (h.title || '')
    else if (h.source === 'files') label = h.path || h.title || ''
    else if (h.source === 'messages') label = t(h.role === 'user' ? 'workbench.search.role.user' : 'workbench.search.role.assistant')
      + (h.item_title ? ' · ' + h.item_title : '')
    else label = h.title || ''
    var head = h.item_id
      ? '<button type="button" class="wb-tl-link" data-wb-item="' + escA(h.item_id) + '">' + esc(label) + '</button>'
      : '<strong>' + esc(label) + '</strong>'
    return '<li class="wb-search-hit">' + head
      + (h.at ? ' <span class="wb-tl-when">' + esc(when(h.at)) + '</span>' : '')
      + '<div class="wb-search-snip">' + markHtml(h) + '</div></li>'
  }

  function searchResultHtml() {
    var r = WB.search
    if (!r) return ''
    var out = ''
    var unseen = (r.sources || []).filter(function (s) { return s.state === 'error' })
    if (unseen.length) {
      out += '<p class="wb-error">' + esc(t('workbench.search.partial', {
        sources: unseen.map(function (s) { return t('workbench.search.source.' + s.source) }).join(', '),
      })) + '</p>'
    }
    var any = false
    ;(r.sources || []).forEach(function (s) {
      if (s.state !== 'ok' || !s.total) return
      any = true
      var hits = (r.hits || []).filter(function (h) { return h.source === s.source })
      out += '<h3 class="wb-search-group">' + esc(t('workbench.search.source.' + s.source)) + ' (' + s.total + ')</h3>'
      if (s.total > hits.length) out += '<p class="wb-hint">' + esc(t('workbench.search.first_n', { n: hits.length, total: s.total })) + '</p>'
      out += '<ul class="wb-search-hits">' + hits.map(searchHitHtml).join('') + '</ul>'
    })
    var files = (r.sources || []).filter(function (s) { return s.source === 'files' })[0]
    if (files && files.state === 'ok' && files.partial) out += '<p class="wb-hint">' + esc(t('workbench.search.files_partial')) + '</p>'
    if (files && files.state === 'none') out += '<p class="wb-hint">' + esc(t('workbench.search.no_folder')) + '</p>'
    if (!any && !unseen.length) out += '<p class="wb-hint">' + esc(t('workbench.search.none', { q: r.q })) + '</p>'
    return out
  }

  function searchPanelHtml() {
    if (!WB.searchOpen) return ''
    var body = ''
    if (WB.searchError) body = '<p class="wb-error">' + esc(WB.searchError) + '</p>'
    else if (WB.searchBusy) body = '<p class="wb-hint">' + esc(t('workbench.search.busy')) + '</p>'
    else body = searchResultHtml()
    return '<section class="wb-caps-panel wb-search-panel" id="wbSearchPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.search.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="search-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.search.intro')) + '</p>'
      + '<form class="wb-search-form" id="wbSearchForm">'
      + '<input type="search" id="wbSearchInput" value="' + escA(WB.searchQ) + '"'
      + ' placeholder="' + escA(t('workbench.search.placeholder')) + '" aria-label="' + escA(t('workbench.search.title')) + '">'
      + '<button type="submit" class="btn-primary"' + (WB.searchBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.search.go')) + '</button>'
      + '</form>'
      + body
      + '</section>'
  }

  function runSearch() {
    var el = document.getElementById('wbSearchInput')
    var q = el && typeof el.value === 'string' ? el.value.trim() : WB.searchQ
    WB.searchQ = q
    if (q.length < 2) { WB.searchError = t('workbench.search.too_short'); WB.search = null; render(); return }
    if (!WB.projectId || WB.searchBusy) return
    var pid = WB.projectId
    WB.searchBusy = true
    WB.searchError = null
    WB.search = null
    render()
    api('GET', '/api/workbench/search?project=' + encodeURIComponent(pid) + '&q=' + encodeURIComponent(q)).then(function (r) {
      WB.searchBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.searchError = r.message || t('workbench.search.error'); render(); return }
      WB.search = (r.data && r.data.search) || null
      render()
    })
  }

  // ---- dontesnaplo (#406, 10. pont) -----------------------------------------
  //
  // Amiben a projektben megallapodtak ("a logo kek marad"). A tulajdonos itt
  // irja be; a Munkapad-agens a beszelgetesbol rogzit, es minden forduloban
  // megkapja. Torles nincs: a visszavont dontes athuzva latszik, visszaallithato.

  // HETI OSSZEFOGLALO (#406, 13. pont). A szerver keszit minden lezart hetrol
  // egyet magatol (es megorzi); a folyo het "eddig" allapota elo. A szoveget itt
  // rakjuk ossze ket nyelven, a szerver csak szamot es nevet ad.

  function loadWeekly() {
    var pid = WB.projectId
    if (!pid) return
    WB.wkError = null
    return api('GET', '/api/workbench/weekly?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.wkError = r.message; WB.weekly = null; render(); return }
      WB.weekly = r.data || { current: null, weeks: [] }
      if (WB.wkShown == null) WB.wkShown = 'current'
      render()
    })
  }

  function wkRange(s) {
    try {
      var a = new Date(s.week_start * 1000)
      var b = new Date((s.week_end - 1) * 1000)
      return a.toLocaleDateString() + ' – ' + b.toLocaleDateString()
    } catch (_e) { return '-' }
  }

  function wkListHtml(key, names, total) {
    if (!names || !names.length) return ''
    var more = total > names.length ? '<li class="wb-hint">' + esc(t('workbench.wk.more', { n: total - names.length })) + '</li>' : ''
    return '<h3 class="wb-search-group">' + esc(t(key, { n: total })) + '</h3>'
      + '<ul class="wb-wk-list">' + names.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + more + '</ul>'
  }

  function wkSummaryHtml(s) {
    if (!s) return ''
    var c = s.counts || {}
    var head = '<p class="wb-wk-range"><strong>' + esc(t(s.live ? 'workbench.wk.this_week' : 'workbench.wk.week_of', { range: wkRange(s) })) + '</strong>'
      + (s.live ? ' <span class="wb-hint">' + esc(t('workbench.wk.so_far')) + '</span>' : '') + '</p>'
    var errs = (s.errors || []).length
      ? '<div class="wb-wk-warn"><p>' + esc(t('workbench.wk.partial')) + '</p></div>' : ''
    if (s.quiet) return head + '<p class="wb-hint">' + esc(t(s.live ? 'workbench.wk.quiet_now' : 'workbench.wk.quiet')) + '</p>'
    var facts = [
      ['items_created', 'workbench.wk.f.created'], ['finished', 'workbench.wk.f.finished'], ['versions', 'workbench.wk.f.versions'],
      ['files', 'workbench.wk.f.files'], ['approvals_requested', 'workbench.wk.f.appr_req'], ['approvals_approved', 'workbench.wk.f.appr_ok'],
      ['approvals_rejected', 'workbench.wk.f.appr_back'], ['decisions', 'workbench.wk.f.decisions'], ['cards_created', 'workbench.wk.f.cards_new'],
      ['cards_done', 'workbench.wk.f.cards_done'],
    ].filter(function (f) { return c[f[0]] > 0 }).map(function (f) {
      return '<li><strong>' + esc(String(c[f[0]])) + '</strong> ' + esc(t(f[1])) + '</li>'
    }).join('')
    var busiest = (s.busiest || []).length
      ? '<h3 class="wb-search-group">' + esc(t('workbench.wk.busiest')) + '</h3><ul class="wb-wk-list">'
        + s.busiest.map(function (b) { return '<li>' + esc(b.title) + ' <span class="wb-hint">' + esc(t('workbench.wk.versions_n', { n: b.versions })) + '</span></li>' }).join('') + '</ul>'
      : ''
    var open = s.open_now != null ? '<p class="wb-hint">' + esc(t('workbench.wk.open_now', { n: s.open_now })) + '</p>' : ''
    return head + errs
      + (facts ? '<ul class="wb-wk-facts">' + facts + '</ul>' : '')
      + wkListHtml('workbench.wk.new_items', s.created, c.items_created || 0)
      + wkListHtml('workbench.wk.done_items', s.finished, c.finished || 0)
      + busiest
      + wkListHtml('workbench.wk.decisions', s.decisions, c.decisions || 0)
      + open
  }

  function weeklyPanelHtml() {
    if (!WB.wkOpen) return ''
    var body = ''
    if (WB.wkError) {
      body = '<p class="wb-error">' + esc(WB.wkError) + '</p>'
        + '<button type="button" class="btn-secondary" data-wb-act="wk-refresh">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (WB.weekly === null) {
      body = '<p class="wb-hint">' + esc(t('workbench.wk.loading')) + '</p>'
    } else {
      var weeks = WB.weekly.weeks || []
      var tabs = '<div class="wb-wk-weeks" role="group" aria-label="' + escA(t('workbench.wk.pick')) + '">'
        + '<button type="button" class="btn-secondary" data-wb-act="wk-show" data-wb-week="current" aria-pressed="' + (WB.wkShown === 'current') + '">'
        + esc(t('workbench.wk.this_week_btn')) + '</button>'
        + weeks.map(function (w) {
          var k = String(w.week_start)
          return '<button type="button" class="btn-secondary" data-wb-act="wk-show" data-wb-week="' + escA(k) + '" aria-pressed="' + (WB.wkShown === k) + '">'
            + esc(wkRange(w)) + '</button>'
        }).join('')
        + '</div>'
      var shown = WB.wkShown === 'current' ? WB.weekly.current
        : weeks.filter(function (w) { return String(w.week_start) === WB.wkShown })[0] || WB.weekly.current
      body = tabs
        + (weeks.length ? '' : '<p class="wb-hint">' + esc(t('workbench.wk.no_history')) + '</p>')
        + wkSummaryHtml(shown)
    }
    return '<section class="wb-caps-panel wb-wk-panel" id="wbWkPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.wk.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="wk-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.wk.intro')) + '</p>'
      + body
      + '</section>'
  }

  function loadDecisions() {
    var pid = WB.projectId
    if (!pid) return
    WB.decError = null
    return api('GET', '/api/workbench/decisions?project=' + encodeURIComponent(pid)).then(function (r) {
      if (WB.projectId !== pid) return
      if (!r.ok) { WB.decError = r.message; WB.decisions = null; render(); return }
      WB.decisions = (r.data && r.data.decisions) || []
      render()
    })
  }

  function decRowHtml(d) {
    var revoked = d.revoked_at != null
    var ro = archived() || WB.decBusy ? ' disabled' : ''
    var who = d.source === 'agent' ? t('workbench.dec.by_agent') : (d.created_by ? t('workbench.dec.by', { name: d.created_by }) : '')
    var item = null
    if (d.work_item_id) item = (WB.items || []).filter(function (i) { return i.id === d.work_item_id })[0] || null
    if (WB.decEdit === d.id) {
      return '<li class="wb-dec-row">'
        + '<form id="wbDecEditForm" class="wb-dec-form">'
        + '<textarea id="wbDecEditText" rows="2" maxlength="500" aria-label="' + escA(t('workbench.dec.edit')) + '">' + esc(d.text) + '</textarea>'
        + '<div class="wb-dec-btns">'
        + '<button type="submit" class="btn-primary"' + ro + '>' + esc(t('workbench.dec.save')) + '</button>'
        + '<button type="button" class="btn-secondary" data-wb-act="dec-cancel">' + esc(t('workbench.dec.cancel')) + '</button>'
        + '</div></form></li>'
    }
    return '<li class="wb-dec-row' + (revoked ? ' wb-dec-revoked' : '') + '">'
      + '<div class="wb-dec-text">' + esc(d.text) + '</div>'
      + '<div class="wb-dec-meta wb-muted">' + esc(when(d.created_at)) + (who ? ' · ' + esc(who) : '')
      + (item ? ' · <button type="button" class="wb-tl-link" data-wb-item="' + escA(item.id) + '">' + esc(item.title) + '</button>' : '')
      + (revoked ? ' · ' + esc(t('workbench.dec.revoked_at', { when: when(d.revoked_at) })) : '')
      + '</div>'
      + (archived() ? '' : '<div class="wb-dec-btns">'
        + (revoked
          ? '<button type="button" class="btn-secondary" data-wb-act="dec-restore" data-wb-dec="' + escA(d.id) + '"' + ro + '>' + esc(t('workbench.dec.restore')) + '</button>'
          : '<button type="button" class="btn-secondary" data-wb-act="dec-edit" data-wb-dec="' + escA(d.id) + '"' + ro + '>' + esc(t('workbench.dec.edit')) + '</button>'
            + '<button type="button" class="btn-secondary" data-wb-act="dec-revoke" data-wb-dec="' + escA(d.id) + '"' + ro + '>' + esc(t('workbench.dec.revoke')) + '</button>')
        + '</div>')
      + '</li>'
  }

  // ---- atadocsomag (#406, 12. pont) -----------------------------------------
  //
  // Egy gomb: a projekt anyaga egy ZIP-ben (Tartalom oldal + munkadarabonkent
  // egy mappa). ELOBB a terv latszik -- mi kerul bele, es mi NEM (hianyzo
  // fajl, nincs Raktar) --, hogy senki ne adjon at hianyos csomagot tudtan kivul.

  function hoSize(bytes) {
    var mb = (bytes || 0) / (1024 * 1024)
    return mb >= 1 ? t('workbench.ho.mb', { n: mb.toFixed(1) }) : t('workbench.ho.kb', { n: Math.max(1, Math.round((bytes || 0) / 1024)) })
  }

  function loadHandoff() {
    var pid = WB.projectId
    var scope = WB.hoScope
    WB.hoPlan = null
    WB.hoError = null
    render()
    return api('GET', '/api/workbench/handoff?project=' + encodeURIComponent(pid) + '&scope=' + encodeURIComponent(scope)).then(function (r) {
      if (WB.projectId !== pid || WB.hoScope !== scope) return
      if (!r.ok) { WB.hoError = r.message; render(); return }
      WB.hoPlan = (r.data && r.data.plan) || null
      if (!WB.hoPlan) WB.hoError = t('workbench.ho.no_plan')
      render()
    })
  }

  function hoProblemsHtml(plan) {
    var rows = []
    plan.items.forEach(function (e) {
      [e.source].concat(e.images || []).forEach(function (f) {
        if (f && f.problem) rows.push('<li>' + esc(e.title + ': ' + f.name) + ' -- ' + esc(t('workbench.ho.problem.' + f.problem)) + '</li>')
      })
    })
    if (!rows.length) return ''
    return '<div class="wb-ho-warn"><p>' + esc(t('workbench.ho.problems', { n: rows.length })) + '</p><ul>' + rows.join('') + '</ul></div>'
  }

  function handoffPanelHtml() {
    if (!WB.hoOpen) return ''
    var p = WB.hoPlan
    var scopeBtn = function (sc, label) {
      var on = WB.hoScope === sc
      return '<button type="button" class="btn-secondary" data-wb-act="ho-scope" data-wb-scope="' + sc + '" aria-pressed="' + on + '">' + esc(label) + '</button>'
    }
    var body
    if (WB.hoError) {
      body = '<div class="info-box depo-bad">' + esc(WB.hoError) + '</div>'
        + '<button type="button" class="btn-secondary" data-wb-act="ho-refresh">' + esc(t('workbench.tpl.retry')) + '</button>'
    } else if (!p) {
      body = '<p class="wb-hint">' + esc(t('workbench.loading')) + '</p>'
    } else if (!p.all_count) {
      body = '<p class="wb-hint">' + esc(t('workbench.ho.no_items')) + '</p>'
    } else if (!p.items.length) {
      body = '<p class="wb-hint">' + esc(t('workbench.ho.nothing_done')) + '</p>'
    } else {
      var href = '/api/workbench/handoff/download?project=' + encodeURIComponent(WB.projectId)
        + '&scope=' + encodeURIComponent(WB.hoScope) + '&lang=' + encodeURIComponent(window._lang || 'hu')
      body = '<p>' + esc(t('workbench.ho.summary', { items: p.items.length, files: p.files, size: hoSize(p.total_bytes) })) + '</p>'
        + '<ul class="wb-ho-list">' + p.items.map(function (e) {
          return '<li>' + esc(e.title) + ' <span class="wb-muted">(' + esc(typeLabel(e.type)) + ' · ' + esc(statusLabel(e.status)) + ')</span></li>'
        }).join('') + '</ul>'
        + hoProblemsHtml(p)
        + (p.too_large
          ? '<div class="info-box depo-bad">' + esc(t('workbench.ho.too_large')) + '</div>'
          : '<a class="btn-primary wb-ho-download" href="' + escA(href) + '" download>' + esc(t('workbench.ho.download')) + '</a>')
    }
    return '<section class="wb-caps-panel wb-ho-panel" id="wbHoPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.ho.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="ho-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.ho.intro')) + '</p>'
      + '<div class="wb-ho-scope" role="group" aria-label="' + escA(t('workbench.ho.scope_label')) + '">'
      + scopeBtn('done', p ? t('workbench.ho.scope_done_n', { n: p.done_count }) : t('workbench.ho.scope_done'))
      + scopeBtn('all', p ? t('workbench.ho.scope_all_n', { n: p.all_count }) : t('workbench.ho.scope_all'))
      + '</div>'
      + body
      + '</section>'
  }

  function decisionsPanelHtml() {
    if (!WB.decOpen) return ''
    var body = ''
    if (WB.decError) body = '<p class="wb-error">' + esc(WB.decError) + '</p>'
    else if (WB.decisions === null) body = '<p class="wb-hint">' + esc(t('workbench.dec.loading')) + '</p>'
    else if (!WB.decisions.length) body = '<p class="wb-hint">' + esc(t('workbench.dec.empty')) + '</p>'
    else {
      var active = WB.decisions.filter(function (d) { return d.revoked_at == null })
      var old = WB.decisions.filter(function (d) { return d.revoked_at != null })
      body = (active.length
        ? '<ul class="wb-dec-list">' + active.map(decRowHtml).join('') + '</ul>'
        : '<p class="wb-hint">' + esc(t('workbench.dec.none_active')) + '</p>')
        + (old.length ? '<h3 class="wb-search-group">' + esc(t('workbench.dec.revoked_head', { n: old.length })) + '</h3>'
          + '<ul class="wb-dec-list">' + old.map(decRowHtml).join('') + '</ul>' : '')
    }
    var form = archived() ? '' : '<form id="wbDecForm" class="wb-dec-form">'
      + '<textarea id="wbDecText" rows="2" maxlength="500"'
      + ' placeholder="' + escA(t('workbench.dec.placeholder')) + '" aria-label="' + escA(t('workbench.dec.add')) + '"></textarea>'
      + '<div class="wb-dec-btns"><button type="submit" class="btn-primary"' + (WB.decBusy ? ' disabled' : '') + '>'
      + esc(t('workbench.dec.add')) + '</button></div>'
      + '</form>'
    return '<section class="wb-caps-panel wb-dec-panel" id="wbDecPanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.dec.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="dec-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.dec.intro')) + '</p>'
      + form
      + body
      + '</section>'
  }

  /** Egy dontes-muvelet: a valasz sora a listaban kicserelodik. */
  function decRequest(method, url, body, toastKey) {
    if (WB.decBusy) return
    var pid = WB.projectId
    WB.decBusy = true
    render()
    api(method, url, body).then(function (r) {
      WB.decBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) { window.showToast(r.message); render(); return }
      var d = r.data && r.data.decision
      if (d) {
        var list = (WB.decisions || []).filter(function (x) { return x.id !== d.id })
        list.unshift(d)
        list.sort(function (a, b) { return b.created_at - a.created_at })
        WB.decisions = list
      }
      if (toastKey === 'add') { var el = document.getElementById('wbDecText'); if (el) el.value = '' }
      WB.decEdit = null
      window.showToast(t('workbench.dec.toast.' + toastKey))
      render()
    })
  }

  function addDecisionFromForm() {
    var el = document.getElementById('wbDecText')
    var text = el && typeof el.value === 'string' ? el.value.trim() : ''
    if (!text) { window.showToast(t('workbench.dec.empty_text')); return }
    decRequest('POST', '/api/workbench/decisions', { project: WB.projectId, text: text }, 'add')
  }

  function saveDecisionEdit() {
    var el = document.getElementById('wbDecEditText')
    var text = el && typeof el.value === 'string' ? el.value.trim() : ''
    if (!WB.decEdit) return
    if (!text) { window.showToast(t('workbench.dec.empty_text')); return }
    decRequest('PATCH', '/api/workbench/decisions/' + encodeURIComponent(WB.decEdit), { text: text }, 'edit')
  }

  // ---- projekt-idovonal (#406, 7. pont) --------------------------------------
  //
  // A projekt minden esemenye egy gorgetheto savban, a legfrissebb felul. A
  // szerver csak adatot ad (`kind` + cim/verzio/fajlnev); a mondatot itt rakjuk
  // ossze, ket nyelven. Munkadarabhoz tartozo sor kattinthato: megnyitja azt.

  function tlText(ev) {
    return t('workbench.tl.kind.' + ev.kind, {
      item: ev.item_title || t('workbench.tl.unknown_item'),
      n: ev.version_no != null ? ev.version_no : '',
      from: ev.from_version_no != null ? ev.from_version_no : '',
      file: ev.file_name || '',
      card: ev.card_seq != null ? '#' + ev.card_seq : '',
      title: ev.card_title || '',
      what: ev.approval_description || '',
    })
  }

  function tlRowHtml(ev) {
    var text = esc(tlText(ev))
    var body = ev.item_id
      ? '<button type="button" class="wb-tl-link" data-wb-item="' + escA(ev.item_id) + '">' + text + '</button>'
      : '<span>' + text + '</span>'
    return '<li class="wb-tl-row wb-tl-' + escA(ev.kind) + '">'
      + '<span class="wb-tl-when">' + esc(when(ev.at)) + '</span>'
      + '<span class="wb-tl-dot" aria-hidden="true"></span>'
      + body
      + '</li>'
  }

  function timelinePanelHtml() {
    if (!WB.tlOpen) return ''
    var body = ''
    if (WB.tlError) body += '<p class="wb-error">' + esc(WB.tlError) + '</p>'
    // Ha egy forras nem olvashato, KIMONDJUK: abbol most semmi nem latszik.
    // Ez nem ugyanaz, mint hogy nem tortent semmi.
    if (WB.tlSources && WB.tlSources.length) {
      body += '<p class="wb-error">' + esc(t('workbench.tl.partial', {
        sources: WB.tlSources.map(function (s) { return t('workbench.tl.source.' + s.source) }).join(', '),
      })) + '</p>'
    }
    if (WB.tl === null) {
      if (!WB.tlError) body += '<p class="wb-hint">' + esc(t('workbench.tl.loading')) + '</p>'
    } else if (!WB.tl.length) {
      body += '<p class="wb-hint">' + esc(t('workbench.tl.empty')) + '</p>'
    } else {
      body += '<ol class="wb-tl">' + WB.tl.map(tlRowHtml).join('') + '</ol>'
      if (WB.tlMore) {
        body += '<button type="button" class="btn-secondary wb-tl-more" data-wb-act="tl-more"' + (WB.tlBusy ? ' disabled' : '') + '>'
          + esc(t(WB.tlBusy ? 'workbench.tl.loading' : 'workbench.tl.more')) + '</button>'
      }
    }
    return '<section class="wb-caps-panel wb-tl-panel" id="wbTimelinePanel">'
      + '<div class="wb-caps-head">'
      + '<h2>' + esc(t('workbench.tl.title')) + '</h2>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-refresh">' + esc(t('common.refresh')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-close">' + esc(t('workbench.caps.close')) + '</button>'
      + '</div>'
      + '<p class="wb-hint">' + esc(t('workbench.tl.intro')) + '</p>'
      + body
      + '</section>'
  }

  /** `more` = a meglevo lista ala a regebbiek; kulonben elolrol. */
  function loadTimeline(more) {
    if (!WB.projectId || WB.tlBusy) return
    var pid = WB.projectId
    var url = '/api/workbench/timeline?project=' + encodeURIComponent(pid)
    if (more && WB.tlNext) url += '&before=' + encodeURIComponent(WB.tlNext)
    WB.tlBusy = true
    WB.tlError = null
    if (!more) { WB.tl = null; WB.tlSources = [] }
    render()
    api('GET', url).then(function (r) {
      WB.tlBusy = false
      if (WB.projectId !== pid) return
      if (!r.ok) {
        // "Nem lattunk oda", nem "nincs esemeny".
        WB.tlError = r.message || t('workbench.tl.error')
        if (!more) WB.tl = null
        render()
        return
      }
      var tl = (r.data && r.data.timeline) || { events: [], more: false, next_before: null, errors: [] }
      WB.tl = (more && WB.tl ? WB.tl : []).concat(tl.events || [])
      WB.tlMore = !!tl.more
      WB.tlNext = tl.next_before || null
      WB.tlSources = tl.errors || []
      render()
    })
  }

  /** A ket elrendezes. Mindkettoben UGYANAZOK a panelek allnak (semmi nem
   *  vesz el valtaskor), csak mas a helyuk. Osztott nezetben a chat bal
   *  oldalt, az elo munkadarab jobb oldalt all; a lista es a reszletek alattuk.
   *  Telefonon (keskeny kepernyo) a ket oszlop egymas ala kerul: felul a
   *  munkadarab, alatta a chat -- a CSS dolga, nem kulon kod. */
  function layoutHtml() {
    if (WB.layout !== 'split') {
      return '<div class="wb-grid">' + itemsPanelHtml() + editorPanelHtml() + contextPanelHtml() + '</div>'
        + chatBarHtml()
    }
    return '<div class="wb-split">'
      + '<div class="wb-split-chat">' + chatBarHtml() + '</div>'
      + '<div class="wb-split-work">' + editorPanelHtml() + '</div>'
      + '</div>'
      + '<div class="wb-grid wb-grid-aside">' + itemsPanelHtml() + contextPanelHtml() + '</div>'
  }

  /** ELO elonezet: amikor az agens egy munkadarab-eszkozt SIKERESEN lefuttat,
   *  a jobb oldal meg a valasz vege elott frissul. Rovid kesleltetessel, hogy
   *  egy sor egymas utani lepes ne kerjen le tucatnyi elonezetet. */
  function scheduleLiveRefresh() {
    if (!WB.selectedId) return
    if (WB.liveTimer) clearTimeout(WB.liveTimer)
    var itemId = WB.selectedId
    WB.liveTimer = setTimeout(function () {
      WB.liveTimer = null
      if (!WB.open || WB.selectedId !== itemId) return
      api('GET', '/api/workbench/items/' + encodeURIComponent(itemId)).then(function (r) {
        if (!r.ok || WB.selectedId !== itemId || !WB.detail) return
        WB.detail = r.data
        loadPreview(itemId, WB.previewVersion, true)
        // az agens teendot is felvehetett (workItem.addTodo)
        loadTodos()
      })
    }, 400)
  }

  function render() {
    var el = root()
    if (!el || !WB.open) return
    // A tablazat egy cellajaban all a kurzor: az ujrarajzolas utan ugyanoda
    // tesszuk vissza (a chat streamelese kozben is lehessen gepelni).
    var active = document.activeElement
    var keepCell = active && /^wb(Cell_|Img)/.test(String(active.id || '')) ? active.id : null
    var caret = keepCell && typeof active.selectionStart === 'number' ? active.selectionStart : null
    el.innerHTML = '<div class="wb-root">'
      + '<div class="wb-head">'
      + '<button type="button" class="prj-back-link" data-wb-act="back">' + esc(t('workbench.back_to_project')) + '</button>'
      + '<h1>' + esc(t('workbench.title', { project: WB.project ? WB.project.name : '' })) + '</h1>'
      + '<button type="button" class="btn-secondary" data-wb-act="layout-toggle" aria-pressed="' + (WB.layout === 'split') + '"'
      + ' title="' + escA(t('workbench.layout.hint')) + '">'
      + esc(t(WB.layout === 'split' ? 'workbench.layout.to_classic' : 'workbench.layout.to_split')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="search-open" aria-pressed="' + !!WB.searchOpen + '">' + esc(t('workbench.search.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="wk-open" aria-pressed="' + !!WB.wkOpen + '">' + esc(t('workbench.wk.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="tl-open" aria-pressed="' + !!WB.tlOpen + '">' + esc(t('workbench.tl.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="dec-open" aria-pressed="' + !!WB.decOpen + '">' + esc(t('workbench.dec.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="td-open" aria-pressed="' + !!WB.tdOpen + '">' + esc(t('workbench.td.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="ho-open" aria-pressed="' + !!WB.hoOpen + '">' + esc(t('workbench.ho.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="caps-open">' + esc(t('workbench.caps.open')) + '</button>'
      + '<button type="button" class="btn-secondary" data-wb-act="refresh">' + esc(t('common.refresh')) + '</button>'
      + '</div>'
      + capsPanelHtml()
      + searchPanelHtml()
      + timelinePanelHtml()
      + weeklyPanelHtml()
      + decisionsPanelHtml()
      + todosPanelHtml()
      + handoffPanelHtml()
      + overviewHtml()
      + panelTabsHtml()
      + layoutHtml()
      + '</div>'
    if (WB.formOpen) {
      var input = document.getElementById('wbNewTitle')
      if (input) input.focus()
    }
    // A PDF-nezegeto csomopontja tulelte az ujrarajzolast: visszatesszuk a
    // helyere (vagy uj dokumentumnal elinditjuk a betoltest).
    pdfMount()
    if (keepCell) {
      var cell = document.getElementById(keepCell)
      if (cell && typeof cell.focus === 'function') {
        cell.focus()
        if (caret != null && typeof cell.setSelectionRange === 'function') { try { cell.setSelectionRange(caret, caret) } catch (_e) { /* nem baj */ } }
      }
    }
  }

  // ---- muveletek ------------------------------------------------------------

  function create() {
    var titleEl = document.getElementById('wbNewTitle')
    var typeEl = document.getElementById('wbNewType')
    if (!titleEl || !typeEl || WB.busy) return
    var title = titleEl.value.trim()
    var type = typeEl.value
    WB.busy = true
    render()
    api('POST', '/api/workbench/items', { project_id: WB.projectId, title: title, type: type }).then(function (r) {
      WB.busy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.formOpen = false
      WB.selectedId = r.data.item.id
      WB.detail = { item: r.data.item, versions: r.data.versions, project: WB.project }
      window.showToast(t('workbench.new.created', { title: r.data.item.title }))
      load(WB.projectId)
    })
  }

  // ---- reszek: muveletek ----------------------------------------------------

  /** A valasz minden resz-muveletnel a TELJES, friss reszlistat hozza -- igy a
   *  felulet nem a sajat feltetelezeseibol epiti ujra a sorrendet. */
  function applyParts(data) {
    if (!WB.detail || !data) return
    if (data.parts) WB.detail.parts = data.parts
    // Uj verzio keletkezett: a lista es a munkadarab is a friss, es az
    // elonezet a legujabbat mutatja (nem egy korabban kivalasztott regit).
    if (data.versions) WB.detail.versions = data.versions
    if (data.item) WB.detail.item = data.item
    if (data.version) WB.previewVersion = null
    WB.partBusy = false
    render()
    // A reszek a munkadarab TARTALMA: valtozasuk utan az elonezet sem a regi.
    if (WB.selectedId) loadPreview(WB.selectedId, WB.previewVersion)
  }

  // --- VERZIOZAS (5. fazis) ------------------------------------------------
  // "Az eredeti automatikusan nem irhato felul": a mentes UJ verziot ir, a
  // visszaallitas pedig a regi allapotbol csinal UJ verziot -- torles nincs.
  function versionsUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/versions' + (tail || '')
  }

  function applyVersions(data) {
    if (!WB.detail || !data) return
    // Uj verzio lett: a regi osszehasonlitas mar nem a mostanirol szol.
    WB.compare = null
    if (data.versions) WB.detail.versions = data.versions
    if (data.item) WB.detail.item = data.item
    if (data.parts) WB.detail.parts = data.parts
    WB.versionBusy = false
    // A mutatott verzio a friss lett: a valaszto ne egy regire alljon.
    WB.previewVersion = null
    render()
    if (WB.selectedId) loadPreview(WB.selectedId, null)
    load(WB.projectId)
  }

  function newVersion() {
    if (!WB.selectedId || WB.versionBusy || archived()) return
    WB.versionBusy = true
    render()
    api('POST', versionsUrl(), {}).then(function (r) {
      WB.versionBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      applyVersions(r.data)
      window.showToast(t('workbench.versions.saved', { n: r.data && r.data.version ? r.data.version.version_no : '' }))
    })
  }

  function restoreVersion(versionId) {
    if (!versionId || !WB.selectedId || WB.versionBusy || archived()) return
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.versions.restore_confirm'))) return
    WB.versionBusy = true
    render()
    api('POST', versionsUrl('/' + encodeURIComponent(versionId) + '/restore'), {}).then(function (r) {
      WB.versionBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      applyVersions(r.data)
      window.showToast(t('workbench.versions.restored', { n: r.data && r.data.version ? r.data.version.version_no : '' }))
    })
  }

  /** MINDEN MENTES UJ VERZIO (#406, 4. pont): a `new_version=1` miatt a
   *  szerver elobb uj verziot nyit, es a valtoztatas abba kerul -- a regi
   *  allapot megmarad, es egy kattintassal visszaallithato. */
  function partsUrl(tail) {
    return '/api/workbench/items/' + encodeURIComponent(WB.selectedId) + '/parts' + (tail || '') + '?new_version=1'
  }

  function addTextPart() {
    var el = document.getElementById('wbPartNewText')
    var text = el && typeof el.value === 'string' ? el.value : ''
    if (!text.trim() || WB.partBusy) return
    WB.partBusy = true
    render()
    api('POST', partsUrl(), { kind: 'text', text: text }).then(function (r) {
      WB.partBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.partNewOpen = false
      applyParts(r.data)
      window.showToast(t('workbench.parts.added'))
    })
  }

  function savePart(partId) {
    var el = document.getElementById('wbPartText')
    var value = el && typeof el.value === 'string' ? el.value : ''
    var part = partsOf().filter(function (p) { return p.id === partId })[0]
    if (!part || WB.partBusy) return
    WB.partBusy = true
    render()
    var body = part.kind === 'image' ? { caption: value } : { text: value }
    api('PATCH', partsUrl('/' + encodeURIComponent(partId)), body).then(function (r) {
      WB.partBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      WB.partEdit = null
      applyParts(r.data)
      window.showToast(t('workbench.parts.saved'))
    })
  }

  function movePart(partId, dir) {
    if (WB.partBusy) return
    api('POST', partsUrl('/' + encodeURIComponent(partId) + '/move'), { dir: dir }).then(function (r) {
      if (!r.ok) { window.showToast(r.message); return }
      applyParts(r.data)
    })
  }

  /** Kivetel a munkadarabbol. A KEP FAJLJA marad -- ezt a kerdes is kimondja,
   *  mert a "torles" szo mast igerne, mint ami tortenik. */
  function removePart(partId) {
    if (WB.partBusy) return
    if (typeof window.confirm === 'function' && !window.confirm(t('workbench.parts.remove_confirm'))) return
    WB.partBusy = true
    render()
    api('DELETE', partsUrl('/' + encodeURIComponent(partId))).then(function (r) {
      WB.partBusy = false
      if (!r.ok) { render(); window.showToast(r.message); return }
      if (WB.partEdit === partId) WB.partEdit = null
      applyParts(r.data)
      window.showToast(t('workbench.parts.removed'))
    })
  }

  /** Kep feltoltese: a nyers bajtok mennek, a nev a query-ben -- igy az
   *  ekezetes fajlnev sem torik el (ugyanaz a mod, mint a projekt-feltoltesnel). */
  function uploadImagePart(file) {
    if (!file || !WB.selectedId || WB.partBusy) return
    WB.partBusy = true
    render()
    var url = partsUrl('/image')
      + '&name=' + encodeURIComponent(file.name || 'kep.jpg')
      + '&type=' + encodeURIComponent(file.type || '')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        WB.partBusy = false
        if (!res.ok) {
          render()
          // A szerver EMBERI mondatot kuld (a gepi kod csak tartalek).
          window.showToast((data && data.message) || t('workbench.err.http', { status: res.status }))
          return
        }
        applyParts(data)
        window.showToast(t('workbench.parts.added'))
      })
    }).catch(function () {
      WB.partBusy = false
      render()
      window.showToast(t('workbench.err.network'))
    })
  }

  // DOKUMENTUM VISSZATOLTESE UJ VERZIOKENT (7. fazis, spec 8). Semmi nem
  // irodik felul: a fajl foglalt nevnel uj nevet kap (es azt KI IS mondjuk), a
  // munkadarab pedig uj verziot -- a regi verzio erintetlen marad.
  function uploadDocumentVersion(file) {
    if (!file || !WB.selectedId || WB.docBusy) return
    var itemId = WB.selectedId
    WB.docBusy = true
    render()
    var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/document'
      + '?name=' + encodeURIComponent(file.name || 'dokumentum.docx')
      + '&lang=' + encodeURIComponent(window._lang || 'hu')
    fetch(url, { method: 'POST', body: file }).then(function (res) {
      return res.json().catch(function () { return null }).then(function (data) {
        WB.docBusy = false
        if (!res.ok) {
          render()
          window.showToast((data && data.message) || t('workbench.err.http', { status: res.status }))
          return
        }
        if (WB.detail && data && data.item) { WB.detail.item = data.item; WB.detail.versions = data.versions || WB.detail.versions }
        loadPreview(itemId, null)
        WB.previewVersion = null
        render()
        // Ha a nev foglalt volt, a fajl MAS neven all -- ezt nem hallgatjuk el.
        window.showToast(data && data.renamed
          ? t('workbench.versions.uploaded_renamed', { name: (data.file && data.file.name) || data.name })
          : t('workbench.versions.uploaded'))
      })
    }).catch(function () {
      WB.docBusy = false
      render()
      window.showToast(t('workbench.err.network'))
    })
  }

  // PDF-ELONEZET KESZITESE irodai dokumentumbol (7. fazis). A fajlhoz nem
  // nyulunk hozza: a PDF szarmaztatott, es barmikor ujra eloallithato.
  //
  // Ha nincs a gepen LibreOffice, a szerver EMBERI mondatot kuld arrol, mi
  // hianyzik es hogyan szerezheto be -- azt mutatjuk, nem gepi kodot. A
  // "megegyszer" ujra MEGMERI az allapotot (force), tehat telepites utan
  // azonnal jo valaszt ad: nem a korabbi meresbol beszel.
  function convertPreview(force) {
    if (!WB.selectedId || WB.convertBusy) return
    var itemId = WB.selectedId
    WB.convertBusy = true
    WB.convertError = null
    render()
    var go = function () {
      var url = '/api/workbench/items/' + encodeURIComponent(itemId) + '/convert'
        + (WB.previewVersion ? '?version=' + encodeURIComponent(WB.previewVersion) : '')
      return api('POST', url).then(function (r) {
        if (WB.selectedId !== itemId) return
        WB.convertBusy = false
        if (!r.ok) {
          WB.convertError = { message: r.message, detail: (r.data && r.data.detail) || null }
          render()
          return
        }
        WB.convertError = null
        loadPreview(itemId, WB.previewVersion)
        window.showToast(t('workbench.preview.converted'))
      })
    }
    // Ujraprobalasnal elobb ujra megmerjuk, van-e mar LibreOffice.
    if (force) {
      fetch('/api/workbench/capabilities?force=1&lang=' + encodeURIComponent(window._lang || 'hu'))
        .then(function () { return go() })
        .catch(function () { return go() })
      return
    }
    go()
  }

  function openWorkbench(projectId, projectName) {
    if (!projectId) return
    WB.open = true
    WB.projectId = projectId
    WB.project = projectName ? { id: projectId, name: projectName } : null
    WB.items = null
    WB.detail = null
    WB.selectedId = null
    WB.formOpen = false
    WB.error = null
    WB.panel = 'items'
    WB.chat = {}
    WB.chatStatus = null
    WB.chatStatusError = null
    WB.chatStreaming = false
    WB.chatAbort = null
    WB.chatDraft = ''
    WB.chatSetupOpen = false
    WB.chatSetupBusy = false
    WB.chatConfig = null
    WB.partEdit = null
    WB.partNewOpen = false
    WB.partBusy = false
    WB.overview = null
    WB.overviewError = null
    WB.upload = null
    WB.tlOpen = false
    WB.tl = null
    WB.tlError = null
    WB.tlSources = []
    WB.tlMore = false
    WB.tlNext = null
    WB.tlBusy = false
    WB.searchOpen = false
    WB.searchQ = ''
    WB.search = null
    WB.searchError = null
    WB.searchBusy = false
    WB.wkOpen = false
    WB.weekly = null
    WB.wkError = null
    WB.wkShown = null
    WB.todos = null
    WB.tdError = null
    WB.tdBusy = false
    WB.tdOpen = false
    WB.decOpen = false
    WB.decisions = null
    WB.decError = null
    WB.decBusy = false
    WB.decEdit = null
    render()
    load(projectId)
    loadChatStatus()
    loadChatHistory()
  }

  function closeWorkbench() {
    var pid = WB.projectId
    WB.open = false
    WB.projectId = null
    WB.items = null
    WB.detail = null
    if (pid && typeof window._prjOpenProject === 'function') window._prjOpenProject(pid)
  }

  // ---- esemenyek (egy delegalt figyelo) -------------------------------------

  document.addEventListener('click', function (e) {
    var openBtn = e.target.closest('[data-wb-open]')
    if (openBtn) {
      openWorkbench(openBtn.getAttribute('data-wb-open'), openBtn.getAttribute('data-wb-open-name'))
      return
    }
    if (!WB.open) return
    var panelBtn = e.target.closest('[data-wb-panel]')
    if (panelBtn) { WB.panel = panelBtn.getAttribute('data-wb-panel'); render(); return }
    var itemBtn = e.target.closest('[data-wb-item]')
    if (itemBtn) {
      selectItem(itemBtn.getAttribute('data-wb-item'))
      return
    }
    var act = e.target.closest('[data-wb-act]')
    if (!act) return
    var a = act.getAttribute('data-wb-act')
    if (a === 'back') closeWorkbench()
    else if (a === 'item-pin') togglePin(act.getAttribute('data-wb-pin'))
    else if (a === 'goto-approvals') { if (typeof window.switchPage === 'function') window.switchPage('approvals') }
    else if (a === 'export-open') { WB.exportOpen = WB.selectedId; render() }
    else if (a === 'export-close') { WB.exportOpen = null; render() }
    else if (a === 'export-print') openPrint()
    else if (a === 'export-png') exportPng()
    else if (a === 'send-request') { e.preventDefault(); sendRequest() }
    else if (a === 'send-refresh') refreshSendStatus()
    else if (a === 'send-new') { WB.send = null; render() }
    else if (a === 'version-undo') undoVersion()
    else if (a === 'compare-open') openCompare()
    else if (a === 'compare-close') { WB.compare = null; render() }
    else if (a === 'text-edit') openTextEdit()
    else if (a === 'img-open') openImageEditor()
    else if (a === 'img-close') imgClose()
    else if (a === 'img-save') imgSave()
    else if (a === 'img-reset' && imgState()) {
      var ist = imgState()
      ist.rot = 0; ist.flip = false; ist.aspect = 'free'
      ist.caption = { text: '', pos: 'bottom', size: 6, color: 'white', band: true }
      ist.bg = { pick: false, seeds: [], tol: 32 }
      ist.dirty = false
      imgResetGeometry(ist); render(); imgRefresh(true)
    }
    else if (a === 'img-aspect') imgSetAspect(act.getAttribute('data-wb-aspect'))
    else if (a === 'img-rot-left') imgRotate(-90)
    else if (a === 'img-rot-right') imgRotate(90)
    else if (a === 'img-flip' && imgState()) { imgState().flip = !imgState().flip; imgState().bg.seeds = []; imgState().dirty = true; render(); imgRefresh(true) }
    else if (a === 'img-size-orig' && imgState()) { imgState().outW = imgState().crop.w; render(); imgRefresh(false) }
    else if (a === 'img-size-half' && imgState()) { imgState().outW = Math.max(1, Math.round(imgState().crop.w / 2)); imgState().dirty = true; render(); imgRefresh(false) }
    else if (a === 'img-bg-pick' && imgState()) { imgState().bg.pick = !imgState().bg.pick; render() }
    else if (a === 'img-bg-clear' && imgState()) { imgState().bg.seeds = []; render(); imgRefresh(false) }
    else if (a === 'table-open') openTable(WB.selectedId, WB.previewVersion)
    else if (a === 'table-close') closeTable()
    else if (a === 'table-save') saveTable()
    else if (a === 'table-sheet' && WB.table) { WB.table.sheet = Number(act.getAttribute('data-wb-sheet')) || 0; WB.table.page = 0; WB.table.sel = { r: 0, c: 0 }; render() }
    else if (a === 'table-page-prev' && WB.table) { WB.table.page = Math.max(0, WB.table.page - 1); render() }
    else if (a === 'table-page-next' && WB.table) { WB.table.page = WB.table.page + 1; render() }
    else if (a === 'table-row-add') tableStructure('row-add')
    else if (a === 'table-row-del') tableStructure('row-del')
    else if (a === 'table-col-add') tableStructure('col-add')
    else if (a === 'table-col-del') tableStructure('col-del')
    else if (a === 'create-table') { e.preventDefault(); createTable() }
    else if (a === 'text-save') { e.preventDefault(); saveTextEdit() }
    else if (a === 'text-cancel') { WB.textEdit = null; render() }
    else if (a === 'layout-toggle') { WB.layout = WB.layout === 'split' ? 'classic' : 'split'; saveLayout(WB.layout); render() }
    else if (a === 'refresh') load(WB.projectId)
    else if (a === 'new') { if (!archived()) { WB.formOpen = true; render() } }
    else if (a === 'cancel-new') { WB.formOpen = false; render() }
    else if (a === 'create') { e.preventDefault(); create() }
    else if (a === 'tpl-use') useTemplate(act.getAttribute('data-wb-tpl'))
    else if (a === 'tpl-retry') { WB.templatesError = null; WB.templates = null; render(); loadTemplates() }
    else if (a === 'part-new-text') { if (!archived()) { WB.partNewOpen = true; WB.partEdit = null; render() } }
    else if (a === 'part-cancel') { WB.partNewOpen = false; WB.partEdit = null; render() }
    else if (a === 'part-add-text') { e.preventDefault(); addTextPart() }
    else if (a === 'part-edit') { WB.partEdit = act.getAttribute('data-wb-part'); WB.partDraft = null; WB.partNewOpen = false; render() }
    else if (a === 'part-save') { e.preventDefault(); savePart(act.getAttribute('data-wb-part')) }
    else if (a === 'part-up') movePart(act.getAttribute('data-wb-part'), 'up')
    else if (a === 'part-down') movePart(act.getAttribute('data-wb-part'), 'down')
    else if (a === 'part-remove') removePart(act.getAttribute('data-wb-part'))
    else if (a === 'caps-open') { WB.capsOpen = true; if (WB.caps === null) loadCaps(false); else render() }
    else if (a === 'caps-close') { WB.capsOpen = false; render() }
    else if (a === 'caps-refresh') loadCaps(true)
    else if (a === 'wk-open') { WB.wkOpen = !WB.wkOpen; if (WB.wkOpen && WB.weekly === null) loadWeekly(); else render() }
    else if (a === 'wk-close') { WB.wkOpen = false; render() }
    else if (a === 'wk-refresh') { WB.weekly = null; WB.wkError = null; render(); loadWeekly() }
    else if (a === 'wk-show') { WB.wkShown = act.getAttribute('data-wb-week') || 'current'; render() }
    else if (a === 'tl-open') { WB.tlOpen = !WB.tlOpen; if (WB.tlOpen && WB.tl === null) loadTimeline(false); else render() }
    else if (a === 'tl-close') { WB.tlOpen = false; render() }
    else if (a === 'tl-refresh') loadTimeline(false)
    else if (a === 'tl-more') loadTimeline(true)
    else if (a === 'approval-submit') approvalAction('submit')
    else if (a === 'approval-withdraw') approvalAction('withdraw')
    else if (a === 'approval-approve') approvalAction('approve')
    else if (a === 'approval-reject') approvalAction('reject')
    else if (a === 'ho-open') { WB.hoOpen = !WB.hoOpen; if (WB.hoOpen) loadHandoff(); else render() }
    else if (a === 'ho-close') { WB.hoOpen = false; render() }
    else if (a === 'ho-refresh') loadHandoff()
    else if (a === 'ho-scope') { var sc = act.getAttribute('data-wb-scope'); if (sc === 'done' || sc === 'all') { WB.hoScope = sc; loadHandoff() } }
    else if (a === 'td-open') {
      WB.tdOpen = !WB.tdOpen; render()
      if (WB.tdOpen && WB.todos === null) loadTodos()
      if (WB.tdOpen && !WB.tdRem) loadReminder()
    }
    else if (a === 'td-rem-retry') { WB.tdRemError = null; WB.tdRem = null; render(); loadReminder() }
    else if (a === 'td-rem-save') saveReminderFromForm()
    else if (a === 'td-rem-test') reminderRequest('POST', '/api/workbench/todo-reminder/test', {}, 'workbench.td.rem.test_ok')
    else if (a === 'td-close') { WB.tdOpen = false; render() }
    else if (a === 'td-retry') { WB.tdError = null; WB.todos = null; render(); loadTodos() }
    else if (a === 'td-item') { var tid = act.getAttribute('data-wb-item-id'); if (tid) selectItem(tid) }
    else if (a === 'td-toggle' || a === 'td-delete' || a === 'td-norepeat') {
      var tdId = act.getAttribute('data-wb-todo')
      var cur = (WB.todos || []).filter(function (x) { return x.id === tdId })[0]
      if (!cur) return
      if (a === 'td-norepeat') tdRequest('PATCH', '/api/workbench/todos/' + encodeURIComponent(tdId), { repeat: '' }, 'norepeat')
      else if (a === 'td-toggle') tdRequest('PATCH', '/api/workbench/todos/' + encodeURIComponent(tdId), { done: cur.done_at == null }, cur.done_at == null ? 'done' : 'undone')
      else if (window.confirm(t('workbench.td.delete_confirm', { text: cur.text }))) tdRequest('DELETE', '/api/workbench/todos/' + encodeURIComponent(tdId), undefined, 'deleted')
    }
    else if (a === 'dec-open') { WB.decOpen = !WB.decOpen; render(); if (WB.decOpen) loadDecisions() }
    else if (a === 'dec-close') { WB.decOpen = false; WB.decEdit = null; render() }
    else if (a === 'dec-edit') { WB.decEdit = act.getAttribute('data-wb-dec'); render() }
    else if (a === 'dec-cancel') { WB.decEdit = null; render() }
    else if (a === 'dec-revoke') {
      if (window.confirm(t('workbench.dec.revoke_confirm'))) decRequest('PATCH', '/api/workbench/decisions/' + encodeURIComponent(act.getAttribute('data-wb-dec')), { revoked: true }, 'revoke')
    }
    else if (a === 'dec-restore') decRequest('PATCH', '/api/workbench/decisions/' + encodeURIComponent(act.getAttribute('data-wb-dec')), { revoked: false }, 'restore')
    else if (a === 'search-open') { WB.searchOpen = !WB.searchOpen; render(); if (WB.searchOpen) { var si = document.getElementById('wbSearchInput'); if (si && si.focus) si.focus() } }
    else if (a === 'search-close') { WB.searchOpen = false; render() }
    else if (a === 'cap-test') testCap(act.getAttribute('data-wb-cap'))
    else if (a === 'cap-save') saveCapSetting(act.getAttribute('data-wb-cap'))
    else if (a === 'canvas-start') { if (!archived()) startCanvas() }
    else if (a === 'canvas-refresh') loadCanvas(WB.selectedId)
    else if (a === 'canvas-edit') { WB.canvasEdit = act.getAttribute('data-wb-obj'); render() }
    else if (a === 'canvas-cancel') { WB.canvasEdit = null; render() }
    else if (a === 'canvas-save') { e.preventDefault(); saveCanvasObject(act.getAttribute('data-wb-obj')) }
    else if (a === 'canvas-add-text') { if (!archived()) canvasAddText() }
    else if (a === 'canvas-add-rect') { if (!archived()) canvasAddRect() }
    else if (a === 'canvas-add-image') { if (!archived()) canvasAddImage() }
    else if (a === 'canvas-remove') canvasRemoveObject(act.getAttribute('data-wb-obj'))
    else if (a === 'canvas-op') canvasQuickOp(act.getAttribute('data-wb-op'), act.getAttribute('data-wb-obj'))
    else if (a === 'preview-convert') convertPreview(false)
    else if (a === 'preview-convert-retry') convertPreview(true)
    else if (a === 'version-new') newVersion()
    else if (a === 'version-restore') restoreVersion(act.getAttribute('data-wb-version'))
    else if (a === 'chat-send') sendChat()
    else if (a === 'chat-stop') stopChat()
    else if (a === 'chat-setup') openChatSetup()
    else if (a === 'chat-setup-close') { WB.chatSetupOpen = false; renderChat() }
    else if (a === 'chat-setup-save') { e.preventDefault(); saveChatSetup() }
  })

  // ---- huzogatos szerkesztes: az esemenyek (kartya d4b05d82) ----------------
  //
  // EGY Pointer Events-figyelo lefedi az egeret ES az erintokepernyot is, tehat
  // telefonon ugyanugy mukodik. A huzas KOZBEN nem megy halozati keres: a doboz
  // helyben mozog, es csak az ELENGEDESKOR megy EGY `update` muvelet -- ugyanaz,
  // amit a szamokat kero urlap es az agent is kuldene, tehat a ket ut nem
  // csuszhat szet.

  var canvasDrag = null

  function canvasDragStyle(el, box, doc) {
    if (!el || !el.style) return
    el.style.left = (Math.round((10000 * box.x) / doc.width) / 100) + '%'
    el.style.top = (Math.round((10000 * box.y) / doc.height) / 100) + '%'
    el.style.width = (Math.round((10000 * box.width) / doc.width) / 100) + '%'
    el.style.height = (Math.round((10000 * box.height) / doc.height) / 100) + '%'
  }

  /** Huzas kozben a SZAMOK is latszanak: a felhasznalonak ne kelljen kitalalnia,
   *  hova kerult az elem. Ugyanazok az ertekek, mint a szerkeszto urlapon. */
  function canvasDragLive(box) {
    var el = document.getElementById('wbCanLive')
    if (!el) return
    var text = t('workbench.canvas.drag_live', { x: box.x, y: box.y, w: box.width, h: box.height })
    if ('textContent' in el) el.textContent = text
  }

  function canvasDragHighlight(stage, boxEl) {
    if (!stage || typeof stage.querySelectorAll !== 'function') return
    var all = stage.querySelectorAll('[data-wb-box]')
    for (var i = 0; i < all.length; i++) {
      all[i].className = 'wb-can-box' + (all[i] === boxEl ? ' wb-can-box-sel' : '')
    }
  }

  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || WB.canvasBusy || archived()) return
    var target = e.target
    if (!target || typeof target.closest !== 'function') return
    var boxEl = target.closest('[data-wb-box]')
    if (!boxEl) return
    var doc = (WB.canvas && WB.canvas.exists && WB.canvas.canvas) || null
    if (!doc) return
    var o = canvasObject(boxEl.getAttribute('data-wb-box'))
    if (!o) return
    var stage = target.closest('[data-wb-stage]')
    var rect = stage && typeof stage.getBoundingClientRect === 'function' ? stage.getBoundingClientRect() : null
    // Meret nelkul nem tudunk kepernyo-pixelbol vaszon-egyseget szamolni.
    // Ilyenkor INKABB nem mozdulunk, mint hogy talalgassunk: az urlap
    // (X, Y, Szelesseg, Magassag) tovabbra is ott van.
    if (!rect || !rect.width || !rect.height) return
    var gripEl = target.closest('[data-wb-grip]')
    var from = { x: o.x, y: o.y, width: o.width, height: o.height }
    canvasDrag = {
      id: o.id,
      mode: gripEl ? gripEl.getAttribute('data-wb-grip') : 'move',
      from: from,
      box: from,
      startX: e.clientX,
      startY: e.clientY,
      kx: doc.width / rect.width,
      ky: doc.height / rect.height,
      doc: doc,
      el: boxEl,
      moved: false,
    }
    WB.canvasSel = o.id
    canvasDragHighlight(stage, boxEl)
    // A mutato "hozzaragad" a dobozhoz: ha a kez kifut a kepbol, a huzas akkor
    // sem szakad meg.
    if (typeof boxEl.setPointerCapture === 'function' && e.pointerId != null) {
      try { boxEl.setPointerCapture(e.pointerId) } catch (err) { /* nem all meg tole a huzas */ }
    }
    if (typeof e.preventDefault === 'function') e.preventDefault()
  })

  document.addEventListener('pointermove', function (e) {
    var d = canvasDrag
    if (!d) return
    var sx = e.clientX - d.startX
    var sy = e.clientY - d.startY
    // Par pixel meg nem huzas, hanem kattintas (kijelolés). Kulonben minden
    // erintes elmozditana az elemet.
    if (!d.moved && Math.abs(sx) < 3 && Math.abs(sy) < 3) return
    d.moved = true
    d.box = canvasDragBox(d.from, d.mode, sx * d.kx, sy * d.ky)
    canvasDragStyle(d.el, d.box, d.doc)
    canvasDragLive(d.box)
    if (typeof e.preventDefault === 'function') e.preventDefault()
  })

  /** A huzas vege. `commit === false` (megszakitas) eseten NEM mentunk: a
   *  kovetkezo rajzolas visszateszi az elemet oda, ahol a szerveren all. */
  function canvasDragFinish(commit) {
    var d = canvasDrag
    if (!d) return
    canvasDrag = null
    var b = d.box
    var f = d.from
    var same = b.x === f.x && b.y === f.y && b.width === f.width && b.height === f.height
    if (!commit || !d.moved || same) { render(); return }
    canvasOps([{ op: 'update', id: d.id, patch: { x: b.x, y: b.y, width: b.width, height: b.height } }])
  }

  document.addEventListener('pointerup', function () { canvasDragFinish(true) })
  document.addEventListener('pointercancel', function () { canvasDragFinish(false) })

  // Nyilbillentyuk: eger nelkul is mozgathato az elem (Shift = nagyobb lepes).
  // Ez ugyanaz a `move` muvelet, amit az agent is kuldene.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || WB.canvasBusy || archived() || !e.target) return
    if (typeof e.target.closest !== 'function') return
    var boxEl = e.target.closest('[data-wb-box]')
    if (!boxEl) return
    var step = e.shiftKey ? 50 : 10
    var dx = 0
    var dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = -step
    else if (e.key === 'ArrowDown') dy = step
    else return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    WB.canvasSel = boxEl.getAttribute('data-wb-box')
    canvasOps([{ op: 'move', id: WB.canvasSel, dx: dx, dy: dy }])
  })

  // A bevitel erteket allapotban tartjuk: a chat-sav ujrarajzolasa (streameles
  // kozben soronkent) kulonben eltorolne a felig beirt mondatot.
  document.addEventListener('input', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbChatInput') WB.chatDraft = e.target.value
  })

  // Enter kuld, Shift+Enter uj sort ir. (Telefonon a gomb marad a fo ut.)
  // A szerkeszto tartalma az ALLAPOTBAN el, nem csak a mezoben: egy kozben
  // erkezo ujrarajzolas (attekinto, elonezet, lista) kulonben visszairna az
  // eredeti szoveget, es a begepelt munka elveszne.
  document.addEventListener('input', function (e) {
    if (!WB.open || !e.target) return
    if (e.target.id === 'wbCmpSlider' && WB.compare) {
      var pos = Math.max(0, Math.min(100, Number(e.target.value) || 0))
      WB.compare.pos = pos
      // Csak a ket stilus valtozik -- a kepet nem rajzoljuk ujra huzas kozben.
      var top = document.getElementById('wbCmpTop')
      if (top && top.style) top.style.clipPath = 'inset(0 ' + (100 - pos) + '% 0 0)'
      var line = document.getElementById('wbCmpLine')
      if (line && line.style) line.style.left = pos + '%'
      return
    }
    if ((e.target.id === 'wbSendTo' || e.target.id === 'wbSendSubject' || e.target.id === 'wbSendMessage') && WB.selectedId) {
      var ss = sendState()
      if (!ss || ss.result) { ss = { itemId: WB.selectedId, draft: {} }; WB.send = ss }
      ss.draft = readSendDraft()
      return
    }
    if (WB.table && tableCellInput(e.target.id, e.target.value)) return
    if (WB.img && /^wbImg/.test(String(e.target.id || '')) && imgField(e.target.id, e.target)) return
    if (e.target.id === 'wbTextEdit' && WB.textEdit) WB.textEdit.value = e.target.value
    else if (e.target.id === 'wbPartText' && WB.partEdit) WB.partDraft = { id: WB.partEdit, value: e.target.value }
  })

  // Ctrl+S / Cmd+S a szerkesztoben: mentes (uj verzio) -- a bongeszo sajat
  // "oldal mentese" ablaka helyett, ami itt senkinek nem kell.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 's') return
    var id = e.target.id
    if (/^wbCell_/.test(String(id || '')) && WB.table) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      saveTable()
      return
    }
    if (id !== 'wbTextEdit' && id !== 'wbPartText' && id !== 'wbPartNewText') return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    if (id === 'wbTextEdit') saveTextEdit()
    else if (id === 'wbPartText' && WB.partEdit) savePart(WB.partEdit)
    else if (id === 'wbPartNewText') addTextPart()
  })

  // Kepszerkeszto: kattintas az EREDMENYEN = a hatter egy pontja (arasztas innen).
  document.addEventListener('click', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var pick = e.target.closest('[data-wb-img-pick]')
    var st = imgState()
    if (!pick || !st || !st.bg.pick || typeof pick.getBoundingClientRect !== 'function') return
    var rect = pick.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    st.bg.seeds.push({
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    })
    st.dirty = true
    render()
    imgRefresh(false)
  })

  document.addEventListener('pointerdown', function (e) {
    if (!WB.open || !e.target || typeof e.target.closest !== 'function') return
    var h = e.target.closest('[data-wb-crop]')
    var st = imgState()
    var stage = document.getElementById('wbImgStage')
    if (!h || !st || !st.crop || !stage || typeof stage.getBoundingClientRect !== 'function') return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    imgDrag = {
      mode: h.getAttribute('data-wb-crop'), x0: e.clientX, y0: e.clientY, rect: stage.getBoundingClientRect(),
      crop: { x: st.crop.x, y: st.crop.y, w: st.crop.w, h: st.crop.h }, last: null,
    }
    if (h.setPointerCapture && e.pointerId != null) { try { h.setPointerCapture(e.pointerId) } catch (_e) { /* nem baj */ } }
  })

  document.addEventListener('pointermove', function (e) {
    if (!imgDrag) return
    var st = imgState()
    if (!st) { imgDrag = null; return }
    var c = imgDragApply(imgDrag, e.clientX, e.clientY)
    if (!c) return
    imgDrag.last = c
    var box = document.querySelector('[data-wb-crop="move"]')
    var saved = st.crop
    st.crop = c
    if (box && box.setAttribute) box.setAttribute('style', imgCropStyle(st))
    st.crop = saved
  })

  function imgDragEnd(commit) {
    if (!imgDrag) return
    var st = imgState()
    var c = imgDrag.last
    imgDrag = null
    if (!st || !c || !commit) { render(); return }
    st.crop = c
    st.aspect = IMG_ASPECTS[st.aspect] ? st.aspect : 'free'
    st.outW = c.w
    st.bg.seeds = []
    st.dirty = true
    render()
    imgRefresh(false)
  }
  document.addEventListener('pointerup', function () { imgDragEnd(true) })
  document.addEventListener('pointercancel', function () { imgDragEnd(false) })

  // Tablazat: Enter = a lenti cella (mint az Excelben), Shift+Enter = a fenti.
  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || !WB.table || e.key !== 'Enter') return
    var m = /^wbCell_(\d+)_(\d+)$/.exec(String(e.target.id || ''))
    if (!m) return
    if (typeof e.preventDefault === 'function') e.preventDefault()
    var sh = tableSheet()
    var r = Number(m[1]) + (e.shiftKey ? -1 : 1)
    if (!sh || r < 0 || r >= sh.rows.length) return
    WB.table.sel = { r: r, c: Number(m[2]) }
    var next = document.getElementById('wbCell_' + r + '_' + m[2])
    if (!next) { WB.table.page = Math.floor(r / TABLE_PAGE); render(); next = document.getElementById('wbCell_' + r + '_' + m[2]) }
    if (next && typeof next.focus === 'function') next.focus()
  })

  document.addEventListener('focusin', function (e) {
    if (!WB.open || !WB.table || !e.target) return
    var m = /^wbCell_(\d+)_(\d+)$/.exec(String(e.target.id || ''))
    if (m) WB.table.sel = { r: Number(m[1]), c: Number(m[2]) }
  })

  document.addEventListener('keydown', function (e) {
    if (!WB.open || !e.target || e.target.id !== 'wbChatInput') return
    if (e.key === 'Enter' && !e.shiftKey) {
      if (typeof e.preventDefault === 'function') e.preventDefault()
      WB.chatDraft = e.target.value
      sendChat()
    }
  })

  document.addEventListener('change', function (e) {
    if (!WB.open || !e.target) return
    if (WB.img && /^wbImg(CapPos|CapColor|CapBand)$/.test(String(e.target.id || '')) && imgField(e.target.id, e.target)) return
    if (e.target.id === 'wbSwitch') {
      selectItem(e.target.value)
      return
    }
    if ((e.target.id === 'wbCmpLeft' || e.target.id === 'wbCmpRight') && WB.compare) {
      if (e.target.id === 'wbCmpLeft') WB.compare.left = e.target.value
      else WB.compare.right = e.target.value
      render()
      loadCompareSide(e.target.value)
      return
    }
    if (e.target.id === 'wbUploadNew') {
      var picked = e.target.files
      if (picked && picked.length) uploadFiles(picked, 'new')
      try { e.target.value = '' } catch (_e) { /* regi bongeszo: nem baj */ }
      return
    }
    if (e.target.id === 'wbDocUpload') {
      var docs = e.target.files
      if (docs && docs.length) uploadDocumentVersion(docs[0])
      return
    }
    if (e.target.id === 'wbPartImage') {
      var files = e.target.files
      if (files && files.length) uploadImagePart(files[0])
      return
    }
    // Verzio-valaszto az elonezethez: a REGI verziot is meg lehet nezni.
    if (e.target.id === 'wbPreviewVersion' && WB.selectedId) {
      WB.previewVersion = e.target.value || null
      loadPreview(WB.selectedId, WB.previewVersion)
    }
  })

  // Behuzas: a bongeszo alapbol MEGNYITNA a fajlt (elhagyva a Munkapadot) --
  // ezt csak a Munkapadon belul akadalyozzuk meg, mashol nem szolunk bele.
  document.addEventListener('dragover', function (e) {
    if (!WB.open || !hasFiles(e) || !inWorkbench(e)) return
    e.preventDefault()
    if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'copy' } catch (_e) { /* nem baj */ } }
    setDragging(true)
  })
  document.addEventListener('dragleave', function (e) {
    if (!WB.open) return
    // Csak ha tenyleg kiment a Munkapadrol (a gyerek-elemek kozott is jon dragleave).
    if (!e.relatedTarget || !inWorkbench({ target: e.relatedTarget })) setDragging(false)
  })
  document.addEventListener('drop', function (e) {
    if (!WB.open || !inWorkbench(e)) return
    setDragging(false)
    if (!hasFiles(e)) return
    e.preventDefault()
    uploadFiles(e.dataTransfer.files, dropTarget(e))
  })
  // Beillesztes (Ctrl+V): kepernyokep, masolt fajl. Szoveg beillesztesebe
  // nem szolunk bele -- csak ha a vagolapon FAJL van.
  document.addEventListener('paste', function (e) {
    if (!WB.open) return
    var files = e && e.clipboardData && e.clipboardData.files
    if (!files || !files.length) return
    e.preventDefault()
    uploadFiles(files, WB.selectedId && WB.detail ? 'item' : 'new')
  })

  document.addEventListener('submit', function (e) {
    if (!WB.open) return
    if (e.target && e.target.id === 'wbNewForm') { e.preventDefault(); create() }
    if (e.target && e.target.id === 'wbTextEditForm') { e.preventDefault(); saveTextEdit() }
    if (e.target && e.target.id === 'wbSendForm') { e.preventDefault(); sendRequest() }
    if (e.target && e.target.id === 'wbPartNewForm') { e.preventDefault(); addTextPart() }
    if (e.target && e.target.id === 'wbPartForm') { e.preventDefault(); savePart(WB.partEdit) }
    if (e.target && e.target.id === 'wbChatSetup') { e.preventDefault(); saveChatSetup() }
    if (e.target && e.target.id === 'wbSearchForm') { e.preventDefault(); runSearch() }
    if (e.target && e.target.id === 'wbDecForm') { e.preventDefault(); addDecisionFromForm() }
    if (e.target && e.target.id === 'wbTdForm') { e.preventDefault(); addTodoFromForm() }
    if (e.target && e.target.id === 'wbDecEditForm') { e.preventDefault(); saveDecisionEdit() }
  })

  /** Alaphelyzet RAJZOLAS NELKUL: az oldal-betolto hivja, amikor a Projektek
   *  oldal ujraindul. A `closeWorkbench()` visszavinne a projekt-oldalra --
   *  itt eppen az a dolgunk, hogy ne szoljunk bele abba, amit a hivo rajzol. */
  function resetWorkbench() {
    if (WB.liveTimer) { clearTimeout(WB.liveTimer); WB.liveTimer = null }
    WB.open = false
    WB.projectId = null
    WB.project = null
    WB.items = null
    WB.detail = null
    WB.selectedId = null
    WB.formOpen = false
    WB.busy = false
    WB.error = null
    WB.panel = 'items'
    WB.chat = {}
    WB.chatStatus = null
    WB.chatStatusError = null
    WB.chatStreaming = false
    if (WB.chatAbort && typeof WB.chatAbort.abort === 'function') WB.chatAbort.abort()
    WB.chatAbort = null
    WB.chatDraft = ''
    WB.chatSetupOpen = false
    WB.chatSetupBusy = false
    WB.chatConfig = null
    WB.partEdit = null
    WB.partNewOpen = false
    WB.partBusy = false
    WB.preview = null
    WB.previewVersion = null
    WB.table = null
    WB.img = null
    WB.overview = null
    WB.overviewError = null
  }

  window.MarvinWorkbench = {
    open: openWorkbench,
    close: closeWorkbench,
    reset: resetWorkbench,
    isOpen: function () { return WB.open },
    // A kepszerkeszto tiszta (DOM nelkuli) lepesei -- a tesztek ezeket merik.
    _img: { floodKey: imgFloodKey, clampCrop: imgClampCrop, aspectCrop: imgAspectCrop, outSize: imgOutSize, rotSize: imgRotSize },
  }
})()
