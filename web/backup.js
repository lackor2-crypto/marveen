/* TELJES MENTES -- Beallitasok -> Mentes lap (kanban #396, 3. fazis).
 *
 * Kulon fajl, szandekosan (fork-barat, mint a workbench.js): az app.js-ben
 * csak a ful letrehozasa all, a lap minden resze itt van.
 *
 * Felulrol lefele: allapot-sor, [Mentes most], vészhelyzeti lap (a kulcs),
 * hova megy a mentes, mikor, a mentesek listaja, halado beallitasok. Minden
 * mezonel ott all, MI ez, MIERT kell, es mi tortenik nelkule.
 *
 * Az app.js-bol hasznalt globalisok: t, escapeHtml, escapeAttr, showToast,
 * switchPage. Minden szoveg a t()-n megy at (HU/EN), kulcs-elotag: `fbk.`
 * (a `backup.` elotag a #350 mappa-mentes szabalyaie).
 */
(function () {
  'use strict'

  var S = {
    host: null,
    status: null,
    list: null,
    accounts: null,
    job: null,
    kit: null,
    kitShown: false,
    kitOpen: false,
    error: null,
    busy: false,
  }

  function L() { return (window._lang === 'en') ? 'en' : 'hu' }
  function tr(k, p) { return t(k, p || {}) }
  function h(s) { return escapeHtml(String(s == null ? '' : s)) }
  function a(s) { return escapeAttr(String(s == null ? '' : s)) }

  async function api(method, url, body) {
    var sep = url.indexOf('?') >= 0 ? '&' : '?'
    var init = { method: method, headers: {} }
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) }
    var res = await fetch(url + sep + 'lang=' + L(), init)
    var data = null
    try { data = await res.json() } catch (e) { data = null }
    if (!res.ok) {
      var err = new Error((data && data.message) || tr('fbk.err.generic'))
      err.code = data && data.error
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  // /mnt/f/Marveen/... -> F:\Marveen\... (a felhasznalo a Windows-alakot ismeri)
  function winPath(p) {
    var m = /^\/mnt\/([a-z])\/(.*)$/.exec(String(p || ''))
    return m ? (m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\')) : String(p || '')
  }

  function fmtSize(n) {
    n = Number(n) || 0
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB'
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return n + ' B'
  }

  function fmtTime(ms) {
    if (!ms) return ''
    try { return new Date(ms).toLocaleString(L() === 'en' ? 'en-GB' : 'hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch (e) { return String(ms) }
  }

  function destLabel(id) { return tr('fbk.dest.' + id) }

  // ---------------------------------------------------------------- load

  async function load() {
    S.error = null
    try {
      var r = await Promise.all([api('GET', '/api/backup/status'), api('GET', '/api/backup/list'), api('GET', '/api/backup/cloud-accounts')])
      S.status = r[0]; S.list = r[1]; S.accounts = r[2].accounts || []
      if (S.status.running && !S.job) { S.job = { jobId: S.status.running.jobId, stage: S.status.running.stage, done: false }; poll() }
    } catch (e) {
      S.error = e.message
    }
    render()
  }

  // ---------------------------------------------------------------- render

  function statusHtml() {
    var st = S.status
    var hr = st.health || null
    var tone = hr ? (hr.status === 'bad' ? 'bad' : hr.status === 'warn' ? 'warn' : 'ok') : 'ok'
    var line = ''
    if (st.state.lastSuccessAt) {
      var places = []
      var reps = st.state.replicas || {}
      ;['local', 'depot', 'cloud'].forEach(function (d) { if (reps[d] && reps[d].ok && reps[d].name === st.state.lastSuccessName) places.push(destLabel(d)) })
      if (!places.length) places.push(destLabel('local'))
      line = tr('fbk.status.last', { when: fmtTime(st.state.lastSuccessAt), n: places.length, places: places.join(', ') })
    } else {
      line = tr('fbk.status.none', { time: st.config.schedule.time })
    }
    var extra = hr && hr.status !== 'ok' ? '<div class="bk-status-sub">' + h(tr('health.' + hr.id, hr.params || {})) + ' ' + h(tr('health.' + hr.id + '_action', hr.params || {})) + '</div>' : ''
    return '<div class="bk-status bk-tone-' + tone + '"><div class="bk-status-main">' + h(line) + '</div>' + extra + '</div>'
  }

  function runHtml() {
    var j = S.job
    var running = j && !j.done
    var stage = running ? '<span class="bk-stage">' + h(tr('fbk.stage.' + (j.stage || 'starting'))) + '</span>' : ''
    return '<div class="bk-row">' +
      '<div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.run.title')) + '</div>' +
      '<div class="bk-row-desc">' + h(tr('fbk.why')) + '</div></div>' +
      '<div class="bk-row-actions"><button class="btn-primary" data-bk="run"' + (running ? ' disabled' : '') + '>' + h(running ? tr('fbk.run.running') : tr('fbk.run')) + '</button>' + stage + '</div>' +
      '</div>'
  }

  function kitHtml() {
    var k = S.status.key || {}
    var confirmed = !!k.confirmedAt
    var loginOn = !!S.status.loginOn
    if (confirmed && !S.kitOpen) {
      return '<div class="bk-row"><div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.kit.title')) + ' ✓</div>' +
        '<div class="bk-row-desc">' + h(tr('fbk.kit.saved', { id: k.keyId || '' })) + '</div></div>' +
        '<div class="bk-row-actions"><button class="btn-secondary btn-compact" data-bk="kit-open">' + h(tr('fbk.kit.show_again')) + '</button></div></div>'
    }
    var keyBox = ''
    if (S.kit && S.kitShown) {
      keyBox = '<div class="bk-key"><code>' + h(S.kit.current.key) + '</code>' +
        '<div class="bk-row-meta">' + h(tr('fbk.kit.key_id', { id: S.kit.current.keyId })) + '</div>' +
        (S.kit.previous && S.kit.previous.length ? '<div class="bk-row-meta">' + h(tr('fbk.kit.previous', { n: S.kit.previous.length })) + '</div>' : '') +
        '</div>'
    }
    var pw = loginOn && !S.kit
      ? '<label class="bk-field"><span>' + h(tr('fbk.kit.password')) + '</span><input type="password" class="input" id="bkKitPw" autocomplete="current-password"></label>'
      : ''
    return '<div class="bk-row bk-kit' + (confirmed ? '' : ' bk-tone-warn') + '">' +
      '<div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.kit.title')) + '</div>' +
      '<div class="bk-row-desc">' + h(tr('fbk.kit.why')) + '</div>' +
      '<div class="bk-row-meta">' + h(tr('fbk.kit.where')) + '</div>' + pw + keyBox +
      '<label class="bk-check"><input type="checkbox" data-bk="kit-confirm"' + (confirmed ? ' checked disabled' : '') + (S.kit ? '' : ' disabled') + '> ' + h(tr('fbk.kit.confirm')) + '</label>' +
      (S.kit ? '' : '<div class="bk-row-meta">' + h(tr('fbk.kit.confirm_hint')) + '</div>') +
      '</div>' +
      '<div class="bk-row-actions">' +
      '<button class="btn-secondary btn-compact" data-bk="kit-show">' + h(S.kitShown ? tr('fbk.kit.hide') : tr('fbk.kit.show')) + '</button>' +
      '<button class="btn-secondary btn-compact" data-bk="kit-download">' + h(tr('fbk.kit.download')) + '</button>' +
      (confirmed ? '<button class="btn-secondary btn-compact" data-bk="kit-close">' + h(tr('fbk.kit.close')) + '</button>' : '') +
      '</div></div>'
  }

  function destRowHtml(d) {
    var rep = (S.status.state.replicas || {})[d.id]
    var last = rep ? (rep.ok ? tr('fbk.dest.last_ok', { when: fmtTime(rep.at) }) : tr('fbk.reason.' + (rep.reason || 'failed'), {}) + (rep.detail ? ' (' + rep.detail + ')' : '')) : ''
    var body = ''
    var actions = ''
    if (d.id === 'local') {
      body = '<div class="bk-row-meta">' + h(tr('fbk.dest.local_where')) + '</div>'
      actions = '<span class="bk-pill">' + h(tr('fbk.dest.always_on')) + '</span>'
    } else if (d.id === 'depot') {
      if (d.off === 'not_configured') {
        body = '<div class="bk-row-meta">' + h(tr('fbk.dest.depot_none')) + '</div>'
        actions = '<button class="btn-secondary btn-compact" data-bk="goto" data-page="drive">' + h(tr('fbk.dest.depot_setup')) + '</button>'
      } else {
        body = '<div class="bk-row-meta">' + h(tr('fbk.dest.where', { where: winPath(d.where) })) + '</div>'
        actions = '<label class="bk-switch"><input type="checkbox" data-bk="depot-toggle"' + (d.enabled ? ' checked' : '') + '> ' + h(tr('fbk.dest.on')) + '</label>'
      }
    } else {
      var accs = S.accounts || []
      var cfg = S.status.config.cloud
      var opts = '<option value="">' + h(tr('fbk.cloud.none')) + '</option>'
      accs.forEach(function (x) {
        var v = x.kind + '|' + x.account
        var sel = cfg.kind === x.kind && cfg.account === x.account ? ' selected' : ''
        opts += '<option value="' + a(v) + '"' + sel + '>' + h((x.kind === 'mega' ? 'MEGA' : 'Google Drive') + ' – ' + x.label) + '</option>'
      })
      body = accs.length
        ? '<label class="bk-field"><span>' + h(tr('fbk.cloud.account')) + '</span><select class="input" id="bkCloudAcc">' + opts + '</select></label>' +
          '<label class="bk-field"><span>' + h(tr('fbk.cloud.folder')) + '</span><input class="input" id="bkCloudFolder" value="' + a(cfg.folderName || '') + '" placeholder="' + a(S.status.defaultCloudFolder) + '"></label>' +
          '<div class="bk-row-meta">' + h(tr('fbk.cloud.folder_hint')) + '</div>'
        : '<div class="bk-row-meta">' + h(tr('fbk.cloud.no_accounts')) + '</div>'
      actions = accs.length
        ? '<button class="btn-secondary btn-compact" data-bk="cloud-save">' + h(tr('fbk.save')) + '</button>'
        : '<button class="btn-secondary btn-compact" data-bk="goto" data-page="accounts">' + h(tr('fbk.cloud.connect')) + '</button>'
    }
    return '<div class="bk-row">' +
      '<div class="bk-row-info"><div class="bk-row-title">' + h(destLabel(d.id)) + '</div>' +
      '<div class="bk-row-desc">' + h(tr('fbk.dest.' + d.id + '_why')) + '</div>' +
      '<div class="bk-row-meta">' + h(tr('fbk.dest.' + d.id + '_off')) + '</div>' + body +
      (last ? '<div class="bk-row-meta">' + h(last) + '</div>' : '') +
      '</div><div class="bk-row-actions">' + actions + '</div></div>'
  }

  function scheduleHtml() {
    var sc = S.status.config.schedule
    return '<div class="bk-row"><div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.when.title')) + '</div>' +
      '<div class="bk-row-desc">' + h(tr('fbk.when.why')) + '</div>' +
      '<div class="bk-row-meta">' + h(tr('fbk.when.retention')) + '</div>' +
      '<label class="bk-field"><span>' + h(tr('fbk.when.time')) + '</span><input type="time" class="input" id="bkTime" value="' + a(sc.time) + '"></label>' +
      '<label class="bk-check"><input type="checkbox" id="bkSchedOn"' + (sc.enabled ? ' checked' : '') + '> ' + h(tr('fbk.when.enabled')) + '</label>' +
      '</div><div class="bk-row-actions"><button class="btn-secondary btn-compact" data-bk="schedule-save">' + h(tr('fbk.save')) + '</button></div></div>'
  }

  function listHtml() {
    var l = S.list || { backups: [], sources: {} }
    var src = l.sources || {}
    var notes = []
    ;['depot', 'cloud'].forEach(function (id) {
      var s = src[id]
      if (s && !s.ok && s.reason !== 'not_configured' && s.reason !== 'disabled') notes.push(destLabel(id) + ': ' + tr('fbk.reason.' + (s.reason || 'failed')))
    })
    var rows = (l.backups || []).map(function (b) {
      var where = b.where.map(destLabel).join(', ')
      var ver = b.verified === true ? '✓ ' + tr('fbk.list.verified') : b.verified === false ? '✗ ' + tr('fbk.list.verify_failed') : tr('fbk.list.not_verified')
      var dl = b.where.indexOf('local') >= 0
        ? '<button class="btn-secondary btn-compact" data-bk="download" data-name="' + a(b.name) + '">' + h(tr('fbk.list.download')) + '</button>'
        : ''
      return '<div class="bk-item"><div class="bk-item-main"><strong>' + h(fmtTime(b.time)) + '</strong>' +
        (b.kind === 'pre-restore' ? ' <span class="bk-pill">' + h(tr('fbk.list.pre_restore')) + '</span>' : '') +
        '<div class="bk-row-meta">' + h(fmtSize(b.size)) + ' · ' + h(where) + ' · ' + h(ver) + '</div></div>' +
        '<div class="bk-row-actions">' + dl +
        '<button class="btn-secondary btn-compact" data-bk="r-open" data-source="' + a(b.where.indexOf('local') >= 0 ? 'local' : b.where[0]) + '" data-name="' + a(b.name) + '">' + h(tr('fbk.list.restore')) + '</button>' +
        '</div></div>'
    }).join('')
    var empty = !(l.backups || []).length ? '<div class="bk-row-meta">' + h(tr('fbk.list.empty')) + '</div>' : ''
    return '<div class="settings-group-title">' + h(tr('fbk.list.title')) + '</div>' +
      (notes.length ? '<div class="bk-row-meta bk-tone-warn-text">' + h(notes.join(' · ')) + '</div>' : '') +
      '<div class="bk-list">' + rows + empty + '</div>'
  }

  function advancedHtml() {
    var cfg = S.status.config
    var loginOn = !!S.status.loginOn
    return '<details class="bk-advanced"><summary>' + h(tr('fbk.adv.title')) + '</summary>' +
      '<div class="bk-row"><div class="bk-row-info"><label class="bk-check"><input type="checkbox" id="bkLogs"' + (cfg.includeLogs ? ' checked' : '') + '> ' + h(tr('fbk.adv.logs')) + '</label>' +
      '<div class="bk-row-meta">' + h(tr('fbk.adv.logs_why')) + '</div></div>' +
      '<div class="bk-row-actions"><button class="btn-secondary btn-compact" data-bk="logs-save">' + h(tr('fbk.save')) + '</button></div></div>' +
      '<div class="bk-row"><div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.adv.key_title')) + '</div>' +
      '<div class="bk-row-desc">' + h(tr('fbk.adv.key_why')) + '</div>' +
      '<label class="bk-field"><span>' + h(tr('fbk.adv.own')) + '</span><input type="password" class="input" id="bkOwnPw" autocomplete="new-password"></label>' +
      (loginOn ? '<label class="bk-field"><span>' + h(tr('fbk.kit.password')) + '</span><input type="password" class="input" id="bkRotPw" autocomplete="current-password"></label>' : '') +
      '</div><div class="bk-row-actions">' +
      '<button class="btn-secondary btn-compact" data-bk="own-save">' + h(tr('fbk.adv.own_save')) + '</button>' +
      '<button class="btn-secondary btn-compact" data-bk="rotate">' + h(tr('fbk.adv.rotate')) + '</button>' +
      '</div></div></details>'
  }

  function render() {
    var host = S.host
    if (!host) return
    if (S.error && !S.status) {
      host.innerHTML = '<div class="bk"><p class="bk-error">' + h(S.error) + '</p><button class="btn-secondary btn-compact" data-bk="reload">' + h(tr('fbk.retry')) + '</button></div>'
      return
    }
    if (!S.status) { host.innerHTML = '<p class="bk-row-meta" style="padding:16px">' + h(tr('settings.loading')) + '</p>'; return }
    host.innerHTML = '<div class="bk">' +
      '<div class="settings-group-title">' + h(tr('fbk.title')) + '</div>' +
      statusHtml() + runHtml() + kitHtml() +
      '<div class="settings-group-title">' + h(tr('fbk.dest.title')) + '</div>' +
      (S.status.destinations || []).map(destRowHtml).join('') +
      scheduleHtml() + listHtml() +
      '<div class="settings-group-title">' + h(tr('fbk.r.title')) + '</div>' +
      '<div id="bkRestoreHost"></div>' +
      advancedHtml() +
      '</div>'
    mountRestore(document.getElementById('bkRestoreHost') || null)
  }

  // ---------------------------------------------------------------- actions

  async function poll() {
    var j = S.job
    if (!j || j.done) return
    try {
      var r = await api('GET', '/api/backup/jobs/' + encodeURIComponent(j.jobId))
      j.stage = r.stage
      if (r.done) {
        j.done = true
        var res = r.result || {}
        if (res.ok) {
          var copies = (res.replicas || []).filter(function (x) { return x.ok }).length
          showToast(tr('fbk.run.done', { n: copies || 1, size: fmtSize(res.size) }), { type: 'success' })
        } else {
          showToast(r.message || tr('fbk.err.generic'), { type: 'error' })
        }
        await load()
        return
      }
      render()
    } catch (e) {
      j.done = true
      showToast(e.message, { type: 'error' })
      await load()
      return
    }
    setTimeout(poll, 1500)
  }

  async function run() {
    try {
      var r = await api('POST', '/api/backup/run')
      S.job = { jobId: r.jobId, stage: 'starting', done: false }
      render()
      setTimeout(poll, 800)
    } catch (e) { showToast(e.message, { type: 'error' }) }
  }

  async function fetchKit() {
    var pwEl = document.getElementById('bkKitPw')
    var body = { password: pwEl ? pwEl.value : '' }
    S.kit = await api('POST', '/api/backup/kit', body)
    return S.kit
  }

  function kitText(kit) {
    var lines = [
      tr('fbk.kittxt.title'),
      '',
      tr('fbk.kittxt.key') + ' ' + kit.current.key,
      tr('fbk.kittxt.key_id') + ' ' + kit.current.keyId,
      tr('fbk.kittxt.created') + ' ' + kit.current.createdAt,
      '',
      tr('fbk.kittxt.what'),
      '',
      tr('fbk.kittxt.how_title'),
      tr('fbk.kittxt.how1'),
      tr('fbk.kittxt.how2'),
      tr('fbk.kittxt.how3'),
      tr('fbk.kittxt.how4'),
    ]
    if (kit.previous && kit.previous.length) {
      lines.push('', tr('fbk.kittxt.previous'))
      kit.previous.forEach(function (p) { lines.push('  ' + p.key + '   (' + tr('fbk.kittxt.key_id') + ' ' + p.keyId + ', ' + p.createdAt + ')') })
    }
    return lines.join('\r\n') + '\r\n'
  }

  // A fajl fetch-csel jon (a hozzaferesi token csak igy megy vele), es blobkent
  // adjuk at a bongeszonek -- ugyanaz a fogas, mint a Drive-letoltesnel.
  async function downloadBackup(name) {
    showToast(tr('fbk.list.download_started', { name: name }))
    var res = await fetch('/api/backup/download/' + encodeURIComponent(name) + '?lang=' + L())
    if (!res.ok) {
      var d = null
      try { d = await res.json() } catch (e) { d = null }
      throw new Error((d && d.message) || tr('fbk.err.generic'))
    }
    downloadBlob(name, await res.blob())
  }

  function downloadText(name, text) {
    downloadBlob(name, new Blob([text], { type: 'text/plain;charset=utf-8' }))
  }

  function downloadBlob(name, blob) {
    var url = URL.createObjectURL(blob)
    var el = document.createElement('a')
    el.href = url
    el.download = name
    document.body.appendChild(el)
    el.click()
    setTimeout(function () { URL.revokeObjectURL(url); el.remove() }, 1000)
  }

  async function onClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-bk]') : null
    if (!el || S.busy) return
    var act = el.getAttribute('data-bk')
    if (act === 'kit-confirm') return
    ev.preventDefault()
    S.busy = true
    try {
      if (act === 'w-restore' || act === 'w-fresh') await wizardChoice(act === 'w-restore' ? 'restore' : 'fresh')
      else if (act.indexOf('r-') === 0) await restoreAction(act, el)
      else if (act === 'reload') await load()
      else if (act === 'run') await run()
      else if (act === 'download') await downloadBackup(el.getAttribute('data-name'))
      else if (act === 'goto') { if (typeof switchPage === 'function') switchPage(el.getAttribute('data-page')) }
      else if (act === 'kit-open') { S.kitOpen = true; render() }
      else if (act === 'kit-close') { S.kitOpen = false; S.kitShown = false; render() }
      else if (act === 'kit-show') {
        if (S.kitShown) { S.kitShown = false; render() }
        else { if (!S.kit) await fetchKit(); S.kitShown = true; await load() }
      } else if (act === 'kit-download') {
        var kit = S.kit || await fetchKit()
        downloadText('marveen-backup-key-' + kit.current.keyId + '.txt', kitText(kit))
        await load()
      } else if (act === 'depot-toggle') {
        await api('PUT', '/api/backup/config', { depot: { enabled: el.checked } })
        await load()
      } else if (act === 'cloud-save') {
        var v = (document.getElementById('bkCloudAcc') || {}).value || ''
        var folder = (document.getElementById('bkCloudFolder') || {}).value || ''
        var parts = v ? v.split('|') : [null, null]
        await api('PUT', '/api/backup/config', { cloud: { kind: parts[0] || null, account: parts.slice(1).join('|') || null, folderName: folder } })
        showToast(tr('fbk.saved'), { type: 'success' })
        await load()
      } else if (act === 'schedule-save') {
        await api('PUT', '/api/backup/config', { schedule: { time: document.getElementById('bkTime').value, enabled: document.getElementById('bkSchedOn').checked } })
        showToast(tr('fbk.saved'), { type: 'success' })
        await load()
      } else if (act === 'logs-save') {
        await api('PUT', '/api/backup/config', { includeLogs: document.getElementById('bkLogs').checked })
        showToast(tr('fbk.saved'), { type: 'success' })
        await load()
      } else if (act === 'own-save' || act === 'rotate') {
        if (!window.confirm(tr(act === 'rotate' ? 'fbk.adv.rotate_confirm' : 'fbk.adv.own_confirm'))) return
        var body = { password: (document.getElementById('bkRotPw') || {}).value || '' }
        if (act === 'own-save') body.ownPassword = (document.getElementById('bkOwnPw') || {}).value || ''
        await api('POST', '/api/backup/key/rotate', body)
        S.kit = null; S.kitShown = false; S.kitOpen = true
        showToast(tr('fbk.adv.rotated'), { type: 'success' })
        await load()
      }
    } catch (e) {
      showToast(e.message, { type: 'error' })
    } finally {
      S.busy = false
    }
  }

  async function onChange(ev) {
    var el = ev.target
    if (el && el.getAttribute && el.getAttribute('data-bk') === 'r-file') { await restoreUpload(el); return }
    if (el && el.getAttribute && el.getAttribute('data-bk') === 'r-cat') { toggleCat(el); return }
    if (!el || !el.getAttribute || el.getAttribute('data-bk') !== 'kit-confirm' || !el.checked) return
    try {
      await api('POST', '/api/backup/kit/confirm')
      S.kitOpen = false; S.kitShown = false
      showToast(tr('fbk.kit.confirmed'), { type: 'success' })
      await load()
    } catch (e) { el.checked = false; showToast(e.message, { type: 'error' }) }
  }

  // ================================================================ restore
  // One flow, two homes: the "Restore" section of this page, and the first
  // screen of a fresh install ("Do you have a backup?"). Steps: choose ->
  // (key) -> preview -> confirm -> progress (survives the restart) -> result.

  var R = {
    host: null,
    step: 'choose',
    src: null,
    preview: null,
    exclude: {},
    keyId: null,
    status: null,
    polling: false,
    wizard: false,
  }

  function rh(html) { if (R.host) R.host.innerHTML = html }

  function countRows(p) {
    var cur = (p.dbCounts && p.dbCounts.current) || {}
    var bak = (p.dbCounts && p.dbCounts.backup) || {}
    return ['kanban_cards', 'memories', 'projects', 'approvals'].filter(function (t) { return bak[t] !== undefined }).map(function (t) {
      return '<div class="bk-row-meta">' + h(tr('fbk.r.count', { what: tr('fbk.r.t.' + t), now: cur[t] || 0, backup: bak[t] })) + '</div>'
    }).join('')
  }

  function catRows(p) {
    return (p.categories || []).map(function (c) {
      var optional = (p.optional || []).indexOf(c.id) >= 0
      var detail = tr('fbk.r.cat_detail', { add: c.willAdd, over: c.willOverwrite, held: c.held })
      var box = c.id === 'database'
        ? '<input type="checkbox" checked disabled>'
        : optional ? '<input type="checkbox" data-bk="r-cat" data-cat="' + a(c.id) + '"' + (R.exclude[c.id] ? '' : ' checked') + '>' : '<input type="checkbox" checked disabled>'
      return '<label class="bk-check">' + box + ' <span><strong>' + h(tr('fbk.cat.' + c.id)) + '</strong> — ' + h(detail) + '</span></label>' +
        (c.id === 'database' ? '<div class="bk-row-meta">' + h(tr('fbk.r.db_fixed')) + '</div>' : '')
    }).join('')
  }

  function warnRows(p) {
    return (p.warnings || []).map(function (w) {
      var items = w.items && w.items.length ? ' (' + w.items.slice(0, 8).join(', ') + ')' : ''
      return '<div class="bk-row-meta bk-tone-warn-text">' + h(tr('fbk.r.warn.' + w.code, { n: w.n || 0 }) + items) + '</div>'
    }).join('')
  }

  // The outcome codes the runner writes (src/backup/restore.ts RestoreOutcomeCode).
  var FAIL_CODES = ['failed', 'interrupted', 'busy', 'stop_failed', 'never_started']

  // With a dashboard login, the start needs the password typed now (an agent
  // holds the access token, never the password).
  function confirmFields(p) {
    if (!p.confirm || p.confirm === 'none') return ''
    var user = p.confirm === 'user_password'
      ? '<label class="bk-field"><span>' + h(tr('fbk.r.pw_user')) + '</span><input class="input" id="bkRestoreUser" autocomplete="username" spellcheck="false"></label>'
      : ''
    return user + '<label class="bk-field"><span>' + h(tr('fbk.r.pw')) + '</span><input class="input" type="password" id="bkRestorePw" autocomplete="current-password"></label>' +
      '<div class="bk-row-meta">' + h(tr('fbk.r.pw_why')) + '</div>'
  }

  function renderRestore() {
    if (!R.host) return
    var st = R.status
    var head = ''
    if (st && st.channelsHeld) {
      head = '<div class="bk-row bk-tone-warn"><div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.r.held_title')) + '</div>' +
        '<div class="bk-row-desc">' + h(tr('fbk.channels.paused')) + '</div></div>' +
        '<div class="bk-row-actions"><button class="btn-primary" data-bk="r-release">' + h(tr('fbk.r.release')) + '</button></div></div>'
    }
    if (R.step === 'running') {
      rh(head + '<div class="bk-row"><div class="bk-row-info"><div class="bk-row-title">' + h(tr('fbk.r.running')) + '</div>' +
        '<div class="bk-row-desc">' + h(tr('fbk.r.running_why')) + '</div></div></div>')
      return
    }
    if (R.step === 'result' && st && st.result) {
      var r = st.result
      var body = r.ok
        ? '<div class="bk-row-title">' + h(tr('fbk.r.done')) + '</div>' +
          '<ol class="bk-steps">' +
          '<li>' + h(tr('fbk.r.next_login')) + ' <button class="btn-secondary btn-compact" data-bk="goto" data-page="accounts">' + h(tr('fbk.r.next_login_btn')) + '</button></li>' +
          (st.channelsHeld ? '<li>' + h(tr('fbk.r.next_release')) + '</li>' : '') +
          '<li>' + h(tr('fbk.r.next_depot')) + '</li>' +
          '</ol>'
        : '<div class="bk-row-title">' + h(tr('fbk.r.failed')) + '</div>' +
          '<div class="bk-row-desc">' + h(tr('fbk.r.code.' + (FAIL_CODES.indexOf(r.code) >= 0 ? r.code : 'failed'))) + '</div>' +
          (r.reason ? '<div class="bk-row-meta">' + h(tr('fbk.r.failed_detail', { reason: r.reason })) + '</div>' : '')
      rh(head + '<div class="bk-row ' + (r.ok ? 'bk-tone-ok' : 'bk-tone-bad') + '"><div class="bk-row-info">' + body + '</div>' +
        '<div class="bk-row-actions"><button class="btn-secondary btn-compact" data-bk="r-reset">' + h(tr('fbk.r.close')) + '</button></div></div>')
      return
    }
    if (R.step === 'preview' && R.preview) {
      var p = R.preview
      var compatBad = p.compat && !p.compat.ok
      rh(head + '<div class="bk-row"><div class="bk-row-info">' +
        '<div class="bk-row-title">' + h(tr('fbk.restore.preview')) + '</div>' +
        '<div class="bk-row-meta">' + h(tr('fbk.r.made', { when: fmtTime(Date.parse(p.createdAt)) || p.createdAt, version: p.appVersion })) + '</div>' +
        (compatBad ? '<div class="bk-error">' + h(tr('fbk.r.compat.' + p.compat.reason)) + '</div>' : '') +
        countRows(p) + catRows(p) + warnRows(p) +
        (p.needsLogin && p.needsLogin.length ? '<div class="bk-row-meta">' + h(tr('fbk.r.needs_login', { names: p.needsLogin.join(', ') })) + '</div>' : '') +
        '<div class="bk-row-meta">' + h(tr('fbk.r.logins_back')) + '</div>' +
        '<div class="bk-row-desc">' + h(p.freshInstall ? tr('fbk.r.fresh') : tr('fbk.restore.safety')) + '</div>' +
        '<div class="bk-row-desc">' + h(tr('fbk.channels.paused')) + '</div>' +
        confirmFields(p) +
        '</div><div class="bk-row-actions">' +
        '<button class="btn-primary" data-bk="r-start"' + (compatBad || (p.bytes && !p.bytes.enough) ? ' disabled' : '') + '>' + h(tr('fbk.r.start')) + '</button>' +
        '<button class="btn-secondary btn-compact" data-bk="r-cancel">' + h(tr('fbk.r.cancel')) + '</button>' +
        '</div></div>')
      return
    }
    // choose (+ key when needed)
    var keyField = '<label class="bk-field"><span>' + h(R.keyId ? tr('fbk.r.key_for', { id: R.keyId }) : tr('fbk.r.key')) + '</span>' +
      '<input class="input" id="bkRestoreKey" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"></label>' +
      '<div class="bk-row-meta">' + h(tr('fbk.r.key_hint')) + '</div>'
    rh(head + '<div class="bk-row"><div class="bk-row-info">' +
      '<div class="bk-row-desc">' + h(tr('fbk.r.why')) + '</div>' +
      '<label class="bk-field"><span>' + h(tr('fbk.r.upload')) + '</span><input type="file" accept=".mbk" data-bk="r-file" class="input"></label>' +
      '<div class="bk-row-meta">' + h(tr('fbk.r.upload_hint')) + '</div>' + keyField +
      (R.src ? '<div class="bk-row-meta">' + h(tr('fbk.r.selected', { name: R.src.name || R.src.fileName || '' })) + '</div>' : '') +
      '</div><div class="bk-row-actions">' +
      (R.src ? '<button class="btn-primary" data-bk="r-preview">' + h(tr('fbk.r.open')) + '</button>' : '') +
      (R.wizard ? '<button class="btn-secondary btn-compact" data-bk="r-wizard-back">' + h(tr('fbk.wizard.back')) + '</button>' : '') +
      '</div></div>')
  }

  function mountRestore(host) {
    R.host = host
    renderRestore()
    refreshRestoreStatus()
  }

  async function refreshRestoreStatus() {
    try {
      R.status = await api('GET', '/api/backup/restore/status')
      if (R.status.running) { R.step = 'running'; pollRestore() }
      // After the restart (or a new login) the page is new: an outcome the
      // owner has not closed yet is shown again, with its next steps.
      else if (!R.status.running && R.status.result && !R.status.result.seen && R.step === 'choose') R.step = 'result'
      renderRestore()
    } catch (e) { /* the page still works without it */ }
  }

  function toggleCat(el) {
    var id = el.getAttribute('data-cat')
    if (el.checked) delete R.exclude[id]; else R.exclude[id] = true
  }

  async function restoreUpload(el) {
    var f = el.files && el.files[0]
    if (!f) return
    showToast(tr('fbk.r.uploading', { name: f.name }))
    try {
      var res = await fetch('/api/backup/restore/upload?lang=' + L(), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f })
      var data = null
      try { data = await res.json() } catch (e) { data = null }
      if (!res.ok) throw new Error((data && data.message) || tr('fbk.err.generic'))
      R.src = { source: 'upload', uploadId: data.uploadId, fileName: f.name }
      renderRestore()
    } catch (e) { showToast(e.message, { type: 'error' }) }
  }

  async function openPreview() {
    var keyEl = document.getElementById('bkRestoreKey')
    var body = { source: R.src.source, name: R.src.name, uploadId: R.src.uploadId, key: keyEl && keyEl.value.trim() ? keyEl.value.trim() : undefined }
    try {
      R.preview = await api('POST', '/api/backup/restore/open', body)
      R.exclude = {}
      R.step = 'preview'
      R.keyId = null
    } catch (e) {
      if ((e.code === 'key_needed' || e.code === 'wrong_key') && e.data) {
        R.keyId = e.data.keyId || null
        if (e.data.uploadId) R.src.uploadId = e.data.uploadId
      }
      showToast(e.message, { type: 'error' })
    }
    renderRestore()
  }

  async function pollRestore() {
    if (R.polling) return
    R.polling = true
    for (;;) {
      await new Promise(function (r) { setTimeout(r, 3000) })
      try {
        var st = await api('GET', '/api/backup/restore/status')
        R.status = st
        // Not running any more: the outcome is in (the server answers
        // "never started" itself when the runner never took the plan).
        if (!st.running) break
      } catch (e) { /* the dashboard is restarting: keep asking */ }
    }
    R.polling = false
    R.step = R.status && R.status.result ? 'result' : 'choose'
    renderRestore()
    if (S.host) load()
  }

  async function restoreAction(act, el) {
    if (act === 'r-open') {
      R.src = { source: el.getAttribute('data-source'), name: el.getAttribute('data-name') }
      R.step = 'choose'
      R.keyId = null
      await openPreview()
      if (R.host && R.host.scrollIntoView) R.host.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (act === 'r-preview') {
      await openPreview()
    } else if (act === 'r-cancel') {
      if (R.preview) { try { await api('POST', '/api/backup/restore/cancel', { previewId: R.preview.previewId }) } catch (e) { /* gone anyway */ } }
      R.preview = null; R.src = null; R.step = 'choose'; renderRestore()
    } else if (act === 'r-start') {
      if (!window.confirm(tr('fbk.r.confirm'))) return
      var exclude = Object.keys(R.exclude)
      var body = { previewId: R.preview.previewId, exclude: exclude }
      var pw = document.getElementById('bkRestorePw')
      var user = document.getElementById('bkRestoreUser')
      if (pw) body.password = pw.value
      if (user) body.username = user.value.trim()
      showToast(tr('fbk.r.starting'))
      await api('POST', '/api/backup/restore/start', body)
      R.step = 'running'
      renderRestore()
      pollRestore()
    } else if (act === 'r-release') {
      if (!window.confirm(tr('fbk.r.release_confirm'))) return
      var r = await api('POST', '/api/backup/restore/release')
      showToast(r.kept && r.kept.length ? tr('fbk.r.released_kept', { n: r.kept.length }) : tr('fbk.r.released'), { type: r.kept && r.kept.length ? 'warn' : 'success' })
      await refreshRestoreStatus()
    } else if (act === 'r-reset') {
      if (R.status && R.status.result && !R.status.result.seen) {
        try { await api('POST', '/api/backup/restore/ack') } catch (e) { /* shown again next time, no harm */ }
        R.status.result.seen = true
      }
      R.step = 'choose'; R.preview = null; R.src = null
      if (R.wizard && W.el) { W.el.remove(); W.el = null; R.wizard = false; R.host = null; return }
      renderRestore()
    } else if (act === 'r-wizard-back') {
      renderWizardQuestion()
    }
  }

  // ---------------------------------------------------------------- wizard
  // A fresh install's first question. The server decides "fresh" (no login,
  // no cards, no memories, not asked yet); the choice is stored, so it is
  // asked once.

  var W = { el: null, resolve: null }

  function wizardShell(inner) {
    if (!W.el) {
      W.el = document.createElement('div')
      W.el.className = 'bk-wizard'
      W.el.addEventListener('click', onClick)
      W.el.addEventListener('change', onChange)
      document.body.appendChild(W.el)
    }
    W.el.innerHTML = '<div class="bk-wizard-card">' + inner + '</div>'
  }

  function renderWizardQuestion() {
    wizardShell('<h2>' + h(tr('fbk.wizard.q')) + '</h2>' +
      '<p>' + h(tr('fbk.wizard.why')) + '</p>' +
      '<p class="bk-row-meta">' + h(tr('fbk.wizard.login_note')) + '</p>' +
      '<div class="bk-row-actions" style="justify-content:flex-start">' +
      '<button class="btn-primary" data-bk="w-restore">' + h(tr('fbk.wizard.yes')) + '</button>' +
      '<button class="btn-secondary" data-bk="w-fresh">' + h(tr('fbk.wizard.no')) + '</button></div>')
  }

  async function wizardChoice(choice) {
    await api('POST', '/api/backup/onboarding', { choice: choice })
    if (choice === 'fresh') {
      if (W.el) { W.el.remove(); W.el = null }
      var done = W.resolve; W.resolve = null
      if (done) done(false)
      return
    }
    R.wizard = true
    wizardShell('<h2>' + h(tr('fbk.r.title')) + '</h2><div id="bkWizardRestore"></div>')
    mountRestore(document.getElementById('bkWizardRestore'))
    var d = W.resolve; W.resolve = null
    if (d) d(true)
  }

  /** Resolves true when the restore path was chosen (skip the normal onboarding). */
  window.maybeAskRestoreFirst = async function () {
    // A restore that is still running, or one whose outcome was not read yet,
    // comes first: after the restart or a new login the page starts over, and
    // the outcome holds the next steps (Claude logins, the paused channels).
    var st = null
    try { st = await api('GET', '/api/backup/restore/status') } catch (e) { st = null }
    if (st && (st.running || (st.result && !st.result.seen))) {
      R.wizard = true
      R.step = st.running ? 'running' : 'result'
      wizardShell('<h2>' + h(tr('fbk.r.title')) + '</h2><div id="bkWizardRestore"></div>')
      mountRestore(document.getElementById('bkWizardRestore'))
      return true
    }
    var r
    try { r = await api('GET', '/api/backup/onboarding') } catch (e) { return false }
    if (!r || !r.ask) return false
    return new Promise(function (resolve) {
      W.resolve = resolve
      renderWizardQuestion()
    })
  }

  window.renderBackupPanel = function (host) {
    if (!host) return
    if (S.host !== host) {
      S.host = host
      host.addEventListener('click', onClick)
      host.addEventListener('change', onChange)
    }
    render()
    load()
  }
})()
