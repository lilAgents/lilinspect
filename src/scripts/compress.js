// lilCompress: compress images to WebP or JPEG in the browser via canvas.
// Files are processed locally and never uploaded anywhere.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- theme (OS-aware, matches the family) ---------- */
const MOON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
const SUN_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4l1.4-1.4M18 6l1.4-1.4"/></g></svg>';

function setThemeIcon(btn, theme) {
  if (theme === 'dark') { btn.innerHTML = SUN_SVG; btn.setAttribute('aria-label', 'Switch to light mode'); }
  else { btn.innerHTML = MOON_SVG; btn.setAttribute('aria-label', 'Switch to dark mode'); }
}
function initTheme() {
  const btn = $('#ui-theme-btn');
  const current = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  setThemeIcon(btn, current());
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('lilcompress-theme', next); } catch (e) {}
    setThemeIcon(btn, next);
  });
}

/* ---------- state ---------- */
const state = { quality: 0.8, maxW: 0, fmt: 'image/webp', items: [] };
let nextId = 1;

const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- compression ---------- */
async function compressFile(item) {
  const { file } = item;
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { item.error = 'Could not decode this file as an image.'; return; }

  let { width, height } = bitmap;
  if (state.maxW && width > state.maxW) {
    height = Math.round(height * (state.maxW / width));
    width = state.maxW;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (state.fmt === 'image/jpeg') {
    // JPEG has no alpha; flatten onto white instead of black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close && bitmap.close();

  const blob = await new Promise((res) => canvas.toBlob(res, state.fmt, state.quality));
  if (!blob) { item.error = 'The browser could not encode this image.'; return; }
  if (item.url) URL.revokeObjectURL(item.url);
  item.out = blob;
  item.outW = width;
  item.outH = height;
  item.url = URL.createObjectURL(blob);
  item.error = null;
}

async function processAll() {
  for (const item of state.items) {
    item.busy = true;
    renderList();
    await compressFile(item);
    item.busy = false;
    renderList();
  }
}

/* ---------- render ---------- */
function extFor(fmt) { return fmt === 'image/webp' ? '.webp' : '.jpg'; }
function outName(name) { return name.replace(/\.[a-z0-9]+$/i, '') + extFor(state.fmt); }

function renderList() {
  const list = $('#list');
  if (!state.items.length) { list.innerHTML = ''; return; }
  list.innerHTML = state.items.map((it) => {
    if (it.error) {
      return `<div class="comp-card comp-card--err"><div class="comp-meta"><div class="comp-name">${esc(it.file.name)}</div><div class="comp-sub">${esc(it.error)}</div></div></div>`;
    }
    if (it.busy || !it.out) {
      return `<div class="comp-card"><div class="comp-meta"><div class="comp-name">${esc(it.file.name)}</div><div class="comp-sub">compressing&hellip;</div></div></div>`;
    }
    const saved = it.file.size - it.out.size;
    const pct = Math.round((saved / it.file.size) * 100);
    const grew = saved <= 0;
    return `<div class="comp-card">
      <img class="comp-thumb" src="${it.url}" alt="" />
      <div class="comp-meta">
        <div class="comp-name">${esc(outName(it.file.name))}</div>
        <div class="comp-sub">${fmtBytes(it.file.size)} &rarr; <strong>${fmtBytes(it.out.size)}</strong> &middot; ${it.outW}x${it.outH}</div>
        <div class="comp-sub">${grew ? 'No savings at these settings; the original was already tight.' : `<span class="comp-save">&minus;${pct}%</span> smaller`}</div>
      </div>
      <a class="btn btn--sm comp-dl" href="${it.url}" download="${esc(outName(it.file.name))}">Download</a>
    </div>`;
  }).join('');
}

/* ---------- wire-up ---------- */
function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    state.items.push({ id: nextId++, file: f, out: null, url: null, busy: false, error: null });
  }
  processAll();
}

function initCompress() {
  initTheme();

  $('#f-quality').addEventListener('input', (e) => {
    state.quality = Number(e.target.value) / 100;
    $('#q-val').textContent = e.target.value;
  });
  $('#f-quality').addEventListener('change', processAll);
  $('#f-maxw').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    state.maxW = isNaN(n) || n < 16 ? 0 : n;
    processAll();
  });
  $$('[data-fmt]').forEach((b) => b.addEventListener('click', () => {
    state.fmt = b.dataset.fmt;
    $$('[data-fmt]').forEach((x) => x.classList.toggle('is-active', x === b));
    processAll();
  }));

  $('#f-files').addEventListener('change', (e) => addFiles(e.target.files));
  const drop = $('#drop');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
}

export { initCompress };
