/* Story Board – Frontend. Daten kommen über die REST-API aus Postgres. */
(() => {
  'use strict';

  const PRIO = {
    must:   { label: 'Must',   rank: 0, color: 'var(--must)' },
    should: { label: 'Should', rank: 1, color: 'var(--should)' },
    could:  { label: 'Could',  rank: 2, color: 'var(--could)' },
    wont:   { label: "Won't",  rank: 3, color: 'var(--wont)' },
  };
  const SWATCHES = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#111827'];
  const DEFAULT_SETTINGS = { appName: 'Story Board', color: '#4f46e5', logo: '' };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = { settings: { ...DEFAULT_SETTINGS }, columns: [], stories: [] };

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
    if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
    return data;
  }

  // Fehler anzeigen und Board neu laden, damit die Ansicht wieder dem Server entspricht
  async function safely(fn) {
    try { await fn(); } catch (e) {
      if (e.message !== 'Nicht angemeldet') { toast(e.message); await reload().catch(() => {}); }
    }
  }

  async function reload() {
    state = await api('GET', 'api/board');
    render();
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
    $('meta[name=theme-color]').content = s.color;
    document.title = s.appName;
    $('#appName').textContent = s.appName;
    $('#lockTitle').textContent = s.appName;
    for (const el of [$('#logo'), $('#lockLogo')]) el.innerHTML = logoHTML(s);
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
    const p = PRIO[s.priority] || PRIO.could;
    const sentence = (s.role || s.want || s.benefit)
      ? `<p class="sentence">Als <b>${esc(s.role || '…')}</b> möchte ich <b>${esc(s.want || '…')}</b>${s.benefit ? `, damit ${esc(s.benefit)}` : ''}.</p>` : '';
    const ac = (s.criteria || []).length;
    const manual = ui.sort === 'manual';
    return `<article class="card" draggable="true" data-id="${esc(s.id)}" style="--prio:${p.color}">
      <h4>${esc(s.title)}</h4>${sentence}
      <div class="meta">
        <span class="chip prio">${p.label}</span>
        ${s.epic ? `<span class="chip epic">${esc(s.epic)}</span>` : ''}
        ${ac ? `<span class="chip ac">✓ ${ac} AK</span>` : ''}
        ${s.points ? `<span class="chip pts">${s.points} SP</span>` : ''}
      </div>
      <div class="card-move">
        ${manual ? `<button data-move="up" ${idx === 0 ? 'disabled' : ''} aria-label="Nach oben">↑</button>
        <button data-move="down" ${idx === len - 1 ? 'disabled' : ''} aria-label="Nach unten">↓</button>` : ''}
        <button data-move="left" ${ci === 0 ? 'disabled' : ''} aria-label="Spalte zurück">←</button>
        <button data-move="right" ${ci === state.columns.length - 1 ? 'disabled' : ''} aria-label="Spalte vor">→</button>
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
        <div class="col-head"><span>${esc(c.name)} ${pts ? `<span class="col-points">· ${pts} SP</span>` : ''}</span><span class="count">${list.length}</span></div>
        ${list.length ? list.map((s, i) => cardHTML(s, ci, i, list.length)).join('') : '<div class="empty">Keine Stories</div>'}
      </section>`;
    }).join('');
    board.scrollLeft = scrollPos;

    $('#tabs').innerHTML = state.columns.map((c, i) =>
      `<button class="tab ${i === activeCol ? 'active' : ''}" data-i="${i}">${esc(c.name)}<span class="count">${visibleStories(c.id).length}</span></button>`).join('');

    const epics = [...new Set(state.stories.map((s) => s.epic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    $('#epicFilter').innerHTML = '<option value="">Alle Epics</option>' + epics.map((e) => `<option ${e === ui.epic ? 'selected' : ''}>${esc(e)}</option>`).join('');
    $('#epicList').innerHTML = epics.map((e) => `<option value="${esc(e)}">`).join('');
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

  function openStory(id = null) {
    editingId = id;
    const f = $('#storyForm');
    const s = id ? state.stories.find((x) => x.id === id)
      : { title: '', role: '', want: '', benefit: '', criteria: [], priority: 'could', points: '', epic: ui.epic, column: state.columns[activeCol]?.id };
    $('#storyDlgTitle').textContent = id ? 'Story bearbeiten' : 'Neue Story';
    $('#deleteStoryBtn').hidden = !id;
    $('#columnSelect').innerHTML = state.columns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    for (const k of ['title', 'role', 'want', 'benefit', 'priority', 'epic', 'column']) f.elements[k].value = s[k] ?? '';
    f.elements.points.value = s.points ? String(s.points) : '';
    f.elements.criteria.value = (s.criteria || []).join('\n');
    storyDlg.showModal();
  }
  $('#addBtn').addEventListener('click', () => openStory());

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
  let draft = null; // Vorschau für Farbe/Logo/Name

  $('#swatches').innerHTML = SWATCHES.map((c) => `<button type="button" class="swatch" style="background:${c}" data-c="${c}" aria-label="${c}"></button>`).join('');

  function previewDraft() {
    applyBranding(draft);
    $('#logoPreview').innerHTML = logoHTML(draft);
  }

  $('#settingsBtn').addEventListener('click', () => {
    draft = { ...state.settings };
    const f = $('#settingsForm').elements;
    f.appName.value = draft.appName;
    f.color.value = draft.color;
    f.columns.value = state.columns.map((c) => c.name).join('\n');
    f.newPw.value = '';
    previewDraft();
    setDlg.showModal();
  });

  const sf = $('#settingsForm').elements;
  sf.color.addEventListener('input', (e) => { draft.color = e.target.value; previewDraft(); });
  sf.appName.addEventListener('input', (e) => { draft.appName = e.target.value || 'Story Board'; previewDraft(); });
  $('#swatches').addEventListener('click', (e) => {
    const c = e.target.dataset.c; if (!c) return;
    draft.color = c; sf.color.value = c; previewDraft();
  });

  $('#logoInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { // auf 256 px verkleinern, damit es schlank in der Datenbank liegt
      const max = 256, r = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      draft.logo = cv.toDataURL('image/png');
      URL.revokeObjectURL(url); previewDraft();
    };
    img.onerror = () => toast('Bild konnte nicht gelesen werden.');
    img.src = url;
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

  setDlg.addEventListener('close', () => {
    if (setDlg.returnValue !== 'save') { applyBranding(); return; }
    const f = $('#settingsForm').elements;
    const columns = columnPayload(f.columns.value);
    const columnsChanged = JSON.stringify(columns) !== JSON.stringify(state.columns.map(({ id, name }) => ({ id, name })));
    const newPw = f.newPw.value;
    state.settings = { ...draft };
    render();
    safely(async () => {
      state.settings = await api('PUT', 'api/settings', draft);
      if (columns.length && columnsChanged) state = await api('PUT', 'api/columns', columns);
      if (newPw) {
        if (newPw.length < 4) toast('Passwort zu kurz – nicht geändert.');
        else { await api('PUT', 'api/password', { password: newPw }); toast('Passwort geändert'); }
      }
      render();
    });
  });

  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { return toast('Ungültige Datei'); }
    if (!confirm('Das komplette Board durch den Import ersetzen?')) return;
    safely(async () => {
      state = await api('POST', 'api/import', data);
      setDlg.close('imported');
      render();
      toast('Import erfolgreich');
    });
  });

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
      const s = await api('GET', 'api/session');
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
