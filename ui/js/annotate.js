// Annotation model + renderer, shared by the editor and by captures annotated in
// the GNOME Shell overlay. Annotation schema (same as extension/logic.js):
//   { type, pts: [[x, y], ...], color: [r, g, b] (0..1), width, strength (0..2),
//     text, size, bold, bg ('none'|'dark'|'light'), r, n }
// Coordinates are in "desktop" units; the transform {ox, oy, scale} maps them to canvas pixels.

export const EFFECTS = ['blur', 'pixelate', 'erase'];
export const PIX_BLOCK = [8, 14, 22];
export const BLUR_RADIUS = [6, 12, 22];
export const FONT = '"Inter", "Noto Sans Arabic", "Cantarell", system-ui, sans-serif';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const css = c => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;

export function renderAnnotations(ctx, anns, tf = { ox: 0, oy: 0, scale: 1 }) {
  const fx = anns.filter(a => EFFECTS.includes(a.type));
  const shapes = anns.filter(a => !EFFECTS.includes(a.type));
  renderEffects(ctx, fx, tf);
  renderShapes(ctx, shapes, tf);
}

export function renderEffects(ctx, anns, tf) {
  for (const a of anns) { try { effect(ctx, a, tf); } catch (e) { console.warn('effect failed', e); } }
}

export function renderShapes(ctx, anns, tf) {
  for (const a of anns) { try { shape(ctx, a, tf); } catch (e) { console.warn('shape failed', e); } }
}

const map = (a, tf) => a.pts.map(([x, y]) => [(x - tf.ox) * tf.scale, (y - tf.oy) * tf.scale]);

export function normRect(p0, p1) {
  const x = Math.min(p0[0], p1[0]), y = Math.min(p0[1], p1[1]);
  return { x, y, w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1]) };
}

// ------------------------------------------------------------------ shapes
function shape(ctx, a, tf) {
  const pts = map(a, tf);
  const [p0] = pts, p1 = pts[pts.length - 1];
  const s = tf.scale;
  const color = css(a.color || [1, 0, 0]);
  const width = (a.width ?? 4) * s;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
  switch (a.type) {
    case 'rect': {
      const r = normRect(p0, p1);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = normRect(p0, p1);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w / 2, .5), Math.max(r.h / 2, .5), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      let end = p1;
      let head = null;
      if (a.type === 'arrow') {
        const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dist = Math.hypot(dx, dy);
        if (dist > 1) {
          const ux = dx / dist, uy = dy / dist;
          const L = Math.min((13 + (a.width ?? 4) * 3.4) * s, dist * .8);   // head length
          const hw = L * .46;                                               // half width of the head
          const nx = -uy, ny = ux;
          const bx = p1[0] - ux * L, by = p1[1] - uy * L;                   // base centre
          const notch = [bx + ux * L * .26, by + uy * L * .26];             // concave back edge
          head = [p1, [bx + nx * hw, by + ny * hw], notch, [bx - nx * hw, by - ny * hw]];
          end = notch;
        }
      }
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(end[0], end[1]); ctx.stroke();
      if (head) {
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.beginPath();
        ctx.moveTo(head[0][0], head[0][1]);
        for (let i = 1; i < head.length; i++) ctx.lineTo(head[i][0], head[i][1]);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      break;
    }
    case 'pen':
    case 'highlight': {
      if (a.type === 'highlight') {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = .85;
        ctx.lineWidth = width * 4;
        ctx.lineCap = 'butt';
      }
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      if (pts.length === 1) ctx.lineTo(p0[0] + .1, p0[1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      if (pts.length > 1) ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      break;
    }
    case 'text': drawText(ctx, a, p0, s); break;
    case 'step': {
      const r = (a.r ?? 14) * s;
      ctx.beginPath(); ctx.arc(p0[0], p0[1], r, 0, Math.PI * 2); ctx.fill();
      const c = a.color || [1, 0, 0];
      const lum = .299 * c[0] + .587 * c[1] + .114 * c[2];
      ctx.fillStyle = lum > .6 ? '#000' : '#fff';
      ctx.font = `700 ${Math.max(1, Math.round(r * 1.15))}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(a.n ?? 1), p0[0], p0[1] + r * .06);
      break;
    }
  }
  ctx.restore();
}

function textLayout(ctx, a, s) {
  ctx.font = `${a.bold ? 700 : 400} ${Math.max(1, Math.round(a.size * s))}px ${FONT}`;
  const lines = String(a.text ?? '').split('\n');
  const lineH = a.size * 1.2 * s;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width), 1);
  return { lines, lineH, w, h: lineH * lines.length };
}

function drawText(ctx, a, p0, s) {
  const L = textLayout(ctx, a, s);
  const bg = a.bg || 'none';
  if (bg === 'dark' || bg === 'light') {
    const pad = 6 * s, x = p0[0] - pad, y = p0[1] - 4 * s, w = L.w + pad * 2, h = L.h + 4 * s;
    ctx.fillStyle = bg === 'dark' ? 'rgba(0,0,0,.68)' : 'rgba(255,255,255,.9)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6 * s);
    ctx.fill();
  }
  ctx.fillStyle = css(a.color || [1, 0, 0]);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  L.lines.forEach((line, i) => ctx.fillText(line, p0[0], p0[1] + i * L.lineH + (L.lineH - a.size * s) / 2));
}

// ------------------------------------------------------------------ geometry for editing
let measureCtx;
export function bbox(a) {
  const xs = a.pts.map(p => p[0]), ys = a.pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (a.type === 'text') {
    measureCtx ??= document.createElement('canvas').getContext('2d');
    const L = textLayout(measureCtx, a, 1);
    return { x: x0 - 6, y: y0 - 4, w: L.w + 12, h: L.h + 8 };
  }
  if (a.type === 'step') { const r = a.r ?? 14; return { x: x0 - r, y: y0 - r, w: r * 2, h: r * 2 }; }
  const pad = (a.width ?? 4) * (a.type === 'highlight' ? 2.2 : 1) / 2 + 3;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

export function hitTest(anns, x, y, tol = 6) {
  for (let i = anns.length - 1; i >= 0; i--) {
    const b = bbox(anns[i]);
    if (x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol) return i;
  }
  return -1;
}

// ------------------------------------------------------------------ pixel effects
function boxBlur(src, w, h, r, passes) {
  const n = w * h * 4;
  let a = Float32Array.from(src.subarray(0, n)), b = new Float32Array(n);
  const div = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let c = 0; c < 3; c++) {
        let acc = a[row + c] * (r + 1);
        for (let i = 0; i < r; i++) acc += a[row + Math.min(i, w - 1) * 4 + c];
        for (let x = 0; x < w; x++) {
          acc += a[row + Math.min(x + r, w - 1) * 4 + c] - a[row + Math.max(x - r - 1, 0) * 4 + c];
          b[row + x * 4 + c] = acc / div;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = b[x * 4 + c] * (r + 1);
        for (let i = 0; i < r; i++) acc += b[Math.min(i, h - 1) * w * 4 + x * 4 + c];
        for (let y = 0; y < h; y++) {
          acc += b[Math.min(y + r, h - 1) * w * 4 + x * 4 + c] - b[Math.max(y - r - 1, 0) * w * 4 + x * 4 + c];
          a[y * w * 4 + x * 4 + c] = acc / div;
        }
      }
    }
  }
  return a;
}

function effectBlur(src, pw, ph, radius) {
  const f = Math.max(2, Math.round(radius * .7));
  const sw = Math.ceil(pw / f), sh = Math.ceil(ph / f);
  const small = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y * f; yy < Math.min(ph, y * f + f); yy++) {
      let i = (yy * pw + x * f) * 4;
      for (let xx = x * f; xx < Math.min(pw, x * f + f); xx++, i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
    }
    const d = (y * sw + x) * 4; small[d] = r / n; small[d + 1] = g / n; small[d + 2] = b / n; small[d + 3] = 255;
  }
  const blurred = boxBlur(small, sw, sh, Math.max(1, Math.round(radius / f)), 3);
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let i = 0; i < out.length; i++) out[i] = blurred[i];
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { arr: out, w: sw, h: sh, f };
}

function effectPixelate(src, pw, ox, oy, iw, ih, block) {
  const out = new Uint8ClampedArray(iw * ih * 4);
  for (let by = 0; by < ih; by += block) for (let bx = 0; bx < iw; bx += block) {
    const x1 = Math.min(bx + block, iw), y1 = Math.min(by + block, ih);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
      const s = ((y + oy) * pw + (x + ox)) * 4;
      r += src[s]; g += src[s + 1]; b += src[s + 2]; n++;
    }
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
      const d = (y * iw + x) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = 255;
    }
  }
  return out;
}

// Smart eraser: flat background -> exact colour; otherwise blend per-side medians.
function effectErase(src, pw, ph, ox, oy, iw, ih, has) {
  const RING = 6, TOL = 14;
  const fill = (r, g, b) => {
    const out = new Uint8ClampedArray(iw * ih * 4);
    for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
    return out;
  };
  const ring = [];
  for (let y = Math.max(0, oy - RING); y < Math.min(ph, oy + ih + RING); y++) {
    const inside = y >= oy && y < oy + ih;
    for (let x = Math.max(0, ox - RING); x < Math.min(pw, ox + iw + RING); x++) {
      if (inside && x >= ox && x < ox + iw) { x = ox + iw - 1; continue; }
      const i = (y * pw + x) * 4;
      ring.push(src[i], src[i + 1], src[i + 2]);
    }
  }
  const n = ring.length / 3;
  if (n === 0) return fill(255, 255, 255);
  const bins = new Map();
  for (let i = 0; i < ring.length; i += 3) {
    const k = ((ring[i] >> 3) << 10) | ((ring[i + 1] >> 3) << 5) | (ring[i + 2] >> 3);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  let best = -1, bestN = 0;
  for (const [k, c] of bins) if (c > bestN) { best = k; bestN = c; }
  const cr = ((best >> 10) << 3) + 4, cg = (((best >> 5) & 31) << 3) + 4, cb = ((best & 31) << 3) + 4;
  let sr = 0, sg = 0, sb = 0, m = 0;
  for (let i = 0; i < ring.length; i += 3) {
    if (Math.abs(ring[i] - cr) <= TOL && Math.abs(ring[i + 1] - cg) <= TOL && Math.abs(ring[i + 2] - cb) <= TOL) {
      sr += ring[i]; sg += ring[i + 1]; sb += ring[i + 2]; m++;
    }
  }
  if (m / n >= .5) return fill(Math.round(sr / m), Math.round(sg / m), Math.round(sb / m));

  const depth = 4;
  const px = (x, y) => {
    const s = (clamp(y, 0, ph - 1) * pw + clamp(x, 0, pw - 1)) * 4;
    return [src[s], src[s + 1], src[s + 2]];
  };
  const median = cols => [0, 1, 2].map(c => { const v = cols.map(p => p[c]).sort((a, b) => a - b); return v[v.length >> 1]; });
  const lerp = (a, b, t) => !a ? b : !b ? a : [0, 1, 2].map(i => a[i] * (1 - t) + b[i] * t);
  const gx = Math.min(iw, 48), gy = Math.min(ih, 48);
  const strip = fn => median([...Array(depth).keys()].map(fn));
  const top = [], bottom = [], left = [], right = [];
  for (let i = 0; i < gx; i++) {
    const x = ox + Math.floor((i + .5) * iw / gx);
    top.push(has.top ? strip(k => px(x, oy - 1 - k)) : null);
    bottom.push(has.bottom ? strip(k => px(x, oy + ih + k)) : null);
  }
  for (let j = 0; j < gy; j++) {
    const y = oy + Math.floor((j + .5) * ih / gy);
    left.push(has.left ? strip(k => px(ox - 1 - k, y)) : null);
    right.push(has.right ? strip(k => px(ox + iw + k, y)) : null);
  }
  const mean2 = parts => [0, 1, 2].map(c => parts.reduce((a, p) => a + p[c], 0) / parts.length);
  const grid = [];
  for (let j = 0; j < gy; j++) {
    const ty = (j + .5) / gy, row = [];
    for (let i = 0; i < gx; i++) {
      const tx = (i + .5) / gx;
      const parts = [lerp(left[j], right[j], tx), lerp(top[i], bottom[i], ty)].filter(Boolean);
      row.push(parts.length ? mean2(parts) : [255, 255, 255]);
    }
    grid.push(row);
  }
  const out = new Uint8ClampedArray(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    const fy = clamp((y + .5) * gy / ih - .5, 0, gy - 1), j0 = Math.floor(fy), j1 = Math.min(j0 + 1, gy - 1), wy = fy - j0;
    for (let x = 0; x < iw; x++) {
      const fx = clamp((x + .5) * gx / iw - .5, 0, gx - 1), i0 = Math.floor(fx), i1 = Math.min(i0 + 1, gx - 1), wx = fx - i0;
      const d = (y * iw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = grid[j0][i0][c] * (1 - wx) + grid[j0][i1][c] * wx;
        const q = grid[j1][i0][c] * (1 - wx) + grid[j1][i1][c] * wx;
        out[d + c] = p * (1 - wy) + q * wy;
      }
      out[d + 3] = 255;
    }
  }
  return out;
}

function effect(ctx, a, tf) {
  const pts = map(a, tf);
  const r = normRect(pts[0], pts[pts.length - 1]);
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const x = clamp(Math.round(r.x), 0, W), y = clamp(Math.round(r.y), 0, H);
  const iw = clamp(Math.round(r.x + r.w), 0, W) - x, ih = clamp(Math.round(r.y + r.h), 0, H) - y;
  if (iw < 1 || ih < 1) return;
  const strength = clamp(a.strength ?? 1, 0, 2);
  const s = tf.scale;
  const radius = BLUR_RADIUS[strength] * s;
  const pad = a.type === 'blur' ? Math.ceil(radius * 2) : 10;
  const px0 = Math.max(0, x - pad), py0 = Math.max(0, y - pad);
  const px1 = Math.min(W, x + iw + pad), py1 = Math.min(H, y + ih + pad);
  const pw = px1 - px0, ph = py1 - py0;
  const src = ctx.getImageData(px0, py0, pw, ph).data;
  const ox = x - px0, oy = y - py0;

  if (a.type === 'blur') {
    const res = effectBlur(src, pw, ph, radius);
    const tmp = document.createElement('canvas');
    tmp.width = res.w; tmp.height = res.h;
    tmp.getContext('2d').putImageData(new ImageData(res.arr, res.w, res.h), 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, iw, ih); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, res.w, res.h, px0, py0, res.w * res.f, res.h * res.f);
    ctx.restore();
    return;
  }
  const out = a.type === 'pixelate'
    ? effectPixelate(src, pw, ox, oy, iw, ih, Math.max(4, Math.round(PIX_BLOCK[strength] * s)))
    : effectErase(src, pw, ph, ox, oy, iw, ih, { top: y > 0, left: x > 0, bottom: y + ih < H, right: x + iw < W });
  ctx.putImageData(new ImageData(out, iw, ih), x, y);
}

export function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('could not load image'));
    img.src = url;
  });
}

/** Loads a library/cache file as an untainted image (via bytes -> blob URL). */
export async function loadImageFile(path) {
  const { api } = await import('./api.js');
  const buf = await api.readFile(path);
  const url = URL.createObjectURL(new Blob([buf]));
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export const canvasToPng = canvas => new Promise((res, rej) =>
  canvas.toBlob(b => (b ? b.arrayBuffer().then(buf => res(new Uint8Array(buf))) : rej(new Error('encode failed'))), 'image/png'));
