// lilInspect: read what a media file's own bytes say about it. Parses EXIF,
// GPS, ID3, RIFF, PNG chunks, and MP4 boxes with partial Blob.slice reads,
// entirely in the browser, and builds lossless "clean copies" where the
// format allows removing metadata without touching pixels or audio.

const $ = (s, r = document) => r.querySelector(s);

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
    try { localStorage.setItem('lilinspect-theme', next); } catch (e) {}
    setThemeIcon(btn, next);
  });
}

/* ---------- small helpers ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
const fmtDuration = (sec) => {
  if (!isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' + mm : mm) + ':' + String(r).padStart(2, '0');
};
const ascii = (u8, a, b) => { let s = ''; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };
const trimNulls = (s) => s.split('\u0000').map((t) => t.trim()).filter(Boolean).join(', ');

async function readSlice(file, start, len) {
  const end = Math.min(file.size, start + len);
  const buf = await file.slice(start, end).arrayBuffer();
  return new Uint8Array(buf);
}
const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

function decodeText(u8, enc) {
  try {
    if (enc === 'utf-16') {
      // honor the BOM, default to LE
      const be = u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff;
      return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(u8.subarray(u8.length >= 2 && (be || (u8[0] === 0xff && u8[1] === 0xfe)) ? 2 : 0));
    }
    return new TextDecoder(enc).decode(u8);
  } catch (e) { return ''; }
}

/* ---------- TIFF / EXIF (shared by JPEG, PNG eXIf, WebP EXIF) ---------- */
const ORIENTATIONS = { 1: 'Normal', 2: 'Flipped horizontally', 3: 'Rotated 180', 4: 'Flipped vertically', 5: 'Transposed', 6: 'Rotated 90 CW', 7: 'Transversed', 8: 'Rotated 90 CCW' };

function parseTiff(u8) {
  const out = { camera: [], gps: null, dims: null };
  if (u8.length < 12) return out;
  const le = u8[0] === 0x49 && u8[1] === 0x49;
  if (!le && !(u8[0] === 0x4d && u8[1] === 0x4d)) return out;
  const dv = dvOf(u8);
  const g16 = (o) => dv.getUint16(o, le);
  const g32 = (o) => dv.getUint32(o, le);
  if (g16(2) !== 42) return out;

  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  function readIFD(off) {
    const tags = new Map();
    if (off + 2 > u8.length) return tags;
    const n = g16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > u8.length) break;
      const tag = g16(e), type = g16(e + 2), count = g32(e + 4);
      const size = (SIZES[type] || 1) * count;
      const vOff = size <= 4 ? e + 8 : g32(e + 8);
      if (vOff + size > u8.length) continue;
      tags.set(tag, { type, count, vOff });
    }
    return tags;
  }
  function val(t) {
    if (!t) return null;
    const { type, count, vOff } = t;
    if (type === 2) return trimNulls(ascii(u8, vOff, vOff + count));
    if (type === 3) return g16(vOff);
    if (type === 4) return g32(vOff);
    if (type === 5 || type === 10) {
      const rats = [];
      for (let i = 0; i < count; i++) rats.push([g32(vOff + i * 8), g32(vOff + i * 8 + 4)]);
      return rats;
    }
    return null;
  }
  const rat = (r) => (r && r[1] ? r[0] / r[1] : r && r[0] ? r[0] : 0);

  const ifd0 = readIFD(g32(4));
  const push = (k, v) => { if (v !== null && v !== undefined && v !== '' && v !== 0) out.camera.push({ k, v: String(v) }); };
  push('Camera make', val(ifd0.get(0x010f)));
  push('Camera model', val(ifd0.get(0x0110)));
  push('Software', val(ifd0.get(0x0131)));
  push('Created', val(ifd0.get(0x0132)));
  push('Artist', val(ifd0.get(0x013b)));
  push('Copyright', val(ifd0.get(0x8298)));
  const ori = val(ifd0.get(0x0112));
  if (ori && ORIENTATIONS[ori]) push('Orientation', ORIENTATIONS[ori]);

  const exifPtr = val(ifd0.get(0x8769));
  if (exifPtr) {
    const ex = readIFD(exifPtr);
    const created = val(ex.get(0x9003));
    if (created) {
      const i = out.camera.findIndex((r) => r.k === 'Created');
      if (i >= 0) out.camera[i].v = created; else push('Created', created);
    }
    const expo = val(ex.get(0x829a));
    if (expo && expo[0]) {
      const [n, d] = expo[0];
      push('Exposure', n < d ? '1/' + Math.round(d / n) + ' s' : (n / d) + ' s');
    }
    const fnum = val(ex.get(0x829d));
    if (fnum && rat(fnum[0])) push('Aperture', 'f/' + (Math.round(rat(fnum[0]) * 10) / 10));
    push('ISO', val(ex.get(0x8827)));
    const focal = val(ex.get(0x920a));
    if (focal && rat(focal[0])) push('Focal length', Math.round(rat(focal[0]) * 10) / 10 + ' mm');
    push('Lens', val(ex.get(0xa434)));
    const pw = val(ex.get(0xa002)), ph = val(ex.get(0xa003));
    if (pw && ph) out.dims = pw + ' x ' + ph;
  }

  const gpsPtr = val(ifd0.get(0x8825));
  if (gpsPtr) {
    const gp = readIFD(gpsPtr);
    const latRef = val(gp.get(0x0001)), lat = val(gp.get(0x0002));
    const lonRef = val(gp.get(0x0003)), lon = val(gp.get(0x0004));
    const alt = val(gp.get(0x0006));
    const dms = (a) => a && a.length >= 3 ? rat(a[0]) + rat(a[1]) / 60 + rat(a[2]) / 3600 : a && a.length ? rat(a[0]) : null;
    const la = dms(lat), lo = dms(lon);
    if (la !== null && lo !== null) {
      out.gps = {
        lat: (latRef === 'S' ? -1 : 1) * la,
        lon: (lonRef === 'W' ? -1 : 1) * lo,
        alt: alt && rat(alt[0]) ? Math.round(rat(alt[0])) + ' m' : null,
      };
    }
  }
  return out;
}

function gpsSection(gps) {
  if (!gps) return null;
  const la = gps.lat.toFixed(6), lo = gps.lon.toFixed(6);
  const rows = [
    { k: 'Coordinates', v: la + ', ' + lo, warn: true },
    { k: 'Map', html: `<a href="https://www.openstreetmap.org/?mlat=${la}&amp;mlon=${lo}#map=15/${la}/${lo}" target="_blank" rel="noopener">View this spot on OpenStreetMap</a>`, warn: true },
  ];
  if (gps.alt) rows.splice(1, 0, { k: 'Altitude', v: gps.alt, warn: true });
  return { title: 'Location', rows };
}

/* ---------- JPEG ---------- */
async function parseJpeg(file) {
  const head = await readSlice(file, 0, 1 << 20);
  const dv = dvOf(head);
  const sections = [];
  const imgRows = [];
  let tiff = { camera: [], gps: null, dims: null };
  let xmp = 0, iptc = false, icc = false, comment = null, progressive = false, dims = null;

  let pos = 2;
  while (pos + 4 <= head.length) {
    if (head[pos] !== 0xff) break;
    const marker = head[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xda) break; // start of scan: metadata lives before this
    const len = dv.getUint16(pos + 2);
    const dStart = pos + 4, dEnd = pos + 2 + len;
    if (dEnd > head.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      dims = dv.getUint16(dStart + 3) + ' x ' + dv.getUint16(dStart + 1);
      if (marker === 0xc2) progressive = true;
    } else if (marker === 0xe1) {
      const sig = ascii(head, dStart, Math.min(dEnd, dStart + 28));
      if (sig.startsWith('Exif')) tiff = parseTiff(head.subarray(dStart + 6, dEnd));
      else if (sig.startsWith('http://ns.adobe.com/xap/')) xmp += dEnd - dStart;
    } else if (marker === 0xed) {
      if (ascii(head, dStart, dStart + 13).startsWith('Photoshop')) iptc = true;
    } else if (marker === 0xe2) {
      if (ascii(head, dStart, dStart + 11) === 'ICC_PROFILE') icc = true;
    } else if (marker === 0xfe) {
      comment = trimNulls(decodeText(head.subarray(dStart, dEnd), 'latin1')).slice(0, 300);
    }
    pos = dEnd;
  }

  if (dims) imgRows.push({ k: 'Dimensions', v: dims + ' px' });
  if (progressive) imgRows.push({ k: 'Encoding', v: 'Progressive JPEG' });
  imgRows.push({ k: 'ICC color profile', v: icc ? 'Present (a clean copy keeps it)' : 'None' });
  sections.push({ title: 'Image', rows: imgRows });
  if (tiff.camera.length) sections.push({ title: 'Camera (EXIF)', rows: tiff.camera });
  const gpsSec = gpsSection(tiff.gps);
  if (gpsSec) sections.push(gpsSec);
  const other = [];
  if (xmp) other.push({ k: 'XMP packet', v: fmtBytes(xmp) + ' of editor metadata' });
  if (iptc) other.push({ k: 'IPTC / Photoshop', v: 'Present' });
  if (comment) other.push({ k: 'Comment', v: comment });
  if (other.length) sections.push({ title: 'Other metadata', rows: other });

  const hasMeta = tiff.camera.length || tiff.gps || xmp || iptc || comment;
  return {
    label: 'JPEG image', sections, gps: tiff.gps,
    strip: hasMeta ? {
      note: 'Lossless: removes EXIF, GPS, XMP, IPTC, and comments without re-encoding. Pixels untouched, color profile kept.',
      make: () => stripJpeg(file),
    } : null,
  };
}

async function stripJpeg(file) {
  const head = await readSlice(file, 0, 8 << 20);
  const dv = dvOf(head);
  const parts = [file.slice(0, 2)];
  let pos = 2;
  while (pos + 4 <= head.length) {
    if (head[pos] !== 0xff) throw new Error('Unexpected JPEG structure');
    const marker = head[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(file.slice(pos, pos + 2)); pos += 2; continue; }
    if (marker === 0xda) { parts.push(file.slice(pos)); return new Blob(parts, { type: 'image/jpeg' }); }
    const len = dv.getUint16(pos + 2);
    const end = pos + 2 + len;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) parts.push(file.slice(pos, end));
    pos = end;
  }
  throw new Error('Could not find the image scan in the first 8 MB');
}

/* ---------- PNG ---------- */
const PNG_COLOR = { 0: 'Grayscale', 2: 'RGB', 3: 'Indexed', 4: 'Grayscale + alpha', 6: 'RGB + alpha' };
const PNG_META_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'tIME', 'eXIf']);

async function parsePng(file) {
  const whole = file.size <= 32 << 20;
  const buf = await readSlice(file, 0, whole ? file.size : 1 << 20);
  const dv = dvOf(buf);
  const sections = [];
  const imgRows = [], textRows = [];
  let tiff = null, hasMeta = false;

  let pos = 8, guard = 0;
  while (pos + 8 <= buf.length && guard++ < 100000) {
    const len = dv.getUint32(pos);
    const type = ascii(buf, pos + 4, pos + 8);
    const dStart = pos + 8, dEnd = dStart + len;
    if (type === 'IHDR' && dEnd <= buf.length) {
      imgRows.push({ k: 'Dimensions', v: dv.getUint32(dStart) + ' x ' + dv.getUint32(dStart + 4) + ' px' });
      imgRows.push({ k: 'Bit depth', v: buf[dStart + 8] + '-bit ' + (PNG_COLOR[buf[dStart + 9]] || 'unknown') });
    } else if ((type === 'tEXt' || type === 'iTXt') && dEnd <= buf.length && textRows.length < 14) {
      hasMeta = true;
      const data = buf.subarray(dStart, dEnd);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const key = ascii(data, 0, nul);
        let v;
        if (type === 'tEXt') v = decodeText(data.subarray(nul + 1), 'latin1');
        else {
          // iTXt: comp flag + method, then lang and translated keyword, both null-terminated
          let p = nul + 3;
          const compressed = data[nul + 1] === 1;
          p = data.indexOf(0, p) + 1;
          p = data.indexOf(0, p) + 1;
          v = compressed ? '(compressed text, ' + fmtBytes(dEnd - dStart) + ')' : decodeText(data.subarray(p), 'utf-8');
        }
        textRows.push({ k: key, v: trimNulls(v).slice(0, 240) });
      }
    } else if (type === 'zTXt' && dEnd <= buf.length && textRows.length < 14) {
      hasMeta = true;
      const data = buf.subarray(dStart, dEnd);
      const nul = data.indexOf(0);
      if (nul > 0) textRows.push({ k: ascii(data, 0, nul), v: '(compressed text, ' + fmtBytes(len) + ')' });
    } else if (type === 'tIME' && len >= 7 && dEnd <= buf.length) {
      hasMeta = true;
      const pad = (n) => String(n).padStart(2, '0');
      imgRows.push({ k: 'Last modified (tIME)', v: dv.getUint16(dStart) + '-' + pad(buf[dStart + 2]) + '-' + pad(buf[dStart + 3]) + ' ' + pad(buf[dStart + 4]) + ':' + pad(buf[dStart + 5]) });
    } else if (type === 'pHYs' && len >= 9 && dEnd <= buf.length) {
      if (buf[dStart + 8] === 1) imgRows.push({ k: 'Resolution', v: Math.round(dv.getUint32(dStart) * 0.0254) + ' DPI' });
    } else if (type === 'eXIf' && dEnd <= buf.length) {
      hasMeta = true;
      tiff = parseTiff(buf.subarray(dStart, dEnd));
    }
    if (type === 'IEND') break;
    pos = dEnd + 4;
  }

  sections.push({ title: 'Image', rows: imgRows });
  if (tiff && tiff.camera.length) sections.push({ title: 'Camera (EXIF)', rows: tiff.camera });
  const gpsSec = gpsSection(tiff && tiff.gps);
  if (gpsSec) sections.push(gpsSec);
  if (textRows.length) sections.push({ title: 'Text metadata', rows: textRows });
  if (!whole) sections.push({ title: 'Note', rows: [{ k: 'Large file', v: 'Only the first 1 MB was scanned for metadata chunks.' }] });

  return {
    label: 'PNG image', sections, gps: tiff && tiff.gps,
    strip: hasMeta && whole ? {
      note: 'Lossless: removes text, timestamp, and EXIF chunks without re-encoding. Pixels untouched.',
      make: () => stripPng(file),
    } : null,
  };
}

async function stripPng(file) {
  const parts = [file.slice(0, 8)];
  let pos = 8, guard = 0;
  while (pos + 8 <= file.size && guard++ < 100000) {
    const h = await readSlice(file, pos, 8);
    if (h.length < 8) break;
    const len = dvOf(h).getUint32(0);
    const type = ascii(h, 4, 8);
    const total = len + 12;
    if (!PNG_META_CHUNKS.has(type)) parts.push(file.slice(pos, pos + total));
    pos += total;
    if (type === 'IEND') break;
  }
  return new Blob(parts, { type: 'image/png' });
}

/* ---------- RIFF (WebP + WAV) ---------- */
async function riffChunks(file) {
  const chunks = [];
  let pos = 12, guard = 0;
  while (pos + 8 <= file.size && guard++ < 20000) {
    const h = await readSlice(file, pos, 8);
    if (h.length < 8) break;
    const size = dvOf(h).getUint32(4, true);
    chunks.push({ fourcc: ascii(h, 0, 4), pos, size, padded: size + (size & 1) });
    pos += 8 + size + (size & 1);
  }
  return chunks;
}

async function stripRiff(file, form, mime, shouldDrop, patchVp8x) {
  const chunks = await riffChunks(file);
  const parts = [];
  let keepLen = 4;
  for (const c of chunks) {
    if (await shouldDrop(c)) continue;
    if (patchVp8x && c.fourcc === 'VP8X') {
      const payload = await readSlice(file, c.pos + 8, c.size);
      payload[0] &= ~0x0c; // clear the EXIF and XMP flag bits
      const hdr = await readSlice(file, c.pos, 8);
      parts.push(hdr, payload);
      if (c.size & 1) parts.push(new Uint8Array(1));
    } else {
      parts.push(file.slice(c.pos, c.pos + 8 + c.padded));
    }
    keepLen += 8 + c.padded;
  }
  const head = new Uint8Array(12);
  head.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  new DataView(head.buffer).setUint32(4, keepLen, true);
  for (let i = 0; i < 4; i++) head[8 + i] = form.charCodeAt(i);
  return new Blob([head, ...parts], { type: mime });
}

async function parseWebp(file) {
  const chunks = await riffChunks(file);
  const sections = [];
  const imgRows = [];
  let tiff = null, xmp = false, kind = 'Lossy (VP8)';

  for (const c of chunks) {
    if (c.fourcc === 'VP8X' && c.size >= 10) {
      kind = 'Extended (VP8X)';
      const p = await readSlice(file, c.pos + 8, 10);
      const w = 1 + (p[4] | (p[5] << 8) | (p[6] << 16));
      const h = 1 + (p[7] | (p[8] << 8) | (p[9] << 16));
      imgRows.push({ k: 'Dimensions', v: w + ' x ' + h + ' px' });
      const f = [];
      if (p[0] & 0x10) f.push('alpha');
      if (p[0] & 0x02) f.push('animation');
      if (f.length) imgRows.push({ k: 'Features', v: f.join(', ') });
    } else if (c.fourcc === 'VP8 ' && c.size >= 10 && !imgRows.length) {
      const p = await readSlice(file, c.pos + 8, 10);
      if (p[3] === 0x9d && p[4] === 0x01 && p[5] === 0x2a) {
        imgRows.push({ k: 'Dimensions', v: ((p[6] | (p[7] << 8)) & 0x3fff) + ' x ' + ((p[8] | (p[9] << 8)) & 0x3fff) + ' px' });
      }
    } else if (c.fourcc === 'VP8L' && c.size >= 5 && !imgRows.length) {
      kind = 'Lossless (VP8L)';
      const p = await readSlice(file, c.pos + 8, 5);
      if (p[0] === 0x2f) {
        const bits = p[1] | (p[2] << 8) | (p[3] << 16) | (p[4] << 24);
        imgRows.push({ k: 'Dimensions', v: (1 + (bits & 0x3fff)) + ' x ' + (1 + ((bits >> 14) & 0x3fff)) + ' px' });
      }
    } else if (c.fourcc === 'EXIF') {
      tiff = parseTiff(await readSlice(file, c.pos + 8, Math.min(c.size, 1 << 20)));
    } else if (c.fourcc === 'XMP ') {
      xmp = true;
    }
  }

  imgRows.push({ k: 'Encoding', v: kind });
  sections.push({ title: 'Image', rows: imgRows });
  if (tiff && tiff.camera.length) sections.push({ title: 'Camera (EXIF)', rows: tiff.camera });
  const gpsSec = gpsSection(tiff && tiff.gps);
  if (gpsSec) sections.push(gpsSec);
  if (xmp) sections.push({ title: 'Other metadata', rows: [{ k: 'XMP packet', v: 'Present' }] });

  const hasMeta = tiff || xmp;
  return {
    label: 'WebP image', sections, gps: tiff && tiff.gps,
    strip: hasMeta ? {
      note: 'Lossless: removes the EXIF and XMP chunks without re-encoding. Pixels untouched.',
      make: () => stripRiff(file, 'WEBP', 'image/webp', (c) => c.fourcc === 'EXIF' || c.fourcc === 'XMP ', true),
    } : null,
  };
}

const WAV_INFO = { INAM: 'Title', IART: 'Artist', IPRD: 'Album / product', ICRD: 'Created', IGNR: 'Genre', ISFT: 'Software', ICMT: 'Comment', ICOP: 'Copyright', IENG: 'Engineer' };

async function parseWav(file) {
  const chunks = await riffChunks(file);
  const sections = [];
  const audioRows = [], tagRows = [];
  let byteRate = 0, dataSize = 0, hasMeta = false;

  for (const c of chunks) {
    if (c.fourcc === 'fmt ' && c.size >= 16) {
      const p = await readSlice(file, c.pos + 8, 16);
      const dv = dvOf(p);
      const ch = dv.getUint16(2, true);
      byteRate = dv.getUint32(8, true);
      audioRows.push({ k: 'Channels', v: ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : ch + ' channels' });
      audioRows.push({ k: 'Sample rate', v: (dv.getUint32(4, true) / 1000) + ' kHz' });
      audioRows.push({ k: 'Bit depth', v: dv.getUint16(14, true) + '-bit' });
    } else if (c.fourcc === 'data') {
      dataSize = c.size;
    } else if (c.fourcc === 'LIST') {
      const p = await readSlice(file, c.pos + 8, Math.min(c.size, 1 << 16));
      if (ascii(p, 0, 4) === 'INFO') {
        hasMeta = true;
        let q = 4;
        while (q + 8 <= p.length && tagRows.length < 14) {
          const id = ascii(p, q, q + 4);
          const len = dvOf(p).getUint32(q + 4, true);
          const v = trimNulls(decodeText(p.subarray(q + 8, Math.min(q + 8 + len, p.length)), 'latin1'));
          if (v) tagRows.push({ k: WAV_INFO[id] || id, v: v.slice(0, 240) });
          q += 8 + len + (len & 1);
        }
      }
    } else if (c.fourcc === 'id3 ' || c.fourcc === 'ID3 ') {
      hasMeta = true;
      tagRows.push({ k: 'ID3 tag chunk', v: fmtBytes(c.size) });
    }
  }

  if (byteRate && dataSize) {
    const d = fmtDuration(dataSize / byteRate);
    if (d) audioRows.unshift({ k: 'Duration', v: d });
  }
  sections.push({ title: 'Audio', rows: audioRows });
  if (tagRows.length) sections.push({ title: 'Tags (INFO)', rows: tagRows });

  return {
    label: 'WAV audio', sections, gps: null,
    strip: hasMeta ? {
      note: 'Lossless: removes the INFO and ID3 chunks without touching the audio data.',
      make: () => stripRiff(file, 'WAVE', 'audio/wav', async (c) => {
        if (c.fourcc === 'id3 ' || c.fourcc === 'ID3 ') return true;
        if (c.fourcc !== 'LIST') return false;
        const p = await readSlice(file, c.pos + 8, 4);
        return ascii(p, 0, 4) === 'INFO';
      }, false),
    } : null,
  };
}

/* ---------- MP3 / ID3 ---------- */
const ID3_V23 = { TIT2: 'Title', TPE1: 'Artist', TALB: 'Album', TYER: 'Year', TDRC: 'Recorded', TRCK: 'Track', TCON: 'Genre', TPE2: 'Album artist', TCOM: 'Composer', TPUB: 'Publisher', TSSE: 'Encoder' };
const ID3_V22 = { TT2: 'Title', TP1: 'Artist', TAL: 'Album', TYE: 'Year', TRK: 'Track', TCO: 'Genre', TP2: 'Album artist', TCM: 'Composer' };
const BITRATES = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLERATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

const syncsafe = (u8, o) => ((u8[o] & 0x7f) << 21) | ((u8[o + 1] & 0x7f) << 14) | ((u8[o + 2] & 0x7f) << 7) | (u8[o + 3] & 0x7f);
const id3enc = (b) => (b === 1 || b === 2 ? 'utf-16' : b === 3 ? 'utf-8' : 'latin1');

async function parseMp3(file) {
  const head = await readSlice(file, 0, 1 << 20);
  const sections = [];
  const tagRows = [];
  let v2End = 0, version = null, art = null;

  if (ascii(head, 0, 3) === 'ID3') {
    const major = head[3];
    version = 'ID3v2.' + major;
    const flags = head[5];
    const tagSize = syncsafe(head, 6);
    v2End = 10 + tagSize + (flags & 0x10 ? 10 : 0);
    let pos = 10;
    if (flags & 0x40) pos += major === 4 ? syncsafe(head, 10) : dvOf(head).getUint32(10) + 4;
    const tagEnd = Math.min(10 + tagSize, head.length);
    const idLen = major === 2 ? 3 : 4;
    let guard = 0;
    while (pos + idLen + (major === 2 ? 3 : 6) <= tagEnd && guard++ < 500) {
      const id = ascii(head, pos, pos + idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let size, dataOff;
      if (major === 2) { size = (head[pos + 3] << 16) | (head[pos + 4] << 8) | head[pos + 5]; dataOff = pos + 6; }
      else if (major === 4) { size = syncsafe(head, pos + 4); dataOff = pos + 10; }
      else { size = dvOf(head).getUint32(pos + 4); dataOff = pos + 10; }
      const dEnd = Math.min(dataOff + size, tagEnd);
      const label = major === 2 ? ID3_V22[id] : ID3_V23[id];
      if (label && size > 1 && tagRows.length < 16) {
        const v = trimNulls(decodeText(head.subarray(dataOff + 1, dEnd), id3enc(head[dataOff])));
        if (v) tagRows.push({ k: label, v: v.slice(0, 240) });
      } else if ((id === 'COMM' || id === 'COM') && size > 5 && tagRows.length < 16) {
        const segs = decodeText(head.subarray(dataOff + 4, dEnd), id3enc(head[dataOff])).split('\u0000').map((t) => t.trim()).filter(Boolean);
        if (segs.length) tagRows.push({ k: 'Comment', v: segs[segs.length - 1].slice(0, 240) });
      } else if (id === 'APIC' || id === 'PIC') {
        art = fmtBytes(size);
      } else if (id === 'USLT' && size > 5) {
        tagRows.push({ k: 'Lyrics', v: 'Embedded (' + fmtBytes(size) + ')' });
      }
      pos = dataOff + size;
    }
  }

  let v1 = false;
  if (file.size >= 128) {
    const tail = await readSlice(file, file.size - 128, 128);
    if (ascii(tail, 0, 3) === 'TAG') {
      v1 = true;
      if (!tagRows.length) {
        const f = (a, b) => trimNulls(decodeText(tail.subarray(a, b), 'latin1'));
        const t = f(3, 33), ar = f(33, 63), al = f(63, 93), y = f(93, 97);
        if (t) tagRows.push({ k: 'Title', v: t });
        if (ar) tagRows.push({ k: 'Artist', v: ar });
        if (al) tagRows.push({ k: 'Album', v: al });
        if (y) tagRows.push({ k: 'Year', v: y });
      }
    }
  }

  // first MPEG frame header tells us version, layer, bitrate, sample rate
  const audioRows = [];
  for (let i = v2End; i < Math.min(head.length - 4, v2End + (1 << 16)); i++) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (head[i + 1] >> 3) & 3;
    const layerBits = (head[i + 1] >> 1) & 3;
    const brIdx = head[i + 2] >> 4;
    const srIdx = (head[i + 2] >> 2) & 3;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const ver = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const br = BITRATES[(ver === 1 ? 1 : 2) + '-' + layer][brIdx];
    const sr = SAMPLERATES[ver][srIdx];
    audioRows.push({ k: 'Format', v: 'MPEG-' + ver + ' Layer ' + ['I', 'II', 'III'][layer - 1] });
    audioRows.push({ k: 'Bitrate', v: br + ' kbps' });
    audioRows.push({ k: 'Sample rate', v: sr / 1000 + ' kHz' });
    const d = fmtDuration(((file.size - v2End - (v1 ? 128 : 0)) * 8) / (br * 1000));
    if (d) audioRows.push({ k: 'Duration', v: '~' + d + ' (assumes constant bitrate)' });
    break;
  }

  if (audioRows.length) sections.push({ title: 'Audio', rows: audioRows });
  if (tagRows.length || art) {
    const rows = [...tagRows];
    if (art) rows.push({ k: 'Cover art', v: 'Embedded (' + art + ')' });
    if (version && v1) rows.push({ k: 'Tag versions', v: version + ' and ID3v1' });
    sections.push({ title: 'Tags (' + (version || 'ID3v1') + ')', rows });
  }

  const hasMeta = v2End > 0 || v1;
  return {
    label: 'MP3 audio', sections, gps: null,
    strip: hasMeta ? {
      note: 'Lossless: cuts the ID3 tag blocks (including cover art) off the file. The audio stream itself is untouched.',
      make: async () => new Blob([file.slice(v2End, v1 ? file.size - 128 : file.size)], { type: 'audio/mpeg' }),
    } : null,
  };
}

/* ---------- MP4 / MOV / M4A ---------- */
const MP4_TAGS = { '©nam': 'Title', '©ART': 'Artist', '©alb': 'Album', '©day': 'Date', '©too': 'Encoder', '©cmt': 'Comment', '©gen': 'Genre', '©wrt': 'Composer' };
const MP4_EPOCH = 2082844800; // seconds between 1904-01-01 and 1970-01-01

function mp4Date(sec) {
  if (!sec || sec <= MP4_EPOCH) return null;
  const d = new Date((sec - MP4_EPOCH) * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

async function parseMp4(file) {
  const sections = [];
  const vidRows = [], tagRows = [];
  let gps = null, brand = null;

  // top-level boxes via header peeks: ftyp, moov, mdat live side by side
  let pos = 0, moov = null, guard = 0;
  while (pos + 8 <= file.size && guard++ < 200) {
    const h = await readSlice(file, pos, 16);
    if (h.length < 8) break;
    let size = dvOf(h).getUint32(0);
    const type = ascii(h, 4, 8);
    if (size === 1 && h.length >= 16) size = Number(dvOf(h).getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    if (type === 'ftyp') {
      const p = await readSlice(file, pos + 8, Math.min(size - 8, 24));
      brand = ascii(p, 0, 4).trim();
    } else if (type === 'moov') {
      moov = { pos, size };
    }
    pos += size;
  }

  if (brand) vidRows.push({ k: 'Container', v: 'ISO media (' + brand + ')' });

  if (moov && moov.size <= 32 << 20) {
    const buf = await readSlice(file, moov.pos, moov.size);
    const dv = dvOf(buf);
    const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'udta', 'ilst']);
    const dims = [];

    const walk = (start, end, depth, parent) => {
      let p = start, g = 0;
      while (p + 8 <= end && g++ < 4000) {
        let size = dv.getUint32(p);
        const type = ascii(buf, p + 4, p + 8);
        let hdr = 8;
        if (size === 1 && p + 16 <= end) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < 8 || p + size > end) break;
        const dStart = p + hdr, dEnd = p + size;

        if (type === 'mvhd' && dEnd - dStart >= 20) {
          const ver = buf[dStart];
          let ctime, timescale, duration;
          if (ver === 1) {
            ctime = Number(dv.getBigUint64(dStart + 4));
            timescale = dv.getUint32(dStart + 20);
            duration = Number(dv.getBigUint64(dStart + 24));
          } else {
            ctime = dv.getUint32(dStart + 4);
            timescale = dv.getUint32(dStart + 12);
            duration = dv.getUint32(dStart + 16);
          }
          if (timescale) {
            const d = fmtDuration(duration / timescale);
            if (d) vidRows.push({ k: 'Duration', v: d });
          }
          const cd = mp4Date(ctime);
          if (cd) vidRows.push({ k: 'Created', v: cd });
        } else if (type === 'tkhd' && dEnd - dStart >= 84) {
          const ver = buf[dStart];
          const wOff = dStart + (ver === 1 ? 88 : 76);
          if (wOff + 8 <= dEnd) {
            const w = dv.getUint32(wOff) >> 16, hgt = dv.getUint32(wOff + 4) >> 16;
            if (w && hgt) dims.push(w + ' x ' + hgt);
          }
        } else if (MP4_TAGS[type] && parent === 'ilst') {
          // each ilst item holds a 'data' box: 8 header + 4 type + 4 locale
          if (dEnd - dStart >= 16 && ascii(buf, dStart + 4, dStart + 8) === 'data') {
            const v = trimNulls(decodeText(buf.subarray(dStart + 16, dEnd), 'utf-8'));
            if (v && tagRows.length < 14) tagRows.push({ k: MP4_TAGS[type], v: v.slice(0, 240) });
          }
        } else if (type === '©xyz' && parent === 'udta' && dEnd - dStart >= 4) {
          const s = decodeText(buf.subarray(dStart + 4, dEnd), 'utf-8');
          const m = s.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
          if (m) gps = { lat: parseFloat(m[1]), lon: parseFloat(m[2]), alt: null };
        } else if (type === 'meta' && depth < 8) {
          // 'meta' is a full box in MP4; QuickTime writes it as a plain box
          const skip = dEnd - dStart >= 4 && dv.getUint32(dStart) === 0 ? 4 : 0;
          walk(dStart + skip, dEnd, depth + 1, 'meta');
        } else if (CONTAINERS.has(type) && depth < 8) {
          walk(dStart, dEnd, depth + 1, type);
        }
        p += size;
      }
    };
    walk(8, buf.length, 0, 'root');
    if (dims.length) vidRows.splice(1, 0, { k: 'Frame size', v: dims.find((d) => d !== '0 x 0') || dims[0] });
  } else if (moov) {
    vidRows.push({ k: 'Note', v: 'The moov box is unusually large; details were skipped.' });
  } else {
    vidRows.push({ k: 'Note', v: 'No moov box found in this file.' });
  }

  sections.push({ title: 'Video / container', rows: vidRows });
  const gpsSec = gpsSection(gps);
  if (gpsSec) sections.push(gpsSec);
  if (tagRows.length) sections.push({ title: 'Tags', rows: tagRows });
  sections.push({ title: 'Clean copy', rows: [{ k: 'Stripping', v: 'Not offered for MP4/MOV here yet: metadata is woven through the same index that makes the video playable, so removing it safely means rewriting the container.' }] });

  return { label: brand === 'M4A' || brand === 'M4A ' ? 'M4A audio' : 'MP4 / MOV video', sections, gps, strip: null };
}

/* ---------- GIF + generic ---------- */
async function parseGif(file) {
  const head = await readSlice(file, 0, 16);
  const dv = dvOf(head);
  return {
    label: 'GIF image',
    sections: [{ title: 'Image', rows: [
      { k: 'Version', v: ascii(head, 0, 6) },
      { k: 'Dimensions', v: dv.getUint16(6, true) + ' x ' + dv.getUint16(8, true) + ' px' },
    ] }],
    gps: null, strip: null,
  };
}

function parseGeneric(label) {
  return {
    label,
    sections: [{ title: 'Note', rows: [{ k: 'Format', v: 'lilInspect does not parse this format deeply yet. The basics above still come straight from the file.' }] }],
    gps: null, strip: null,
  };
}

/* ---------- sniff + orchestrate ---------- */
async function inspectFile(file) {
  const head = await readSlice(file, 0, 16);
  const a = (i, j) => ascii(head, i, j);
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return parseJpeg(file);
  if (head.length >= 8 && head[0] === 0x89 && a(1, 4) === 'PNG') return parsePng(file);
  if (a(0, 4) === 'GIF8') return parseGif(file);
  if (a(0, 4) === 'RIFF' && a(8, 12) === 'WEBP') return parseWebp(file);
  if (a(0, 4) === 'RIFF' && a(8, 12) === 'WAVE') return parseWav(file);
  if (a(0, 3) === 'ID3') return parseMp3(file);
  if (a(4, 8) === 'ftyp') return parseMp4(file);
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return parseMp3(file);
  if (a(0, 4) === 'fLaC') return parseGeneric('FLAC audio');
  if (a(0, 4) === 'OggS') return parseGeneric('Ogg audio');
  return parseGeneric(file.type || 'Unknown format');
}

/* ---------- render ---------- */
const current = { file: null, strip: null };

function cleanName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) + '-clean' + name.slice(dot) : name + '-clean';
}

function renderResult(file, res) {
  $('#empty') && $('#empty').remove();

  $('#file-card').classList.remove('is-hidden');
  $('#fc-name').textContent = file.name;
  $('#fc-sub').textContent = res.label + ' · ' + fmtBytes(file.size);
  $('#fc-flags').innerHTML = res.gps
    ? '<span class="insp-flag insp-flag--warn">Reveals a GPS location</span>'
    : '<span class="insp-flag">No location data found</span>';

  const stripBox = $('#strip-box');
  const stripBtn = $('#strip-btn');
  stripBtn.textContent = 'Download clean copy';
  stripBtn.disabled = false;
  if (res.strip) {
    stripBox.classList.remove('is-hidden');
    $('#strip-note').textContent = res.strip.note;
    current.strip = res.strip;
  } else {
    stripBox.classList.add('is-hidden');
    current.strip = null;
  }

  const fileRows = [
    { k: 'Name', v: file.name },
    { k: 'Size', v: fmtBytes(file.size) + ' (' + file.size.toLocaleString() + ' bytes)' },
    { k: 'Detected type', v: res.label + (file.type ? ' (' + file.type + ')' : '') },
    { k: 'Modified on disk', v: new Date(file.lastModified).toLocaleString() },
  ];
  const all = [{ title: 'File', rows: fileRows }, ...res.sections];

  $('#sections').innerHTML = all.map((sec) => `
    <section class="insp-sec">
      <h2 class="insp-sec__title">${esc(sec.title)}</h2>
      ${sec.rows.map((r) => `
        <div class="insp-row${r.warn ? ' insp-row--warn' : ''}">
          <span class="insp-k">${esc(r.k)}</span>
          <span class="insp-v">${r.html ? r.html : esc(r.v)}</span>
        </div>`).join('')}
    </section>`).join('');
}

async function handleFile(file) {
  if (!file) return;
  current.file = file;
  $('#sections').innerHTML = '<div class="insp-empty"><p class="insp-empty__big">Reading the bytes&hellip;</p></div>';
  try {
    const res = await inspectFile(file);
    renderResult(file, res);
  } catch (e) {
    renderResult(file, {
      label: file.type || 'Unknown', gps: null, strip: null,
      sections: [{ title: 'Note', rows: [{ k: 'Parse error', v: 'This file could not be read cleanly: ' + (e && e.message ? e.message : e) }] }],
    });
  }
}

/* ---------- wire-up ---------- */
function initInspect() {
  initTheme();

  $('#f-file').addEventListener('change', (e) => handleFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });

  $('#strip-btn').addEventListener('click', async (e) => {
    if (!current.strip || !current.file) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const blob = await current.strip.make();
      const url = URL.createObjectURL(blob);
      const aEl = document.createElement('a');
      aEl.href = url; aEl.download = cleanName(current.file.name);
      document.body.appendChild(aEl); aEl.click(); document.body.removeChild(aEl);
      URL.revokeObjectURL(url);
      btn.textContent = 'Saved';
      setTimeout(() => { btn.textContent = 'Download clean copy'; btn.disabled = false; }, 1100);
    } catch (err) {
      btn.textContent = 'Could not strip this file';
      setTimeout(() => { btn.textContent = 'Download clean copy'; btn.disabled = false; }, 1800);
    }
  });
}

export { initInspect };
