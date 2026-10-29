/* Story Board – Frontend. Daten kommen über die REST-API aus Postgres. */
(() => {
  'use strict';

  const PRIO = {
    must:   { label: 'Must have',   rank: 0 },
    should: { label: 'Should have', rank: 1 },
    could:  { label: 'Could have',  rank: 2 },
    wont:   { label: "Won't have",  rank: 3 },
  };
  const SWATCHES = ['#5e6ad2', '#0f7ae5', '#26b5ce', '#4cb782', '#f2994a', '#eb5757', '#d55bb0', '#23252b'];
  const DEFAULT_SETTINGS = { appName: 'Story Board', prefix: 'US', color: '#5e6ad2', logo: '' };
  const PREFIX_RE = /^[A-Z][A-Z0-9]{1,7}$/;
  const LAST_APP_KEY = 'storyboard.lastApp';
  const lastApp = {
    get() { try { return localStorage.getItem(LAST_APP_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(LAST_APP_KEY, v); } catch { /* privater Modus */ } },
  };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = 'ic') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

  // ---------- Icons im Linear-Stil ----------
  // Priorität: Must = Warnquadrat, Should/Could = Signalbalken, Won't = gestrichelt
  function prioIcon(p) {
    if (p === 'must') {
      return `<svg class="prio" viewBox="0 0 14 14" aria-label="Must have"><rect x="1" y="1" width="12" height="12" rx="3" fill="var(--urgent)"/><path d="M7 3.8v4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="10.1" r=".95" fill="#fff"/></svg>`;
    }
    if (p === 'wont') {
      return `<svg class="prio" viewBox="0 0 14 14" aria-label="Won't have"><path d="M2 7h2M6 7h2M10 7h2" stroke="var(--text-3)" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    }
    const on = p === 'should' ? 3 : 2;
    const bars = [[1.5, 8.5, 4], [5.5, 5.5, 7], [9.5, 2, 10.5]]
      .map(([x, y, h], i) => `<rect x="${x}" y="${y}" width="3" height="${h}" rx="1" fill="${i < on ? 'var(--text-2)' : 'var(--border-strong)'}"/>`).join('');
    return `<svg class="prio" viewBox="0 0 14 14" aria-label="${PRIO[p].label}">${bars}</svg>`;
  }

  // Status: erste Spalte gestrichelt, letzte mit Haken, dazwischen Fortschrittskreise
  function statusIcon(ci, n = state.columns.length) {
    const s = 'class="status" viewBox="0 0 14 14"';
    if (ci === 0 && n > 1) {
      return `<svg ${s}><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="1.6 1.9"/></svg>`;
    }
    if (ci === n - 1 && n > 1) {
      return `<svg ${s}><circle cx="7" cy="7" r="6.25" fill="var(--primary)"/><path d="m4.4 7.2 1.8 1.8 3.5-3.8" fill="none" stroke="var(--primary-ink)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    const frac = n > 2 ? (ci - 1) / (n - 2) : 0; // 0 … <1
    const color = frac === 0 ? 'var(--text-3)' : frac >= 0.6 ? 'var(--green)' : 'var(--amber)';
    let pie = '';
    if (frac > 0) {
      const a = frac * 2 * Math.PI, r = 3;
      const x = 7 + r * Math.sin(a), y = 7 - r * Math.cos(a);
      pie = frac >= 0.999 ? `<circle cx="7" cy="7" r="${r}" fill="${color}"/>`
        : `<path d="M7 7V4A3 3 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z" fill="${color}"/>`;
    }
    return `<svg ${s}><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="1.5"/>${pie}</svg>`;
  }

  // Jedes Epic bekommt eine feste Farbe aus seinem Namen
  function epicColor(name) {
    if (!name) return 'var(--text-3)';
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 62% 55%)`;
  }
  const storyKey = (s) => (s.number ? `${state.settings.prefix || 'US'}-${s.number}` : '');

  let state = { app: null, settings: { ...DEFAULT_SETTINGS }, columns: [], stories: [] };
  let apps = [];            // alle Apps (für den Wechsler)
  let currentAppId = null;  // aktuell geöffnete App
  const appUrl = (path) => `api/apps/${encodeURIComponent(currentAppId)}/${path}`;

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== 'api/login') { showLock(); throw new Error('Nicht angemeldet'); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Fehler ${res.status}`), { status: res.status });
    return data;
  }

  // Fehler anzeigen und Board neu laden, damit die Ansicht wieder dem Server entspricht
  async function safely(fn) {
    try { await fn(); } catch (e) {
      if (e.message !== 'Nicht angemeldet') { toast(e.message); await reload().catch(() => {}); }
    }
  }

  async function loadApps() {
    apps = await api('GET', 'api/apps');
    return apps;
  }

  // Schlüssel aus ?app=… oder zuletzt genutzt → passende App, sonst die erste
  function pickApp(key) {
    const k = String(key || '').toLowerCase();
    return apps.find((a) => a.id === key || a.prefix.toLowerCase() === k) || apps[0];
  }

  async function reload() {
    try {
      state = await api('GET', appUrl('board'));
    } catch (e) {
      if (e.status !== 404) throw e;
      // App wurde inzwischen (z. B. auf einem anderen Gerät) gelöscht → erste App öffnen
      await loadApps();
      if (!apps.length || apps[0].id === currentAppId) throw e;
      currentAppId = apps[0].id;
      state = await api('GET', appUrl('board'));
      toast('Diese App gibt es nicht mehr – erste App geöffnet');
    }
    rememberApp();
    render();
  }

  // Aktuelle App in der Adresse (?app=kürzel) und als „zuletzt genutzt“ merken
  function rememberApp() {
    const key = state.settings.prefix.toLowerCase();
    lastApp.set(key);
    const u = new URL(location.href);
    if (u.searchParams.get('app') !== key) {
      u.searchParams.set('app', key);
      history.replaceState(null, '', u);
    }
  }

  async function switchApp(id) {
    closeMenus();
    if (id === currentAppId) return;
    currentAppId = id;
    ui.search = ''; ui.epic = ''; $('#search').value = '';
    activeCol = 0; $('#board').scrollLeft = 0;
    await safely(reload);
  }

  // ---------- Sperre ----------
  function showLock(configured = true) {
    $('#app').hidden = true;
    $('#lock').hidden = false;
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('#lockTitle').textContent = state.settings.appName;
    $('#lockHint').textContent = configured ? 'Bitte Passwort eingeben' : 'Es ist noch kein Passwort konfiguriert. Bitte APP_PASSWORD in Coolify setzen.';
    $('#lockPw').disabled = $('#lockBtn').disabled = !configured;
    $('#lockError').hidden = true;
    $('#lockPw').value = '';
    setTimeout(() => $('#lockPw').focus(), 50);
  }

  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#lockBtn').disabled = true;
    try {
      await api('POST', 'api/login', { password: $('#lockPw').value });
      await unlock();
    } catch (err) {
      $('#lockPw').value = '';
      $('#lockError').textContent = err.message;
      $('#lockError').hidden = false;
    } finally {
      $('#lockBtn').disabled = false;
    }
  });

  async function unlock() {
    await loadApps();
    const key = new URLSearchParams(location.search).get('app') || lastApp.get();
    currentAppId = pickApp(key)?.id;
    await reload();
    $('#lock').hidden = true;
    $('#app').hidden = false;
  }

  $('#lockNowBtn').addEventListener('click', async () => {
    await api('POST', 'api/logout').catch(() => {});
    showLock();
  });

  // ---------- Branding ----------
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111827' : '#ffffff';
  }
  function logoHTML(s) {
    return s.logo ? `<img src="${esc(s.logo)}" alt="">` : esc((s.appName || '?').trim().charAt(0).toUpperCase());
  }
  function applyBranding(s = state.settings) {
    const root = document.documentElement.style;
    root.setProperty('--primary', s.color);
    root.setProperty('--primary-ink', inkFor(s.color));
    document.title = s.appName;
    $('#appName').textContent = s.appName;
    $('#lockTitle').textContent = s.appName;
    for (const el of [$('#logo'), $('#lockLogo'), ...document.querySelectorAll('[data-logo]')]) el.innerHTML = logoHTML(s);
    markSwatches('#swatches', s.color);
  }
  function markSwatches(sel, color) {
    document.querySelectorAll(`${sel} .swatch`).forEach((sw) => sw.classList.toggle('active', sw.dataset.c.toLowerCase() === String(color).toLowerCase()));
  }
  const swatchHTML = () => SWATCHES.map((c) => `<button type="button" class="swatch" style="background:${c}" data-c="${c}" aria-label="Farbe ${c}"></button>`).join('');

  // Logo-Datei lesen und auf 256 px verkleinern, damit es schlank in der Datenbank liegt
  function readLogo(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const max = 256, r = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * r)); cv.height = Math.max(1, Math.round(img.height * r));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild konnte nicht gelesen werden.')); };
      img.src = url;
    });
  }

  // ---------- Rendering ----------
  let activeCol = 0;
  const ui = { search: '', sort: 'manual', epic: '' };
  const byPosition = (a, b) => a.position - b.position;

  function visibleStories(colId) {
    const q = ui.search.toLowerCase();
    let list = state.stories.filter((s) => s.column === colId &&
      (!ui.epic || s.epic === ui.epic) &&
      (!q || [s.title, s.role, s.want, s.benefit, s.epic, ...(s.criteria || [])].join(' ').toLowerCase().includes(q)));
    const by = {
      manual: byPosition,
      priority: (a, b) => PRIO[a.priority].rank - PRIO[b.priority].rank || (b.points || 0) - (a.points || 0),
      points: (a, b) => (b.points || 0) - (a.points || 0),
      epic: (a, b) => (a.epic || '~').localeCompare(b.epic || '~', 'de') || PRIO[a.priority].rank - PRIO[b.priority].rank,
      newest: (a, b) => b.created - a.created,
      title: (a, b) => a.title.localeCompare(b.title, 'de'),
    }[ui.sort];
    return [...list].sort(by);
  }

  function cardHTML(s, ci, idx, len) {
    const sentence = (s.role || s.want || s.benefit)
      ? `<p class="sentence">Als ${esc(s.role || '…')} möchte ich ${esc(s.want || '…')}${s.benefit ? `, damit ${esc(s.benefit)}` : ''}.</p>` : '';
    const ac = (s.criteria || []).length;
    const manual = ui.sort === 'manual';
    return `<article class="card" draggable="true" data-id="${esc(s.id)}">
      <div class="card-top"><span class="card-id">${storyKey(s)}</span></div>
      <h4>${esc(s.title)}</h4>${sentence}
      <div class="meta">
        <span class="badge icon-only" title="${PRIO[s.priority]?.label || ''}">${prioIcon(s.priority)}</span>
        ${s.epic ? `<span class="badge"><span class="dot" style="background:${epicColor(s.epic)}"></span>${esc(s.epic)}</span>` : ''}
        ${ac ? `<span class="badge" title="Akzeptanzkriterien">${icon('check')}${ac}</span>` : ''}
        ${s.points ? `<span class="badge pts-badge" title="Story Points">${s.points}</span>` : ''}
      </div>
      <div class="card-move">
        ${manual ? `<button data-move="up" ${idx === 0 ? 'disabled' : ''} aria-label="Nach oben" title="Nach oben">${icon('chev-u')}</button>
        <button data-move="down" ${idx === len - 1 ? 'disabled' : ''} aria-label="Nach unten" title="Nach unten">${icon('chev-d')}</button>` : ''}
        <button data-move="left" ${ci === 0 ? 'disabled' : ''} aria-label="Spalte zurück" title="Spalte zurück">${icon('chev-l')}</button>
        <button data-move="right" ${ci === state.columns.length - 1 ? 'disabled' : ''} aria-label="Spalte vor" title="Spalte vor">${icon('chev-r')}</button>
      </div>
    </article>`;
  }

  function render() {
    applyBranding();
    activeCol = Math.max(0, Math.min(activeCol, state.columns.length - 1));
    const board = $('#board');
    const scrollPos = board.scrollLeft;

    board.innerHTML = state.columns.map((c, ci) => {
      const list = visibleStories(c.id);
      const pts = list.reduce((a, s) => a + (+s.points || 0), 0);
      return `<section class="column" data-col="${esc(c.id)}">
        <div class="col-head">
          ${statusIcon(ci)}<span class="name">${esc(c.name)}</span><span class="count">${list.length}</span>
          <span class="end">${pts ? `<span class="pts">${pts} SP</span>` : ''}
            <button class="icon-btn" data-export-col="${esc(c.id)}" aria-label="${esc(c.name)} als Markdown exportieren" title="Spalte als Markdown exportieren">${icon('download')}</button>
            <button class="icon-btn" data-add="${esc(c.id)}" aria-label="Story in ${esc(c.name)} anlegen" title="Story anlegen">${icon('plus')}</button></span>
        </div>
        ${list.length ? list.map((s, i) => cardHTML(s, ci, i, list.length)).join('') : '<div class="empty">Keine Stories</div>'}
      </section>`;
    }).join('');
    board.scrollLeft = scrollPos;

    $('#tabs').innerHTML = state.columns.map((c, i) =>
      `<button class="tab ${i === activeCol ? 'active' : ''}" data-i="${i}">${statusIcon(i)}${esc(c.name)}<span class="count">${visibleStories(c.id).length}</span></button>`).join('');

    const epics = [...new Set(state.stories.map((s) => s.epic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    if (ui.epic && !epics.includes(ui.epic)) ui.epic = '';
    $('#epicFilter').innerHTML = '<option value="">Alle Epics</option>' + epics.map((e) => `<option ${e === ui.epic ? 'selected' : ''}>${esc(e)}</option>`).join('');
    $('#epicDot').style.background = epicColor(ui.epic);
    $('#epicList').innerHTML = epics.map((e) => `<option value="${esc(e)}">`).join('');

    const total = state.stories.length;
    const totalPts = state.stories.reduce((a, s) => a + (+s.points || 0), 0);
    $('#stats').textContent = `${total} ${total === 1 ? 'Story' : 'Stories'} · ${totalPts} SP`;
  }

  // Tabs ↔ horizontales Scrollen (Mobil)
  $('#tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab'); if (!t) return;
    activeCol = +t.dataset.i;
    const col = $('#board').children[activeCol];
    $('#board').scrollTo({ left: col.offsetLeft - 16, behavior: 'smooth' });
    markTab();
  });
  let scrollT;
  $('#board').addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const b = $('#board'); const w = b.children[0]?.offsetWidth || 1;
      activeCol = Math.round(b.scrollLeft / (w + 12));
      markTab();
    }, 80);
  });
  function markTab() {
    [...$('#tabs').children].forEach((t, i) => {
      t.classList.toggle('active', i === activeCol);
      if (i === activeCol) t.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  }

  $('#search').addEventListener('input', (e) => { ui.search = e.target.value; render(); });
  $('#sort').addEventListener('change', (e) => { ui.sort = e.target.value; render(); });
  $('#epicFilter').addEventListener('change', (e) => { ui.epic = e.target.value; render(); });

  // ---------- Verschieben ----------
  // Sofort lokal anzeigen, dann speichern (bei Fehler wird neu geladen)
  function moveStory(id, toColId, beforeId = null) {
    const s = state.stories.find((x) => x.id === id);
    const target = state.stories.filter((x) => x.column === toColId && x.id !== id).sort(byPosition);
    const at = beforeId ? target.findIndex((x) => x.id === beforeId) : -1;
    target.splice(at < 0 ? target.length : at, 0, s);
    s.column = toColId;
    target.forEach((x, i) => { x.position = i; });
    render();
    return safely(() => api('POST', `api/stories/${encodeURIComponent(id)}/move`, { column: toColId, before: beforeId }));
  }

  $('#board').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) return openStory(null, add.dataset.add);
    const exp = e.target.closest('[data-export-col]');
    if (exp) return openExportMenu(exp, exp.dataset.exportCol);
    const btn = e.target.closest('[data-move]');
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (!btn) return openStory(id);
    e.stopPropagation();
    const s = state.stories.find((x) => x.id === id);
    const ci = state.columns.findIndex((c) => c.id === s.column);
    const dir = btn.dataset.move;
    if (dir === 'left' || dir === 'right') {
      const target = state.columns[ci + (dir === 'left' ? -1 : 1)];
      if (target) moveStory(id, target.id);
    } else {
      // Reihenfolge bezieht sich auf alle Stories der Spalte, nicht nur die gefilterten
      const list = state.stories.filter((x) => x.column === s.column).sort(byPosition);
      const idx = list.findIndex((x) => x.id === id);
      if (dir === 'up' && idx > 0) moveStory(id, s.column, list[idx - 1].id);
      if (dir === 'down' && idx < list.length - 1) moveStory(id, s.column, list[idx + 2]?.id || null);
    }
  });

  // Drag & Drop (Desktop)
  let dragId = null;
  $('#board').addEventListener('dragstart', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    dragId = c.dataset.id; c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  $('#board').addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.dragging, .drop').forEach((el) => el.classList.remove('dragging', 'drop'));
  });
  $('#board').addEventListener('dragover', (e) => {
    const col = e.target.closest('.column'); if (!col || !dragId) return;
    e.preventDefault();
    document.querySelectorAll('.column.drop').forEach((el) => el !== col && el.classList.remove('drop'));
    col.classList.add('drop');
  });
  $('#board').addEventListener('drop', (e) => {
    const col = e.target.closest('.column'); if (!col || !dragId) return;
    e.preventDefault();
    let before = null;
    if (ui.sort === 'manual') {
      const cards = [...col.querySelectorAll('.card:not(.dragging)')];
      before = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2)?.dataset.id || null;
    }
    moveStory(dragId, col.dataset.col, before);
  });

  // ---------- Story-Dialog ----------
  const storyDlg = $('#storyDlg');
  let editingId = null;

  function openStory(id = null, columnId = null) {
    editingId = id;
    const f = $('#storyForm');
    const s = id ? state.stories.find((x) => x.id === id)
      : { title: '', role: '', want: '', benefit: '', criteria: [], priority: 'could', points: '', epic: ui.epic, column: columnId || state.columns[activeCol]?.id };
    $('#storyDlgTitle').textContent = id ? `${storyKey(s) || 'Story'} · bearbeiten` : 'Neue Story';
    $('#deleteStoryBtn').hidden = !id;
    $('#columnSelect').innerHTML = state.columns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    for (const k of ['title', 'role', 'want', 'benefit', 'priority', 'epic', 'column']) f.elements[k].value = s[k] ?? '';
    f.elements.points.value = s.points ? String(s.points) : '';
    f.elements.criteria.value = (s.criteria || []).join('\n');
    updatePropIcons();
    storyDlg.showModal();
    if (!id) f.elements.title.focus();
  }
  function updatePropIcons() {
    const f = $('#storyForm').elements;
    $('#propPrioIc').innerHTML = prioIcon(f.priority.value);
    $('#propColIc').innerHTML = statusIcon(Math.max(0, state.columns.findIndex((c) => c.id === f.column.value)));
    $('#propEpicDot').style.background = epicColor(f.epic.value.trim());
  }
  $('#storyForm').addEventListener('input', updatePropIcons);
  $('#addBtn').addEventListener('click', () => openStory());
  $('#addBtnTop').addEventListener('click', () => openStory(null, state.columns[0]?.id));

  storyDlg.addEventListener('close', () => {
    if (storyDlg.returnValue !== 'save') return;
    const f = $('#storyForm').elements;
    const data = {
      title: f.title.value.trim(), role: f.role.value.trim(), want: f.want.value.trim(), benefit: f.benefit.value.trim(),
      criteria: f.criteria.value.split('\n').map((l) => l.trim()).filter(Boolean),
      priority: f.priority.value, points: f.points.value ? +f.points.value : '', epic: f.epic.value.trim(),
    };
    const column = f.column.value;
    if (!data.title) return;
    const id = editingId;
    safely(async () => {
      if (id) {
        const updated = await api('PATCH', `api/stories/${encodeURIComponent(id)}`, data);
        const s = state.stories.find((x) => x.id === id);
        const oldCol = s.column;
        Object.assign(s, updated, { column: oldCol });
        if (oldCol !== column) await moveStory(id, column);
        else render();
      } else {
        const created = await api('POST', 'api/stories', { ...data, column });
        state.stories.push(created);
        render();
        toast('Story angelegt');
      }
    });
  });

  $('#deleteStoryBtn').addEventListener('click', () => {
    if (!confirm('Diese Story wirklich löschen?')) return;
    const id = editingId;
    storyDlg.close('deleted');
    state.stories = state.stories.filter((s) => s.id !== id);
    render();
    safely(async () => { await api('DELETE', `api/stories/${encodeURIComponent(id)}`); toast('Story gelöscht'); });
  });

  // ---------- Einstellungen ----------
  const setDlg = $('#settingsDlg');
  let draft = null; // Vorschau für Name/Kürzel/Farbe/Logo

  $('#swatches').innerHTML = swatchHTML();

  function previewDraft() {
    applyBranding(draft);
    $('#logoPreview').innerHTML = logoHTML(draft);
    $('#prefixExample').textContent = `${draft.prefix || '…'}-12`;
  }

  function showPane(name) {
    document.querySelectorAll('#settingsDlg .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.pane === name);
      b.setAttribute('aria-selected', String(b.dataset.pane === name));
    });
    document.querySelectorAll('#settingsDlg [data-pane-body]').forEach((el) => { el.hidden = el.dataset.paneBody !== name; });
  }
  $('#settingsDlg .seg').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) showPane(b.dataset.pane); });

  function openSettings() {
    closeMenus();
    draft = { ...state.settings };
    const f = $('#settingsForm').elements;
    f.appName.value = draft.appName;
    f.prefix.value = draft.prefix;
    f.color.value = draft.color;
    f.columns.value = state.columns.map((c) => c.name).join('\n');
    f.newPw.value = '';
    $('#exportBtn').href = appUrl('export');
    resetDeleteConfirm();
    showPane('app');
    previewDraft();
    setDlg.showModal();
  }
  $('#settingsBtn').addEventListener('click', openSettings);

  const sf = $('#settingsForm').elements;
  sf.color.addEventListener('input', (e) => { draft.color = e.target.value; previewDraft(); });
  sf.appName.addEventListener('input', (e) => { draft.appName = e.target.value.trim() || 'Story Board'; previewDraft(); });
  sf.prefix.addEventListener('input', (e) => {
    const v = cleanPrefixInput(e.target.value);
    if (v !== e.target.value) e.target.value = v;
    draft.prefix = v; previewDraft();
  });
  $('#swatches').addEventListener('click', (e) => {
    const c = e.target.dataset.c; if (!c) return;
    draft.color = c; sf.color.value = c; previewDraft();
  });

  $('#logoInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try { draft.logo = await readLogo(file); previewDraft(); } catch (err) { toast(err.message); }
  });
  $('#logoReset').addEventListener('click', () => { draft.logo = ''; previewDraft(); });

  // Spaltennamen aus dem Textfeld den bestehenden IDs zuordnen (gleicher Name oder gleiche Position = Umbenennung)
  function columnPayload(text) {
    const names = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const old = state.columns;
    const used = new Set();
    return names.map((name, i) => {
      let match = old.find((c) => c.name === name && !used.has(c.id));
      if (!match && old[i] && !used.has(old[i].id) && !names.includes(old[i].name)) match = old[i];
      if (match) used.add(match.id);
      return { id: match?.id, name };
    });
  }

  // Vor dem Schließen prüfen (sonst wäre die Eingabe weg)
  $('#settingsForm').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    const f = $('#settingsForm').elements;
    let msg = '';
    if (!f.appName.value.trim()) msg = 'Bitte einen Namen für die App eingeben.';
    else if (!PREFIX_RE.test(f.prefix.value)) msg = 'Kürzel: 2–8 Zeichen, A–Z und 0–9, beginnend mit einem Buchstaben.';
    else if (apps.some((a) => a.id !== currentAppId && a.prefix.toUpperCase() === f.prefix.value)) msg = `Das Kürzel ${f.prefix.value} nutzt schon eine andere App.`;
    if (msg) { e.preventDefault(); showPane('app'); toast(msg); f[msg.startsWith('Bitte') ? 'appName' : 'prefix'].focus(); }
  });

  setDlg.addEventListener('close', () => {
    if (setDlg.returnValue !== 'save') { applyBranding(); return; }
    const f = $('#settingsForm').elements;
    const columns = columnPayload(f.columns.value);
    const columnsChanged = JSON.stringify(columns) !== JSON.stringify(state.columns.map(({ id, name }) => ({ id, name })));
    const newPw = f.newPw.value;
    const patch = { name: f.appName.value.trim(), prefix: f.prefix.value, color: draft.color, logo: draft.logo };
    const old = state.settings;
    const appChanged = patch.name !== old.appName || patch.prefix !== old.prefix || patch.color !== old.color || patch.logo !== old.logo;
    state.settings = { appName: patch.name, prefix: patch.prefix, color: patch.color, logo: patch.logo };
    render();
    safely(async () => {
      if (appChanged) {
        const a = await api('PATCH', `api/apps/${encodeURIComponent(currentAppId)}`, patch);
        state.app = a;
        state.settings = { appName: a.name, prefix: a.prefix, color: a.color, logo: a.logo };
        apps = apps.map((x) => (x.id === a.id ? a : x));
        rememberApp();
      }
      if (columns.length && columnsChanged) state = await api('PUT', appUrl('columns'), columns);
      if (newPw) {
        if (newPw.length < 4) toast('Passwort zu kurz – nicht geändert.');
        else { await api('PUT', 'api/password', { password: newPw }); toast('Passwort geändert'); }
      }
      render();
    });
  });

  // App löschen: Name eintippen zur Bestätigung; die letzte App bleibt
  function resetDeleteConfirm() {
    const last = apps.length <= 1;
    $('#deleteAppStart').disabled = last;
    $('#deleteAppHint').textContent = last
      ? 'Die letzte App kann nicht gelöscht werden.'
      : 'Löscht diese App mit allen Spalten und Stories endgültig.';
    $('#deleteAppConfirm').hidden = true;
    $('#deleteAppInput').value = '';
    $('#deleteAppBtn').disabled = true;
  }
  $('#deleteAppStart').addEventListener('click', () => {
    $('#deleteAppName').textContent = `„${state.settings.appName}“ · ${state.stories.length} ${state.stories.length === 1 ? 'Story' : 'Stories'} werden gelöscht`;
    $('#deleteAppConfirm').hidden = false;
    $('#deleteAppInput').focus();
  });
  $('#deleteAppInput').addEventListener('input', (e) => {
    $('#deleteAppBtn').disabled = e.target.value.trim() !== state.settings.appName;
  });
  $('#deleteAppInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!$('#deleteAppBtn').disabled) $('#deleteAppBtn').click(); } });
  $('#deleteAppBtn').addEventListener('click', () => {
    const name = state.settings.appName;
    const id = currentAppId;
    setDlg.close('deleted');
    safely(async () => {
      await api('DELETE', `api/apps/${encodeURIComponent(id)}`);
      await loadApps();
      currentAppId = null;
      await switchApp(apps[0].id);
      toast(`App „${name}“ gelöscht`);
    });
  });

  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast('Ungültige Datei'); }
    if (!confirm(`Spalten und Stories von „${state.settings.appName}“ durch den Import ersetzen?`)) return;
    safely(async () => {
      state = await api('POST', appUrl('import'), data);
      await loadApps();
      setDlg.close('imported');
      rememberApp();
      render();
      toast('Import erfolgreich');
    });
  });

  // ---------- Apps: Wechsler und neue App ----------
  const appMenu = $('#appMenu');

  function renderAppList() {
    $('#appList').innerHTML = apps.map((a) => {
      const cur = a.id === currentAppId;
      return `<button type="button" role="menuitemradio" aria-checked="${cur}" class="app-item ${cur ? 'current' : ''}" data-app="${esc(a.id)}">
        <span class="logo" style="background:${esc(a.color)};color:${inkFor(a.color)}">${logoHTML({ appName: a.name, logo: a.logo })}</span>
        <span class="app-item-name">${esc(a.name)}</span>
        <span class="app-item-meta">${esc(a.prefix)} · ${a.storyCount}</span>
        ${icon('check', 'ic check')}
      </button>`;
    }).join('');
  }

  function placeMenu(el, anchor, align = 'right') {
    el.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const want = align === 'left' ? r.left : r.right - w;
    const left = Math.max(8, Math.min(want, window.innerWidth - w - 8));
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }

  function openAppMenu() {
    if (!appMenu.hidden) return closeMenus();
    closeMenus();
    renderAppList();
    placeMenu(appMenu, $('#appSwitch'), 'left');
    $('#appSwitch').classList.add('open');
    $('#appSwitch').setAttribute('aria-expanded', 'true');
    (appMenu.querySelector('.app-item.current') || appMenu.querySelector('button')).focus({ preventScroll: true });
    // Story-Zahlen frisch holen, ohne das Öffnen zu verzögern
    loadApps().then(() => { if (!appMenu.hidden) renderAppList(); }).catch(() => {});
  }
  function closeAppMenu() {
    appMenu.hidden = true;
    $('#appSwitch').classList.remove('open');
    $('#appSwitch').setAttribute('aria-expanded', 'false');
  }

  $('#appSwitch').addEventListener('click', (e) => { e.stopPropagation(); openAppMenu(); });
  appMenu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-app]');
    if (item) return switchApp(item.dataset.app);
  });
  $('#newAppBtn').addEventListener('click', () => { closeMenus(); openNewApp(); });
  $('#appSettingsBtn').addEventListener('click', openSettings);
  // Pfeiltasten im Menü
  appMenu.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const items = [...appMenu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  // Neue App
  const appDlg = $('#appDlg');
  const af = $('#appForm').elements;
  let newApp = null;
  $('#newAppSwatches').innerHTML = swatchHTML();

  function cleanPrefixInput(v) {
    return String(v).toUpperCase().replace(/[ÄÖÜ]/g, (c) => ({ Ä: 'A', Ö: 'O', Ü: 'U' }[c])).replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 8);
  }
  // Kürzel-Vorschlag aus dem Namen: Initialen bei mehreren Wörtern, sonst die ersten Buchstaben; eindeutig gemacht
  function suggestPrefix(name) {
    const words = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    let p = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] || '').slice(0, 4);
    p = cleanPrefixInput(p);
    if (p.length === 1) p += (words[0] || 'X').slice(1, 2) || 'X';
    if (!p) return '';
    const taken = new Set(apps.map((a) => a.prefix.toUpperCase()));
    if (!taken.has(p)) return p;
    for (let n = 2; n < 100; n++) { const c = `${p.slice(0, 8 - String(n).length)}${n}`; if (!taken.has(c)) return c; }
    return p;
  }

  function previewNewApp() {
    const logo = $('#newAppLogo');
    logo.style.background = newApp.color;
    logo.style.color = inkFor(newApp.color);
    logo.innerHTML = logoHTML({ appName: af.name.value || 'N', logo: newApp.logo });
    markSwatches('#newAppSwatches', newApp.color);
    const p = af.prefix.value || 'APP';
    $('#newPrefixExample').textContent = `${p}-1`;
    $('#newPrefixExample2').textContent = `${p}-2`;
    $('#newAppLogoReset').hidden = !newApp.logo;
  }

  function openNewApp() {
    const used = new Set(apps.map((a) => a.color.toLowerCase()));
    newApp = { color: SWATCHES.find((c) => !used.has(c)) || SWATCHES[apps.length % SWATCHES.length], logo: '', prefixTouched: false };
    $('#appForm').reset();
    af.color.value = newApp.color;
    $('#appFormError').hidden = true;
    previewNewApp();
    appDlg.showModal();
    af.name.focus();
  }

  af.name.addEventListener('input', () => {
    if (!newApp.prefixTouched) af.prefix.value = suggestPrefix(af.name.value);
    previewNewApp();
  });
  af.prefix.addEventListener('input', (e) => {
    newApp.prefixTouched = e.target.value !== '';
    const v = cleanPrefixInput(e.target.value);
    if (v !== e.target.value) e.target.value = v;
    previewNewApp();
  });
  af.color.addEventListener('input', (e) => { newApp.color = e.target.value; previewNewApp(); });
  $('#newAppSwatches').addEventListener('click', (e) => {
    const c = e.target.dataset.c; if (!c) return;
    newApp.color = c; af.color.value = c; previewNewApp();
  });
  $('#newAppLogoInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try { newApp.logo = await readLogo(file); previewNewApp(); } catch (err) { toast(err.message); }
  });
  $('#newAppLogoReset').addEventListener('click', () => { newApp.logo = ''; previewNewApp(); });

  $('#appForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'create') return;
    e.preventDefault();
    const err = (m) => { $('#appFormError').textContent = m; $('#appFormError').hidden = false; };
    const name = af.name.value.trim();
    const prefix = af.prefix.value;
    if (!name) return err('Bitte einen Namen eingeben.');
    if (!PREFIX_RE.test(prefix)) return err('Kürzel: 2–8 Zeichen, A–Z und 0–9, beginnend mit einem Buchstaben.');
    $('#createAppBtn').disabled = true;
    try {
      const created = await api('POST', 'api/apps', { name, prefix, color: newApp.color, logo: newApp.logo });
      appDlg.close('created');
      await loadApps();
      await switchApp(created.id);
      toast(`App „${created.name}“ angelegt`);
    } catch (ex) {
      if (ex.message !== 'Nicht angemeldet') err(ex.message);
    } finally {
      $('#createAppBtn').disabled = false;
    }
  });

  // ---------- Markdown-Export ----------
  // Exportiert immer alle Stories (Suche/Epic-Filter werden ignoriert) in der aktuell gewählten Sortierung.
  function sortedColumnStories(colId) {
    const saved = { search: ui.search, epic: ui.epic };
    ui.search = ''; ui.epic = '';
    const list = visibleStories(colId);
    Object.assign(ui, saved);
    return list;
  }

  const mdText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const pointsSum = (list) => list.reduce((a, s) => a + (+s.points || 0), 0);
  const countLabel = (n) => `${n} ${n === 1 ? 'Story' : 'Stories'}`;

  function storyMarkdown(s, colName, level) {
    const h = '#'.repeat(level);
    const key = storyKey(s);
    const lines = [`${h} ${key ? `${key} · ` : ''}${mdText(s.title)}`, ''];
    if (s.role || s.want || s.benefit) {
      lines.push(`**Als** ${mdText(s.role) || '…'} **möchte ich** ${mdText(s.want) || '…'}${s.benefit ? `, **damit** ${mdText(s.benefit)}` : ''}.`, '');
    }
    lines.push(`- **Status:** ${mdText(colName)}`);
    lines.push(`- **Priorität:** ${PRIO[s.priority]?.label || s.priority}`);
    lines.push(`- **Story Points:** ${s.points || '–'}`);
    if (s.epic) lines.push(`- **Epic:** ${mdText(s.epic)}`);
    const ac = s.criteria || [];
    if (ac.length) {
      lines.push('', '**Akzeptanzkriterien**', '', ...ac.map((c) => `- [ ] ${mdText(c)}`));
    }
    return lines.join('\n');
  }

  function buildMarkdown(colId = null) {
    const name = mdText(state.settings.appName);
    const date = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const sortLabel = $('#sort').selectedOptions[0]?.textContent || '';
    const cols = colId ? state.columns.filter((c) => c.id === colId) : state.columns;
    const groups = cols.map((c) => ({ col: c, list: sortedColumnStories(c.id) }));
    const all = groups.flatMap((g) => g.list);
    const out = [];

    if (colId) {
      const { col, list } = groups[0];
      out.push(`# ${name} – ${mdText(col.name)}`, '',
        `_Export vom ${date} · ${countLabel(list.length)} · ${pointsSum(list)} SP · Sortierung: ${sortLabel}_`, '');
      if (!list.length) out.push('_Keine Stories in dieser Spalte._');
      list.forEach((s) => out.push(storyMarkdown(s, col.name, 2), '', '---', ''));
    } else {
      out.push(`# ${name} – User Stories`, '',
        `_Export vom ${date} · ${countLabel(all.length)} · ${pointsSum(all)} SP · Sortierung: ${sortLabel}_`, '',
        '| Spalte | Stories | Story Points |', '|---|---:|---:|',
        ...groups.map((g) => `| ${mdText(g.col.name).replace(/\|/g, '\\|')} | ${g.list.length} | ${pointsSum(g.list)} |`), '');
      for (const { col, list } of groups) {
        out.push(`## ${mdText(col.name)} (${countLabel(list.length)} · ${pointsSum(list)} SP)`, '');
        if (!list.length) out.push('_Keine Stories._', '');
        list.forEach((s) => out.push(storyMarkdown(s, col.name, 3), ''));
      }
    }
    while (out.length && ['', '---'].includes(out[out.length - 1])) out.pop();
    return out.join('\n') + '\n';
  }

  const slug = (s) => String(s).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';

  function downloadMarkdown(colId) {
    const col = state.columns.find((c) => c.id === colId);
    const today = new Date().toISOString().slice(0, 10);
    const file = `${slug(state.settings.appName)}-${col ? slug(col.name) : 'user-stories'}-${today}.md`;
    const blob = new Blob([buildMarkdown(colId)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(`${file} heruntergeladen`);
  }

  async function copyMarkdown(colId) {
    const text = buildMarkdown(colId);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* z. B. ohne https */ }
    if (!ok) { // Fallback, funktioniert auch über http
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? 'Markdown kopiert – jetzt z. B. in Claude einfügen' : 'Kopieren nicht möglich – bitte herunterladen');
  }

  const menu = $('#exportMenu');
  let menuCol = null, menuAnchor = null;

  function openExportMenu(anchor, colId = null) {
    if (!menu.hidden && menuAnchor === anchor) return closeExportMenu();
    closeMenus();
    menuCol = colId; menuAnchor = anchor;
    const col = state.columns.find((c) => c.id === colId);
    const n = col ? state.stories.filter((s) => s.column === colId).length : state.stories.length;
    $('#exportMenuTitle').textContent = `${col ? col.name : 'Alle Spalten'} · ${countLabel(n)}`;
    anchor.classList.add('open');
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    menu.querySelector('button').focus({ preventScroll: true });
  }
  function closeExportMenu() {
    menu.hidden = true;
    menuAnchor?.classList.remove('open');
    menuAnchor = null;
  }

  $('#exportAllBtn').addEventListener('click', (e) => { e.stopPropagation(); openExportMenu(e.currentTarget); });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]'); if (!b) return;
    const colId = menuCol;
    closeExportMenu();
    if (b.dataset.export === 'download') downloadMarkdown(colId); else copyMarkdown(colId);
  });
  function closeMenus() { closeExportMenu(); closeAppMenu(); }
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-export-col], #exportAllBtn')) closeExportMenu();
    if (!appMenu.hidden && !appMenu.contains(e.target) && !e.target.closest('#appSwitch')) closeAppMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const wasOpen = !appMenu.hidden;
    closeMenus();
    if (wasOpen) $('#appSwitch').focus();
  });
  window.addEventListener('resize', closeMenus);
  $('#board').addEventListener('scroll', closeExportMenu, { passive: true });

  // ---------- Toast ----------
  let toastT;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
  }

  // Beim Zurückkehren in die App (z. B. Handy) frische Daten holen
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('#app').hidden && !document.querySelector('dialog[open]')) {
      reload().catch(() => {});
    }
  });

  // ---------- Start ----------
  (async () => {
    try {
      const key = new URLSearchParams(location.search).get('app') || lastApp.get();
      const s = await api('GET', `api/session${key ? `?app=${encodeURIComponent(key)}` : ''}`);
      state.settings = { ...DEFAULT_SETTINGS, ...s.branding };
      applyBranding();
      if (s.authed) await unlock();
      else showLock(s.configured);
    } catch {
      showLock();
      $('#lockError').textContent = 'Server nicht erreichbar.';
      $('#lockError').hidden = false;
    }
  })();
})();
