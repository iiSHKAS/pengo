// Pengo backend, evaluated as a function body by extension.js: `deps` holds the
// shell modules and the last statement returns the instance. Edit freely and call
// Reload (the app's "Reload logic" button, or on every app start).
//
// Flow: hotkey -> Start() FREEZES the screen (captures the stage to a texture and
// shows it full-screen, like ShareX), then shows a toolbar at the top. Tool
// "Select" captures (click = window under pointer, drag = free region). Every
// other tool draws an annotation in place. Blur / pixelate / smart-erase are
// computed live from the frozen frame's real pixels, so what you see is what
// gets saved; the app re-applies the same annotations to the final image.
const {Gio, GLib, Meta, St, Clutter, Shell, Main} = deps;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cogl = imports.gi.Cogl;
let Mtk = null;
try { Mtk = imports.gi.Mtk; } catch (e) { /* older Shell: native-scale capture unavailable, falls back */ }

const TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];
const MAX_MS = 5 * 60 * 1000;
const DRAG_PX = 5;
const DIM = 'background-color: rgba(0, 0, 0, 0.45);';

const TOOLS = [
    ['select', 'Select', 'Click a window, or drag an area, to capture it'],
    ['rect', 'Rectangle', 'Drag to draw a rectangle'],
    ['ellipse', 'Ellipse', 'Drag to draw an ellipse'],
    ['line', 'Line', 'Drag to draw a line'],
    ['arrow', 'Arrow', 'Drag to draw an arrow'],
    ['pen', 'Pen', 'Draw freehand'],
    ['highlight', 'Marker', 'Highlight text like a marker'],
    ['text', 'Text', 'Click where the text goes, type, press Enter'],
    ['step', 'Numbers', 'Click to drop numbered markers 1, 2, 3...'],
    ['blur', 'Blur', 'Drag over something to blur it'],
    ['pixelate', 'Pixelate', 'Drag over something to pixelate it'],
    ['erase', 'Smart eraser', 'Drag over text or an object to erase it using the surrounding colours'],
];
const EFFECTS = ['blur', 'pixelate', 'erase'];
const PALETTE = [
    [0.95, 0.23, 0.21], [1, 0.55, 0.0], [1, 0.84, 0.04], [0.2, 0.78, 0.35], [0.0, 0.74, 0.83],
    [0.2, 0.5, 1], [0.58, 0.35, 0.96], [0.96, 0.3, 0.66], [1, 1, 1], [0.1, 0.1, 0.12],
];
const WIDTHS = [2, 4, 6, 10];
const TEXT_SIZES = [['S', 18], ['M', 28], ['L', 44], ['XL', 72]];
const STRENGTHS = ['Low', 'Medium', 'High'];
const PIX_BLOCK = [8, 14, 22];   // logical px
const BLUR_RADIUS = [6, 12, 22]; // logical px
const TEXT_BGS = ['none', 'dark', 'light'];

const ACCENT = 'rgba(64, 140, 255, 1)';
const PANEL = 'background-color: rgba(24, 24, 28, 0.93); border-radius: 16px; padding: 6px 8px; ' +
              'border: 1px solid rgba(255, 255, 255, 0.09); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); spacing: 4px;';
const LABEL = 'color: rgba(255,255,255,0.72); font-size: 12px; font-weight: 600; padding: 0 4px;';

const rgb = c => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function hsv(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

// ------------------------------------------------------------------ icons
const TAU = 2 * Math.PI;
const ICONS = {
    select(cr) {
        cr.setLineWidth(1.6); cr.setDash([3, 2.5], 0); cr.rectangle(3.5, 3.5, 13, 13); cr.stroke(); cr.setDash([], 0);
        cr.moveTo(11, 11); cr.lineTo(19, 13.8); cr.lineTo(15.3, 15.3); cr.lineTo(13.8, 19); cr.closePath(); cr.fill();
    },
    rect(cr) { cr.setLineWidth(2); cr.rectangle(4, 5.5, 14, 11); cr.stroke(); },
    ellipse(cr) {
        cr.save(); cr.translate(11, 11); cr.scale(8, 6); cr.arc(0, 0, 1, 0, TAU); cr.restore();
        cr.setLineWidth(2); cr.stroke();
    },
    line(cr) { cr.setLineWidth(2); cr.setLineCap(1); cr.moveTo(4.5, 17.5); cr.lineTo(17.5, 4.5); cr.stroke(); },
    arrow(cr) {
        cr.setLineWidth(2); cr.setLineCap(1); cr.moveTo(4.5, 17.5); cr.lineTo(15, 7); cr.stroke();
        cr.moveTo(18.5, 3.5); cr.lineTo(11.5, 5.5); cr.lineTo(16.5, 10.5); cr.closePath(); cr.fill();
    },
    pen(cr) {
        cr.setLineWidth(2); cr.setLineCap(1);
        cr.moveTo(3, 14); cr.curveTo(6, 5, 9, 5, 11, 11); cr.curveTo(13, 17, 16, 17, 19, 8); cr.stroke();
    },
    highlight(cr) {
        cr.setLineWidth(1.8); cr.setLineCap(1); cr.setLineJoin(1);
        cr.moveTo(13.5, 3.5); cr.lineTo(19, 9); cr.lineTo(11.5, 16.5); cr.lineTo(6, 16.5); cr.lineTo(6, 11); cr.closePath(); cr.stroke();
        cr.moveTo(4, 20); cr.lineTo(18, 20); cr.stroke();
    },
    text(cr) { cr.selectFontFace('Sans', 0, 1); cr.setFontSize(19); cr.moveTo(4.2, 17.5); cr.showText('A'); },
    step(cr) {
        cr.arc(11, 11, 8.2, 0, TAU); cr.fill();
        cr.setOperator(0); cr.selectFontFace('Sans', 0, 1); cr.setFontSize(12); cr.moveTo(8.2, 15); cr.showText('1');
        cr.setOperator(2);
    },
    blur(cr) {
        for (const [r, a] of [[8.2, 0.22], [5.6, 0.4], [3, 0.95]]) {
            cr.setSourceRGBA(1, 1, 1, a); cr.arc(11, 11, r, 0, TAU); cr.fill();
        }
    },
    pixelate(cr) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            cr.setSourceRGBA(1, 1, 1, (i + j) % 2 ? 0.4 : 0.95);
            cr.rectangle(3.5 + i * 5.2, 3.5 + j * 5.2, 4.4, 4.4); cr.fill();
        }
    },
    erase(cr) {
        cr.save(); cr.translate(11, 11); cr.rotate(-0.75);
        cr.setLineWidth(1.8); cr.rectangle(-8, -4.5, 16, 9); cr.stroke();
        cr.rectangle(0, -4.5, 8, 9); cr.fill(); cr.restore();
    },
    undo(cr) {
        cr.moveTo(3.5, 9); cr.lineTo(9, 4); cr.lineTo(9, 14); cr.closePath(); cr.fill();
        cr.setLineWidth(2); cr.setLineCap(1); cr.moveTo(8, 9); cr.curveTo(19, 6, 20, 17.5, 11.5, 17.5); cr.stroke();
    },
    redo(cr) { cr.translate(22, 0); cr.scale(-1, 1); ICONS.undo(cr); },
    close(cr) {
        cr.setLineWidth(2); cr.setLineCap(1);
        cr.moveTo(6, 6); cr.lineTo(16, 16); cr.moveTo(16, 6); cr.lineTo(6, 16); cr.stroke();
    },
};

// --------------------------------------------------------- pixel effects
// Inputs are RGBA byte arrays; outputs are RGBA byte arrays of the inner rect.
function boxBlur(src, w, h, r, passes) {
    const n = w * h * 4;
    let a = Float32Array.from(src.subarray(0, n)), b = new Float32Array(n);
    const div = 2 * r + 1;
    for (let p = 0; p < passes; p++) {
        for (let y = 0; y < h; y++) {                       // horizontal
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
        for (let x = 0; x < w; x++) {                       // vertical
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

// Blur on a downsampled copy of the padded region. Returns the small blurred image; the GPU
// scales it back up with linear filtering, which costs the CPU nothing (a CPU upscale of a
// screen-sized region took ~100 ms and made dragging stutter).
function effectBlur(src, pw, ph, radius) {
    const f = Math.max(2, Math.round(radius * 0.7));
    const sw = Math.ceil(pw / f), sh = Math.ceil(ph / f);
    const small = new Uint8Array(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y * f; yy < Math.min(ph, y * f + f); yy++) {
            let i = (yy * pw + x * f) * 4;
            for (let xx = x * f; xx < Math.min(pw, x * f + f); xx++, i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
        }
        const d = (y * sw + x) * 4; small[d] = r / n; small[d + 1] = g / n; small[d + 2] = b / n; small[d + 3] = 255;
    }
    const blurred = boxBlur(small, sw, sh, Math.max(1, Math.round(radius / f)), 3);
    const out = new Uint8Array(sw * sh * 4);
    for (let i = 0; i < out.length; i++) out[i] = blurred[i];
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return {arr: out, w: sw, h: sh, f};
}

function effectPixelate(src, pw, ph, ox, oy, iw, ih, block) {
    const out = new Uint8Array(iw * ih * 4);
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

// Smart eraser. Looks at a ring of pixels just outside the rectangle:
//  * if one colour clearly dominates (a flat background - white page, dark UI...), fill with
//    exactly that colour, so nothing shows that something was erased;
//  * otherwise (gradients, photos) blend the per-side *median* colours across the area -
//    medians ignore stray text/pixels that touch the ring, unlike a mean.
// `has` says which sides actually have pixels outside the rectangle.
function effectErase(src, pw, ph, ox, oy, iw, ih, has) {
    const RING = 6, TOL = 14;
    const fill = (r, g, b) => {
        const out = new Uint8Array(iw * ih * 4);
        for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
        return out;
    };
    // ---- ring statistics
    const ring = [];
    for (let y = Math.max(0, oy - RING); y < Math.min(ph, oy + ih + RING); y++) {
        const inside = y >= oy && y < oy + ih;
        for (let x = Math.max(0, ox - RING); x < Math.min(pw, ox + iw + RING); x++) {
            if (inside && x >= ox && x < ox + iw) { x = ox + iw - 1; continue; }   // skip the interior
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
    if (m / n >= 0.5) return fill(Math.round(sr / m), Math.round(sg / m), Math.round(sb / m));

    // ---- gradient / textured surroundings
    const depth = 4;
    const px = (x, y) => {
        const s = (clamp(y, 0, ph - 1) * pw + clamp(x, 0, pw - 1)) * 4;
        return [src[s], src[s + 1], src[s + 2]];
    };
    const median = cols => [0, 1, 2].map(c => {
        const v = cols.map(p => p[c]).sort((a, b) => a - b);
        return v[v.length >> 1];
    });
    const lerp = (a, b, t) => !a ? b : !b ? a : [0, 1, 2].map(i => a[i] * (1 - t) + b[i] * t);
    const gx = Math.min(iw, 48), gy = Math.min(ih, 48);
    const strip = (fn) => median([...Array(depth).keys()].map(fn));
    const top = [], bottom = [], left = [], right = [];
    for (let i = 0; i < gx; i++) {
        const x = ox + Math.floor((i + 0.5) * iw / gx);
        top.push(has.top ? strip(k => px(x, oy - 1 - k)) : null);
        bottom.push(has.bottom ? strip(k => px(x, oy + ih + k)) : null);
    }
    for (let j = 0; j < gy; j++) {
        const y = oy + Math.floor((j + 0.5) * ih / gy);
        left.push(has.left ? strip(k => px(ox - 1 - k, y)) : null);
        right.push(has.right ? strip(k => px(ox + iw + k, y)) : null);
    }
    const mean2 = parts => [0, 1, 2].map(c => parts.reduce((a, p) => a + p[c], 0) / parts.length);
    const grid = [];
    for (let j = 0; j < gy; j++) {
        const ty = (j + 0.5) / gy, row = [];
        for (let i = 0; i < gx; i++) {
            const tx = (i + 0.5) / gx;
            const parts = [lerp(left[j], right[j], tx), lerp(top[i], bottom[i], ty)].filter(Boolean);
            row.push(parts.length ? mean2(parts) : [255, 255, 255]);
        }
        grid.push(row);
    }
    const out = new Uint8Array(iw * ih * 4);
    for (let y = 0; y < ih; y++) {
        const fy = clamp((y + 0.5) * gy / ih - 0.5, 0, gy - 1), j0 = Math.floor(fy), j1 = Math.min(j0 + 1, gy - 1), wy = fy - j0;
        for (let x = 0; x < iw; x++) {
            const fx = clamp((x + 0.5) * gx / iw - 0.5, 0, gx - 1), i0 = Math.floor(fx), i1 = Math.min(i0 + 1, gx - 1), wx = fx - i0;
            const d = (y * iw + x) * 4;
            for (let c = 0; c < 3; c++) {
                const a = grid[j0][i0][c] * (1 - wx) + grid[j0][i1][c] * wx;
                const b = grid[j1][i0][c] * (1 - wx) + grid[j1][i1][c] * wx;
                out[d + c] = a * (1 - wy) + b * wy;
            }
            out[d + 3] = 255;
        }
    }
    return out;
}

class Logic {
    constructor() {
        this._area = null;
        this._picked = null;
    }

    destroy() {
        this.Stop();
    }

    Toggle() {
        if (this._area) this.Stop();
        else this.Start();
    }

    IsActive() {
        return !!this._area || !!this._starting;
    }

    // True while a finished (or still being written) pick waits for the app to collect it.
    HasPick() {
        return !!this._pending || !!this._picked;
    }

    // Instant captures (no overlay): the window under the pointer / the monitor holding it.
    CaptureWindow() { this._quick('window'); }
    CaptureScreen() { this._quick('screen'); }

    _quick(kind) {
        if (this._area || this._starting || this._pending) return;
        const [px, py] = global.get_pointer();
        let pick;
        if (kind === 'window') {
            const h = this._findIn(this._windows(), px, py);
            if (!h.found) return;
            pick = {title: h.title, app: h.app || 'window', x: h.x, y: h.y, w: h.w, h: h.h};
        } else {
            const mons = Main.layoutManager.monitors;
            const m = mons.find(m => px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height) ?? Main.layoutManager.primaryMonitor;
            pick = {title: 'screen', app: 'screen', x: m.x, y: m.y, w: m.width, h: m.height};
        }
        this._t0 = GLib.get_monotonic_time();
        this._anns = []; this._content = this._texture = null;
        if (this._finishPick(pick)) return;   // painted at the monitor's own scale: sharp, no resampling
        // Fallback: whole-stage screenshot (rendered at the largest monitor scale).
        this._starting = true;
        this._cancelStart = false;
        try {
            new Shell.Screenshot().screenshot_stage_to_content((obj, res) => {
                this._starting = false;
                this._tFrame = GLib.get_monotonic_time();
                try {
                    const r = obj.screenshot_stage_to_content_finish(res);
                    this._content = r[0];
                    this._texture = r[0].get_texture();
                    this._scale = r[1];
                    this._anns = [];
                    this._finishPick(pick);
                } catch (e) {
                    console.error(`[winprobe] quick capture failed: ${e}\n${e.stack}`);
                }
            });
        } catch (e) {
            this._starting = false;
            console.error(`[winprobe] quick capture threw: ${e}\n${e.stack}`);
        }
    }

    Start() {
        if (this._area || this._starting) return;
        this._starting = true;
        this._cancelStart = false;
        try {
            // Capture BEFORE adding any of our own actors, so the frame is the plain desktop.
            new Shell.Screenshot().screenshot_stage_to_content((obj, res) => {
                try {
                    const r = obj.screenshot_stage_to_content_finish(res);
                    this._onFrame(r[0], r[1]);
                } catch (e) {
                    this._starting = false;
                    console.error(`[winprobe] capture failed: ${e}\n${e.stack}`);
                }
            });
        } catch (e) {
            this._starting = false;
            console.error(`[winprobe] screenshot_stage_to_content threw: ${e}\n${e.stack}`);
        }
    }

    _onFrame(content, scale) {
        this._starting = false;
        if (this._cancelStart) return;
        const W = global.stage.width, H = global.stage.height;
        this._content = content;
        this._texture = content.get_texture();
        this._scale = scale;
        this._windowsSnap = this._windows();
        this._press = null;
        this._drag = null;
        this._hit = null;
        this._phase = 0;
        this._tool = 'select';
        this._o = {color: PALETTE[0], width: 4, textSize: 28, bold: false, textBg: 'none', strength: 1};
        this._anns = [];
        this._redo = [];
        this._cur = null;
        this._entry = null;
        this._picker = null;
        this._uiDirty = true;
        this._hintText = '';
        this._px = null;
        this._lastFx = 0;
        this._edgeSize = '';

        // The frozen desktop. Everything below sits on top of it and nothing else is reachable.
        this._frame = new Clutter.Actor({x: 0, y: 0, width: W, height: H, content,
            content_gravity: Clutter.ContentGravity.RESIZE_FILL, reactive: false});
        Main.uiGroup.add_child(this._frame);
        // Dim = four GPU-composited strips around the selection (no per-frame CPU fill).
        this._dim = [0, 1, 2, 3].map(() => {
            const w = new St.Widget({style: DIM, reactive: false, visible: false});
            Main.uiGroup.add_child(w);
            return w;
        });
        // Selection outline: a tint, a label and four thin animated edges. Four tiny surfaces
        // instead of one window-sized one keeps the marching dashes cheap on big windows.
        this._antTint = new St.Widget({style: 'background-color: transparent;', reactive: false, visible: false});
        this._antLabel = new St.Label({reactive: false, visible: false, style:
            'color: white; font-size: 13px; font-weight: 700; background-color: rgba(0,0,0,0.8); ' +
            'padding: 3px 8px; border-radius: 4px;'});
        this._antEdges = ['t', 'b', 'l', 'r'].map(side => {
            const e = new St.DrawingArea({reactive: false, visible: false});
            e.connect('repaint', area => this._paintEdge(area, side));
            return e;
        });
        for (const actor of [this._antTint, ...this._antEdges, this._antLabel]) Main.uiGroup.add_child(actor);
        // Invisible full-desktop widget that owns input (and hosts the toolbar).
        this._area = new St.Widget({reactive: true, can_focus: true, x: 0, y: 0, width: W, height: H});
        this._area.connect('key-press-event', (_a, ev) => this._onKey(ev));
        this._area.connect('button-press-event', (_a, ev) => this._onPress(ev));
        this._area.connect('button-release-event', (_a, ev) => this._onRelease(ev));
        this._area.connect('scroll-event', (_a, ev) => this._onScroll(ev));
        Main.uiGroup.add_child(this._area);

        this._ui = new St.BoxLayout({vertical: true, reactive: true, style: 'spacing: 8px;'});
        this._bar = new St.BoxLayout({style: PANEL, x_align: Clutter.ActorAlign.CENTER});
        this._opts = new St.BoxLayout({style: PANEL, x_align: Clutter.ActorAlign.CENTER});
        this._hintLabel = new St.Label({x_align: Clutter.ActorAlign.CENTER, style:
            'color: white; font-size: 12px; font-weight: 600; background-color: rgba(24,24,28,0.85); ' +
            'border-radius: 10px; padding: 4px 12px;'});
        this._ui.add_child(this._bar);
        this._ui.add_child(this._opts);
        this._ui.add_child(this._hintLabel);
        this._area.add_child(this._ui);

        // The modal grab delivers keys/clicks to us. ActionMode.ALL keeps keybindings
        // (the Ctrl+Shift+E toggle) alive.
        try {
            this._grab = Main.pushModal(this._area, {actionMode: Shell.ActionMode.ALL});
            this._area.grab_key_focus();
        } catch (e) {
            console.error(`[winprobe] pushModal failed: ${e}`);
            this._grab = null;
        }
        this._loadPixels();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._stopTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MAX_MS, () => {
            this._stopTimer = 0;
            this.Stop();
            return GLib.SOURCE_REMOVE;
        });
    }

    Stop() {
        this._cancelStart = true;
        if (this._grab) {
            try { Main.popModal(this._grab); } catch (e) { console.error(`[winprobe] popModal failed: ${e}`); }
            this._grab = null;
        }
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._stopTimer) { GLib.source_remove(this._stopTimer); this._stopTimer = 0; }
        for (const a of [...(this._anns ?? []), ...(this._redo ?? []), this._cur]) {
            if (a) { a.dead = true; a.actor?.destroy(); a.layer?.destroy(); a.actor = a.layer = null; }
        }
        for (const actor of [...(this._dim ?? []), this._antTint, ...(this._antEdges ?? []), this._antLabel,
                             this._area, this._frame])
            actor?.destroy();   // destroying _area takes the toolbar and any text entry with it
        this._dim = this._antTint = this._antEdges = this._antLabel = this._area = this._frame = null;
        this._px = null;
        this._ui = this._bar = this._opts = this._hintLabel = this._entry = this._picker = null;
        this._anns = []; this._redo = []; this._cur = null;
    }

    // Paints `pick` straight from the live scene at the scale of the monitor it sits on.
    // The frozen frame is rendered at the LARGEST monitor scale, so on mixed-scale setups a
    // 1x monitor would be upscaled by the compositor and later downscaled again: blurry.
    _paintNative(pick) {
        if (!Mtk || typeof global.stage.paint_to_content !== 'function') return null;
        try {
            const sw = global.stage.width, sh = global.stage.height;
            const x0 = clamp(Math.floor(pick.x), 0, sw), y0 = clamp(Math.floor(pick.y), 0, sh);
            const x1 = clamp(Math.ceil(pick.x + pick.w), 0, sw), y1 = clamp(Math.ceil(pick.y + pick.h), 0, sh);
            const w = x1 - x0, h = y1 - y0;
            if (w < 1 || h < 1) return null;
            const cx = x0 + w / 2, cy = y0 + h / 2;
            const mons = Main.layoutManager.monitors;
            let idx = mons.findIndex(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
            if (idx < 0) idx = Main.layoutManager.primaryIndex;
            const scale = global.display.get_monitor_scale(idx);
            const rect = new Mtk.Rectangle({x: x0, y: y0, width: w, height: h});
            const content = global.stage.paint_to_content(rect, scale, Clutter.PaintFlag?.NO_CURSORS ?? 0);
            return {content, texture: content.get_texture(), scale, ox: x0, oy: y0, w, h, via: 'native'};
        } catch (e) {
            console.error(`[winprobe] native paint failed, using the frozen frame: ${e}`);
            return null;
        }
    }

    // Writes the picked rectangle to a PNG, then publishes the pick. Returns false if there
    // was nothing to capture from.
    _finishPick(pick) {
        const frozen = this._texture
            ? {content: this._content, texture: this._texture, scale: this._scale, ox: 0, oy: 0, via: 'frozen'}
            : null;
        const annotations = (this._anns ?? []).map(a => this._export(a));
        this._content = null;
        this.Stop();   // the frozen frame and UI go away at once; saving continues in the background
        const src = this._paintNative(pick) ?? frozen;
        if (!src) return false;
        if (src.via === 'native') pick = {...pick, x: src.ox, y: src.oy, w: src.w, h: src.h};
        const {texture, scale, content} = src;
        this._tFrame = GLib.get_monotonic_time();
        this._pending = true;
        console.log(`[winprobe] _finishPick ${JSON.stringify(pick)} scale=${scale} via=${src.via}`);
        try {
            const tx = Math.max(0, Math.floor((pick.x - src.ox) * scale));
            const ty = Math.max(0, Math.floor((pick.y - src.oy) * scale));
            const tw = Math.min(texture.get_width() - tx, Math.ceil(pick.w * scale));
            const th = Math.min(texture.get_height() - ty, Math.ceil(pick.h * scale));
            const path = `${GLib.get_tmp_dir()}/pengo-${GLib.get_monotonic_time()}.png`;
            const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
            Shell.Screenshot.composite_to_stream(texture, tx, ty, tw, th, scale, null, 0, 0, 1, stream, (_o, res) => {
                try {
                    Shell.Screenshot.composite_to_stream_finish(res);
                    stream.close(null);
                    this._picked = {...pick, path, scale, annotations, via: src.via, at: GLib.get_monotonic_time(),
                                    ms: this._t0 ? [Math.round((this._tFrame - this._t0) / 1000), Math.round((GLib.get_monotonic_time() - this._t0) / 1000)] : null};
                    this._t0 = null;
                    console.log(`[winprobe] picked set: ${path}`);
                } catch (e) {
                    console.error(`[winprobe] saving the capture failed: ${e}\n${e.stack}`);
                }
                this._pending = false;
                void content;   // keep the frame alive until the PNG is written
            });
        } catch (e) {
            console.error(`[winprobe] _finishPick threw: ${e}\n${e.stack}`);
            this._pending = false;
        }
        return true;
    }

    // Annotation as plain data for the app (drops live actors / caches).
    _export(a) {
        const {actor, layer, bx, by, busy, key, dirty, dead, sample, waiting, ...rest} = a;
        return rest;
    }

    // Hands the last pick to the client once. {pending:true} = still being written.
    TakePicked() {
        if (this._pending) return {valid: false, pending: true};
        const p = this._picked;
        this._picked = null;
        if (!p || GLib.get_monotonic_time() - p.at > 20_000_000) return {valid: false, pending: false};
        return {valid: true, x: p.x, y: p.y, w: p.w, h: p.h, title: p.title, app: p.app,
                scale: p.scale, path: p.path, annotations: p.annotations, ms: p.ms, via: p.via};
    }

    // Raise + focus a window by wm_class / app id substring. Wayland forbids apps from
    // stealing focus for themselves, but the Shell may focus anything.
    FocusWindow(needle) {
        const n = String(needle).toLowerCase();
        const actor = global.get_window_actors().find(a => {
            const w = a.meta_window;
            return (w.get_wm_class() || '').toLowerCase().includes(n) ||
                   (w.get_gtk_application_id?.() || '').toLowerCase().includes(n);
        });
        if (!actor) return false;
        const w = actor.meta_window;
        if (w.minimized) w.unminimize();
        Main.activateWindow(w);
        return true;
    }

    Query() {
        const [px, py] = global.get_pointer();
        return this._findIn(this._windows(), px, py);
    }

    // ---------------------------------------------------------- self-test
    // Dev aid: drives the real UI with a virtual pointer (moves the cursor for ~10 s)
    // and records what happened. Run: Call SelfTest, wait, then Call TestLog.
    SelfTest() {
        this._testLog = [];
        const log = m => { this._testLog.push(m); console.log(`[winprobe-test] ${m}`); };
        if (this.IsActive()) return 'already active';
        const seat = Clutter.get_default_backend().get_default_seat();
        const dev = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const [ox, oy] = global.get_pointer();
        const m = Main.layoutManager.primaryMonitor;
        const cx = m.x + Math.round(m.width / 2), cy = m.y + Math.round(m.height / 2);
        const now = () => GLib.get_monotonic_time();
        const move = (x, y) => dev.notify_absolute_motion(now(), x, y);
        const press = () => dev.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        const release = () => dev.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        const drag = (x0, y0, x1, y1) => [() => move(x0, y0), () => press(), () => move((x0 + x1) / 2, (y0 + y1) / 2),
                                          () => move(x1, y1), () => release()];
        const effect = tool => [
            () => { this._setTool(tool); },
            ...drag(cx - 120, cy - 90, cx + 60, cy - 20),
            () => {},
            () => {},
            () => {
                const a = this._anns[this._anns.length - 1];
                log(`${tool}: annotation=${!!a} actor=${!!a?.actor} size=${a?.actor?.width}x${a?.actor?.height}`);
                const s = a?.sample;
                if (s) {
                    let sum = 0;
                    for (let i = 0; i < s.arr.length; i += 4) sum += s.arr[i] + s.arr[i + 1] + s.arr[i + 2];
                    log(`${tool}: result ${s.iw}x${s.ih} mean=${(sum / (s.arr.length / 4 * 3)).toFixed(1)} px0=${[...s.arr.slice(0, 4)]}`);
                    if (tool === 'pixelate') {
                        const B = s.block;
                        log(`pixelate block ${B}: constant within block = ${s.arr[0] === s.arr[(B - 1) * 4] && s.arr[1] === s.arr[(B - 1) * 4 + 1]}`);
                    }
                }
            },
        ];
        const steps = [
            () => { this.Start(); log('Start() called'); },
            () => {
                log(`frozen frame up: area=${!!this._area} frame=${!!this._frame} grab=${!!this._grab} scale=${this._scale}`);
                if (!this._area) return false;
                const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, cx, cy);
                const ok = hit === this._area || this._area.contains(hit);
                log(`actor under pointer is our input area: ${ok}`);
                if (!ok) return false;   // never click if it could reach a real window
            },
            () => {},
            () => {},
            () => log(`pixels ready=${!!this._px} ${this._px ? this._px.w + 'x' + this._px.h + ' nch=' + this._px.nch : ''}`),
            ...effect('pixelate'),
            ...effect('blur'),
            ...effect('erase'),
            () => {
                this._setTool('text');
                log(`options panel children=${this._opts.get_n_children()} bar children=${this._bar.get_n_children()}`);
                this._undo(); this._undo(); this._undo();
                log(`after 3 undos: ${this._anns.length}, redo stack ${this._redo.length}`);
                this._redoOne();
                log(`after redo: ${this._anns.length}`);
                this.Stop();
                log(`stopped: active=${this.IsActive()}`);
            },
        ];
        let i = 0;
        const runNext = () => {
            if (i >= steps.length) { move(ox, oy); log('DONE'); return GLib.SOURCE_REMOVE; }
            let ok;
            try { ok = steps[i++](); } catch (e) { log(`step ${i} threw: ${e}\n${e.stack}`); ok = false; }
            if (ok === false) { this.Stop(); move(ox, oy); log('ABORTED'); return GLib.SOURCE_REMOVE; }
            return GLib.SOURCE_CONTINUE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, runNext);
        return 'started';
    }

    // Dev aid: time one live-preview update per effect on regions of increasing size.
    Bench() {
        this._testLog = [];
        const log = m => { this._testLog.push(m); console.log(`[winprobe-test] ${m}`); };
        this.Start();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            if (!this._px) { log('pixels not ready'); this.Stop(); return GLib.SOURCE_REMOVE; }
            for (const [w, h] of [[300, 200], [800, 500], [1600, 900]]) {
                for (const type of EFFECTS) {
                    const a = {type, strength: 1, pts: [[100, 100], [100 + w, 100 + h]], key: null};
                    const t0 = GLib.get_monotonic_time();
                    this._ensurePreview(a, true);
                    const ms = (GLib.get_monotonic_time() - t0) / 1000;
                    log(`${type} ${w}x${h}: ${ms.toFixed(1)} ms`);
                    a.actor?.destroy();
                }
            }
            this.Stop();
            log('DONE');
            return GLib.SOURCE_REMOVE;
        });
        return 'started';
    }

    TestLog() {
        return this._testLog ?? [];
    }

    // ------------------------------------------------------------ toolbar

    _btnStyle(active, hover) {
        return `padding: 7px; border-radius: 10px; background-color: ${active ? ACCENT : hover ? 'rgba(255,255,255,0.13)' : 'transparent'};`;
    }

    // A flat icon button; `draw(cr)` paints a 22x22 white glyph.
    _iconButton(draw, name, hint, onClick, active = false) {
        const icon = new St.DrawingArea({width: 22, height: 22});
        icon.connect('repaint', a => {
            const cr = a.get_context();
            cr.setSourceRGBA(1, 1, 1, 0.95);
            draw(cr);
            cr.$dispose();
        });
        const btn = new St.Button({child: icon, reactive: true, can_focus: false, track_hover: true,
                                   style: this._btnStyle(active, false)});
        btn.connect('clicked', onClick);
        btn.connect('notify::hover', () => {
            btn.set_style(this._btnStyle(active, btn.hover));
            this._setHint(btn.hover ? `${name} — ${hint}` : '');
        });
        return btn;
    }

    _textButton(label, onClick, active = false) {
        const btn = new St.Button({label, reactive: true, can_focus: false, track_hover: true,
            style: `color: white; font-size: 13px; font-weight: 700; padding: 5px 10px; border-radius: 9px; ` +
                   `background-color: ${active ? ACCENT : 'rgba(255,255,255,0.08)'};`});
        btn.connect('clicked', onClick);
        return btn;
    }

    _separator() {
        return new St.Widget({width: 1, style: 'background-color: rgba(255,255,255,0.16); margin: 6px 6px;'});
    }

    _spacer() {
        return new St.Widget({width: 4});
    }

    _swatch(color, selected, onClick) {
        const b = new St.Button({reactive: true, can_focus: false, track_hover: true, width: 22, height: 22,
            style: `background-color: ${rgb(color)}; border-radius: 12px; margin: 3px 2px; ` +
                   `border: ${selected ? '3px solid white' : '2px solid rgba(255,255,255,0.28)'};`});
        b.connect('clicked', onClick);
        return b;
    }

    // Rebuilds the toolbar + the context-sensitive options row from the current state.
    _rebuildUi() {
        if (!this._bar) return;
        this._bar.destroy_all_children();
        for (const [id, name, hint] of TOOLS) {
            this._bar.add_child(this._iconButton(ICONS[id], name, hint, () => this._setTool(id), id === this._tool));
            if (id === 'select' || id === 'arrow' || id === 'text') this._bar.add_child(this._separator());
        }
        this._bar.add_child(this._separator());
        this._bar.add_child(this._iconButton(ICONS.undo, 'Undo', 'Ctrl+Z', () => this._undo()));
        this._bar.add_child(this._iconButton(ICONS.redo, 'Redo', 'Ctrl+Shift+Z', () => this._redoOne()));
        this._bar.add_child(this._iconButton(ICONS.close, 'Cancel', 'Esc', () => this.Stop()));

        this._opts.destroy_all_children();
        const t = this._tool, o = this._o;
        const colorTools = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight', 'text', 'step'];
        if (colorTools.includes(t)) {
            for (const c of PALETTE) {
                this._opts.add_child(this._swatch(c, c === o.color, () => this._setColor(c)));
            }
            const custom = this._iconButton(c => {
                c.setLineWidth(2); c.setLineCap(1);
                c.moveTo(11, 5); c.lineTo(11, 17); c.moveTo(5, 11); c.lineTo(17, 11); c.stroke();
            }, 'Custom colour', 'Pick any colour', () => this._togglePicker(), !!this._picker);
            this._opts.add_child(custom);
            this._opts.add_child(this._separator());
        }
        if (['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlight', 'step'].includes(t)) {
            this._opts.add_child(new St.Label({text: 'Thickness', style: LABEL, y_align: Clutter.ActorAlign.CENTER}));
            for (const w of WIDTHS) {
                const on = w === o.width;
                const icon = new St.DrawingArea({width: 26, height: 22});
                icon.connect('repaint', a => {
                    const cr = a.get_context();
                    cr.setSourceRGBA(1, 1, 1, 0.95); cr.setLineCap(1); cr.setLineWidth(Math.min(w, 9));
                    cr.moveTo(5, 11); cr.lineTo(21, 11); cr.stroke(); cr.$dispose();
                });
                const b = new St.Button({child: icon, reactive: true, can_focus: false, track_hover: true,
                                         style: this._btnStyle(on, false)});
                b.connect('clicked', () => { this._o.width = w; this._uiDirty = true; });
                this._opts.add_child(b);
            }
        } else if (t === 'text') {
            this._opts.add_child(new St.Label({text: 'Size', style: LABEL, y_align: Clutter.ActorAlign.CENTER}));
            this._opts.add_child(this._textButton('−', () => this._setTextSize(o.textSize - 2)));
            this._opts.add_child(new St.Label({text: `${o.textSize}`, y_align: Clutter.ActorAlign.CENTER,
                style: 'color: white; font-size: 14px; font-weight: 700; min-width: 30px; text-align: center;'}));
            this._opts.add_child(this._textButton('+', () => this._setTextSize(o.textSize + 2)));
            for (const [label, v] of TEXT_SIZES)
                this._opts.add_child(this._textButton(label, () => this._setTextSize(v), o.textSize === v));
            this._opts.add_child(this._separator());
            this._opts.add_child(this._textButton('B', () => { o.bold = !o.bold; this._restyleEntry(); this._uiDirty = true; }, o.bold));
            this._opts.add_child(new St.Label({text: 'Background', style: LABEL, y_align: Clutter.ActorAlign.CENTER}));
            for (const bg of TEXT_BGS)
                this._opts.add_child(this._textButton(bg === 'none' ? 'None' : bg === 'dark' ? 'Dark' : 'Light',
                    () => { o.textBg = bg; this._uiDirty = true; }, o.textBg === bg));
        } else if (t === 'blur' || t === 'pixelate') {
            this._opts.add_child(new St.Label({text: 'Strength', style: LABEL, y_align: Clutter.ActorAlign.CENTER}));
            STRENGTHS.forEach((label, i) => this._opts.add_child(this._textButton(label, () => {
                o.strength = i;
                for (const a of this._anns) if (a.type === t) { a.strength = i; a.key = null; this._ensurePreview(a); }
                this._uiDirty = true;
            }, o.strength === i)));
        }
        this._setHint('');

        // Re-centre on the primary monitor once the natural width is known.
        const m = Main.layoutManager.primaryMonitor;
        const [, natBar] = this._bar.get_preferred_width(-1);
        const [, natOpts] = this._opts.get_preferred_width(-1);
        const [, natHint] = this._hintLabel.get_preferred_width(-1);
        const nat = Math.max(natBar, natOpts, natHint);
        this._ui.set_position(Math.round(m.x + (m.width - nat) / 2), m.y + 14);
        this._ui.set_width(nat);
        if (this._picker) this._placePicker();
    }

    _setHint(text) {
        this._hintText = text;
        this._hintLabel?.set_text(text || TOOLS.find(x => x[0] === this._tool)[2]);
    }

    _setColor(c) {
        this._o.color = c;
        if (this._entry) this._entry.color = c;
        this._restyleEntry();
        this._uiDirty = true;
    }

    _setTextSize(v) {
        this._o.textSize = clamp(v, 8, 160);
        this._restyleEntry();
        this._uiDirty = true;
    }

    _setTool(id) {
        this._commitText(false);
        if (this._cur) { this._cur.dead = true; this._cur.actor?.destroy(); this._cur.layer?.destroy(); }
        this._cur = null;
        this._press = null;
        this._drag = null;
        this._tool = id;
        this._closePicker();
        this._uiDirty = true;
    }

    _undo() {
        const a = this._anns.pop();
        if (a) {
            a.actor?.hide();
            a.layer?.hide();
            this._redo.push(a);
        }
    }

    _redoOne() {
        const a = this._redo.pop();
        if (a) {
            a.actor?.show();
            a.layer?.show();
            this._anns.push(a);
        }
    }

    _pushAnn(a) {
        this._anns.push(a);
        for (const r of this._redo) { r.dead = true; r.actor?.destroy(); r.layer?.destroy(); }
        this._redo = [];
        if (!a.layer && !EFFECTS.includes(a.type)) this._touch(a);
    }

    // ------------------------------------------------- per-annotation layers
    // Each shape owns a small surface sized to its own bounding box, so drawing or
    // dragging never repaints the desktop-sized area (that was the stutter).

    _bbox(a) {
        const pad = 14 + (a.width ?? 4) * (a.type === 'highlight' ? 3 : 1);
        if (a.type === 'text') {
            const lines = a.text.split('\n');
            const w = Math.max(...lines.map(l => l.length)) * a.size * 0.8 + 40;
            return {x: Math.floor(a.pts[0][0] - 14), y: Math.floor(a.pts[0][1] - 10),
                    w: Math.ceil(w), h: Math.ceil(lines.length * a.size * 1.3 + 26)};
        }
        if (a.type === 'step') {
            const r = a.r + 6;
            return {x: Math.floor(a.pts[0][0] - r), y: Math.floor(a.pts[0][1] - r), w: Math.ceil(r * 2), h: Math.ceil(r * 2)};
        }
        const xs = a.pts.map(p => p[0]), ys = a.pts.map(p => p[1]);
        const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
        return {x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(Math.max(...xs) + pad - x0), h: Math.ceil(Math.max(...ys) + pad - y0)};
    }

    _touch(a) {
        if (!this._area) return;
        if (!a.layer) {
            a.layer = new St.DrawingArea({reactive: false});
            a.layer.connect('repaint', area => {
                const cr = area.get_context();
                cr.translate(-a.bx, -a.by);
                this._drawAnn(cr, a);
                cr.$dispose();
            });
            Main.uiGroup.insert_child_below(a.layer, this._dim[0]);
        }
        const b = this._bbox(a);
        a.bx = b.x; a.by = b.y;
        a.layer.set_position(b.x, b.y);
        a.layer.set_size(Math.max(1, b.w), Math.max(1, b.h));
        a.layer.queue_repaint();
    }

    // ------------------------------------------------------ colour picker

    _togglePicker() {
        if (this._picker) this._closePicker();
        else this._openPicker();
        this._uiDirty = true;
    }

    _closePicker() {
        this._picker?.destroy();
        this._picker = null;
    }

    _openPicker() {
        const W = 232, SVH = 140, HH = 16, STEP = 2;
        const box = new St.BoxLayout({vertical: true, reactive: true, style: PANEL + ' padding: 10px; spacing: 10px;'});
        const sv = new St.DrawingArea({width: W, height: SVH, reactive: true});
        const hueBar = new St.DrawingArea({width: W, height: HH, reactive: true});

        // Current position (hue / saturation / value) from the active colour.
        const [r0, g0, b0] = this._o.color;
        const mx = Math.max(r0, g0, b0), mn = Math.min(r0, g0, b0), d = mx - mn;
        let hh = 0;
        if (d > 0) {
            hh = mx === r0 ? ((g0 - b0) / d + 6) % 6 : mx === g0 ? (b0 - r0) / d + 2 : (r0 - g0) / d + 4;
            hh /= 6;
        }
        const st = {h: hh, s: mx ? d / mx : 0, v: mx};

        const ring = (cr, x, y, rad) => {
            cr.setLineWidth(3); cr.setSourceRGBA(0, 0, 0, 0.55); cr.arc(x, y, rad, 0, TAU); cr.stroke();
            cr.setLineWidth(2); cr.setSourceRGBA(1, 1, 1, 1); cr.arc(x, y, rad, 0, TAU); cr.stroke();
        };
        sv.connect('repaint', a => {
            const cr = a.get_context();
            for (let y = 0; y < SVH; y += STEP) for (let x = 0; x < W; x += STEP) {
                const [r, g, b] = hsv(st.h, x / (W - 1), 1 - y / (SVH - 1));
                cr.setSourceRGBA(r, g, b, 1); cr.rectangle(x, y, STEP, STEP); cr.fill();
            }
            ring(cr, st.s * (W - 1), (1 - st.v) * (SVH - 1), 6);
            cr.$dispose();
        });
        hueBar.connect('repaint', a => {
            const cr = a.get_context();
            for (let x = 0; x < W; x += STEP) {
                const [r, g, b] = hsv(x / W, 1, 1);
                cr.setSourceRGBA(r, g, b, 1); cr.rectangle(x, 0, STEP, HH); cr.fill();
            }
            const hx = clamp(st.h * W, 4, W - 4);
            cr.setSourceRGBA(0, 0, 0, 0.55); cr.setLineWidth(5); cr.moveTo(hx, 0); cr.lineTo(hx, HH); cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 1); cr.setLineWidth(3); cr.moveTo(hx, 0); cr.lineTo(hx, HH); cr.stroke();
            cr.$dispose();
        });

        const apply = () => { this._setColor(hsv(st.h, st.s, st.v)); sv.queue_repaint(); hueBar.queue_repaint(); };
        const drag = (actor, fn) => {
            let down = false;
            const at = ev => {
                const [x, y] = ev.get_coords();
                const [ok, lx, ly] = actor.transform_stage_point(x, y);
                if (ok) fn(lx, ly);
            };
            actor.connect('button-press-event', (_a, ev) => { down = true; at(ev); return Clutter.EVENT_STOP; });
            actor.connect('motion-event', (_a, ev) => { if (down) at(ev); return Clutter.EVENT_STOP; });
            actor.connect('button-release-event', () => { down = false; return Clutter.EVENT_STOP; });
            actor.connect('leave-event', () => { down = false; return Clutter.EVENT_PROPAGATE; });
        };
        drag(sv, (x, y) => { st.s = clamp(x / (W - 1), 0, 1); st.v = 1 - clamp(y / (SVH - 1), 0, 1); apply(); });
        drag(hueBar, x => { st.h = clamp(x / W, 0, 0.9999); apply(); });

        box.add_child(sv);
        box.add_child(hueBar);
        this._picker = box;
        this._area.add_child(box);
        this._placePicker();
    }

    _placePicker() {
        const [x, y] = this._ui.get_transformed_position();
        const [, h] = this._ui.get_preferred_height(-1);
        this._picker.set_position(Math.round(x + 14), Math.round(y + h + 8));
    }

    // True when the event landed on the toolbar / picker (their buttons handle themselves).
    // ev.get_source() is null for stage-level pointer events, so hit-test instead.
    _overUi(ev) {
        const [x, y] = ev.get_coords();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (!actor) return false;
        return [this._ui, this._picker].some(w => w && (actor === w || w.contains(actor)));
    }

    // ------------------------------------------------------------- input

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        const ctrl = !!(ev.get_state() & Clutter.ModifierType.CONTROL_MASK);
        const shift = !!(ev.get_state() & Clutter.ModifierType.SHIFT_MASK);
        if (sym === Clutter.KEY_Escape) {
            if (this._picker) this._closePicker(), this._uiDirty = true;
            else this.Stop();
            return Clutter.EVENT_STOP;
        }
        const code = ev.get_key_code();   // physical key, so shortcuts also work on non-Latin layouts (e.g. Arabic)
        const isZ = sym === Clutter.KEY_z || sym === Clutter.KEY_Z || code === 52;
        const isY = sym === Clutter.KEY_y || sym === Clutter.KEY_Y || code === 29;
        if (ctrl && isZ) {
            if (shift) this._redoOne(); else this._undo();
            return Clutter.EVENT_STOP;
        }
        if (ctrl && isY) {
            this._redoOne();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Wheel: text size while writing text, thickness / strength otherwise.
    _onScroll(ev) {
        const dir = ev.get_scroll_direction();
        const up = dir === Clutter.ScrollDirection.UP, down = dir === Clutter.ScrollDirection.DOWN;
        if (!up && !down) return Clutter.EVENT_PROPAGATE;
        const o = this._o, d = up ? 1 : -1;
        if (this._tool === 'text') this._setTextSize(o.textSize + 2 * d);
        else if (['blur', 'pixelate'].includes(this._tool)) { o.strength = clamp(o.strength + d, 0, 2); this._uiDirty = true; }
        else {
            const i = clamp(WIDTHS.indexOf(o.width) + d, 0, WIDTHS.length - 1);
            o.width = WIDTHS[i];
            this._uiDirty = true;
        }
        return Clutter.EVENT_STOP;
    }

    _onPress(ev) {
        if (this._overUi(ev)) return Clutter.EVENT_PROPAGATE;
        if (this._picker) { this._closePicker(); this._uiDirty = true; }
        if (ev.get_button() !== Clutter.BUTTON_PRIMARY) {
            this.Stop();
            return Clutter.EVENT_STOP;
        }
        const [px, py] = global.get_pointer();
        this._commitText(true);
        const o = this._o;
        if (this._tool === 'select') {
            this._press = {x: px, y: py};
        } else if (this._tool === 'text') {
            this._beginText(px, py);
        } else if (this._tool === 'step') {
            const n = this._anns.filter(a => a.type === 'step').length + 1;
            this._pushAnn({type: 'step', color: o.color, width: o.width, pts: [[px, py]], n, r: 11 + o.width * 1.5});
        } else {
            this._press = {x: px, y: py};
            this._shiftOn = false; this._raw = this._anchor = this._axis = this._segEnd = null;
            const pts = (this._tool === 'pen' || this._tool === 'highlight') ? [[px, py]] : [[px, py], [px, py]];
            this._cur = {type: this._tool, color: o.color, width: o.width, strength: o.strength, pts};
            this._touch(this._cur);
        }
        return Clutter.EVENT_STOP;
    }

    _onRelease(ev) {
        if (this._overUi(ev) || ev.get_button() !== Clutter.BUTTON_PRIMARY || !this._press)
            return Clutter.EVENT_PROPAGATE;
        this._press = null;
        if (this._tool !== 'select') {
            const a = this._cur;
            this._cur = null;
            if (a) {
                const [p0] = a.pts, p1 = a.pts[a.pts.length - 1];
                const small = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 4;
                if (!small || a.type === 'pen' || a.type === 'highlight') {
                    if (EFFECTS.includes(a.type)) {
                        a.layer?.destroy();   // the dashed drag outline is not part of the result
                        a.layer = null;
                        this._pushAnn(a);
                        a.key = null;
                        this._ensurePreview(a, true);
                    } else {
                        this._pushAnn(a);
                        a.layer?.queue_repaint();
                    }
                } else {
                    a.actor?.destroy();
                    a.layer?.destroy();
                    a.dead = true;
                }
            }
            return Clutter.EVENT_STOP;
        }
        if (this._drag) {
            const d = this._drag;
            if (d.w < 4 || d.h < 4) { this.Stop(); return Clutter.EVENT_STOP; }
            this._finishPick({title: 'region', app: 'region', x: d.x, y: d.y, w: d.w, h: d.h});
        } else {
            const [px, py] = global.get_pointer();
            const h = this._findAt(px, py);
            if (h.found) this._finishPick({title: h.title, app: h.app, x: h.x, y: h.y, w: h.w, h: h.h});
            else this.Stop();
        }
        return Clutter.EVENT_STOP;
    }

    _entryStyle(e) {
        return `font-size: ${this._o.textSize}px; font-weight: ${this._o.bold ? 700 : 400}; color: ${rgb(e.color)}; ` +
               'background-color: rgba(0,0,0,0.30); border: 1px solid rgba(255,255,255,0.6); ' +
               'border-radius: 4px; padding: 2px 6px; min-width: 180px; caret-color: white;';
    }

    _restyleEntry() {
        if (this._entry) this._entry.actor.set_style(this._entryStyle(this._entry));
    }

    _beginText(x, y) {
        const entry = {color: this._o.color, x, y};
        entry.actor = new St.Entry({can_focus: true, style: this._entryStyle(entry)});
        entry.actor.set_position(x, y);
        this._area.add_child(entry.actor);
        entry.actor.clutter_text.grab_key_focus();
        entry.actor.clutter_text.connect('key-press-event', (_t, ev) => {
            const sym = ev.get_key_symbol();
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._commitText(true);
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Escape) {
                this._commitText(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._entry = entry;
    }

    _commitText(keep) {
        const e = this._entry;
        if (!e) return;
        this._entry = null;
        const text = e.actor.get_text();
        e.actor.destroy();
        this._area?.grab_key_focus();
        if (keep && text.trim()) {
            const o = this._o;
            // +7/+3: the entry's own padding+border, so the text lands where it was typed.
            this._pushAnn({type: 'text', color: e.color, size: o.textSize, bold: o.bold, bg: o.textBg,
                           text, pts: [[e.x + 7, e.y + 3]]});
        }
    }

    // ------------------------------------------------------ live effects

    // Reads the whole frozen frame into memory once, in the background (PNG encode and decode
    // both run in worker threads), so effect previews are pure arithmetic with no per-move I/O.
    _loadPixels() {
        const tex = this._texture;
        const out = Gio.MemoryOutputStream.new_resizable();
        try {
            Shell.Screenshot.composite_to_stream(tex, 0, 0, tex.get_width(), tex.get_height(), this._scale,
                null, 0, 0, 1, out, (_o, res) => {
                    try {
                        Shell.Screenshot.composite_to_stream_finish(res);
                        out.close(null);
                        GdkPixbuf.Pixbuf.new_from_stream_async(
                            Gio.MemoryInputStream.new_from_bytes(out.steal_as_bytes()), null, (_s, res2) => {
                                try {
                                    const pb = GdkPixbuf.Pixbuf.new_from_stream_finish(res2);
                                    if (!this._area) return;
                                    this._px = {pixels: pb.get_pixels(), nch: pb.get_n_channels(),
                                                rs: pb.get_rowstride(), w: pb.get_width(), h: pb.get_height()};
                                    for (const a of [...this._anns, this._cur])
                                        if (a?.waiting) { a.waiting = false; a.key = null; this._ensurePreview(a, true); }
                                } catch (e) {
                                    console.error(`[winprobe] pixel decode failed: ${e}\n${e.stack}`);
                                }
                            });
                    } catch (e) {
                        console.error(`[winprobe] pixel load failed: ${e}\n${e.stack}`);
                    }
                });
        } catch (e) {
            console.error(`[winprobe] _loadPixels threw: ${e}\n${e.stack}`);
        }
    }

    // A padded RGBA copy of a frame region, plus where the inner rectangle sits in it.
    _region(r, padTex) {
        const px = this._px, s = this._scale;
        const ix0 = clamp(Math.floor(r.x * s), 0, px.w), iy0 = clamp(Math.floor(r.y * s), 0, px.h);
        const ix1 = clamp(Math.ceil((r.x + r.w) * s), 0, px.w), iy1 = clamp(Math.ceil((r.y + r.h) * s), 0, px.h);
        if (ix1 - ix0 < 1 || iy1 - iy0 < 1) return null;
        const x0 = Math.max(0, ix0 - padTex), y0 = Math.max(0, iy0 - padTex);
        const x1 = Math.min(px.w, ix1 + padTex), y1 = Math.min(px.h, iy1 + padTex);
        const pw = x1 - x0, ph = y1 - y0;
        const arr = new Uint8Array(pw * ph * 4);
        for (let y = 0; y < ph; y++) {
            const si = (y0 + y) * px.rs + x0 * px.nch;
            if (px.nch === 4) arr.set(px.pixels.subarray(si, si + pw * 4), y * pw * 4);
            else for (let x = 0; x < pw; x++) {
                const o = si + x * px.nch, d = (y * pw + x) * 4;
                arr[d] = px.pixels[o]; arr[d + 1] = px.pixels[o + 1]; arr[d + 2] = px.pixels[o + 2];
            }
        }
        return {arr, pw, ph, ox: ix0 - x0, oy: iy0 - y0, iw: ix1 - ix0, ih: iy1 - iy0, ix0, iy0,
                has: {top: iy0 > 0, left: ix0 > 0, bottom: iy1 < px.h, right: ix1 < px.w}};
    }

    _normRect(a) {
        const p0 = a.pts[0], p1 = a.pts[a.pts.length - 1];
        return {x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]),
                w: Math.abs(p1[0] - p0[0]), h: Math.abs(p1[1] - p0[1])};
    }

    // Recompute the live preview of a blur/pixelate/erase annotation if its rectangle changed.
    // Recompute the live preview of a blur/pixelate/erase annotation when its rectangle changed.
    // While dragging it is limited to ~40 fps; `force` (on release) always brings it up to date.
    _ensurePreview(a, force = false) {
        if (!this._area || a.dead) return;
        if (!this._px) { a.waiting = true; return; }
        const r = this._normRect(a);
        if (r.w < 2 || r.h < 2) return;
        const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)},${a.strength}`;
        if (a.key === key) return;
        const now = GLib.get_monotonic_time();
        if (!force && now - this._lastFx < 25000) return;
        this._lastFx = now;
        a.key = key;
        const s = this._scale;
        const block = Math.max(4, Math.round(PIX_BLOCK[a.strength] * s));
        const radius = Math.max(2, Math.round(BLUR_RADIUS[a.strength] * s / 2));
        const pad = a.type === 'blur' ? radius * 3 : a.type === 'erase' ? 8 : 0;
        const px = this._region(r, pad);
        if (!px) return;
        try {
            let arr, w = px.iw, h = px.ih, blur = null;
            if (a.type === 'pixelate') arr = effectPixelate(px.arr, px.pw, px.ph, px.ox, px.oy, px.iw, px.ih, block);
            else if (a.type === 'blur') { blur = effectBlur(px.arr, px.pw, px.ph, radius); arr = blur.arr; w = blur.w; h = blur.h; }
            else arr = effectErase(px.arr, px.pw, px.ph, px.ox, px.oy, px.iw, px.ih, px.has);
            const img = new Clutter.Image();
            img.set_data(arr, Cogl.PixelFormat.RGBA_8888, w, h, w * 4);
            if (!a.actor) {
                a.actor = new Clutter.Actor({reactive: false, content_gravity: Clutter.ContentGravity.RESIZE_FILL});
                a.actor.set_content_scaling_filters(Clutter.ScalingFilter.LINEAR, Clutter.ScalingFilter.LINEAR);
                Main.uiGroup.insert_child_above(a.actor, this._frame);
            }
            a.actor.set_content(img);
            if (blur) {
                // The small image covers the whole padded region; show only the inner rectangle.
                const x0 = px.ix0 - px.ox, y0 = px.iy0 - px.oy;
                a.actor.set_position(x0 / s, y0 / s);
                a.actor.set_size(w * blur.f / s, h * blur.f / s);
                a.actor.set_clip(px.ox / s, px.oy / s, px.iw / s, px.ih / s);
            } else {
                a.actor.set_position(px.ix0 / s, px.iy0 / s);
                a.actor.set_size(px.iw / s, px.ih / s);
            }
            a.sample = {arr, iw: w, ih: h, block};
        } catch (e) {
            console.error(`[winprobe] effect ${a.type} failed: ${e}\n${e.stack}`);
        }
    }

    // ------------------------------------------------------------ scene

    // Windows on the active workspace, topmost first, as they are right now.
    _windows() {
        const actors = global.compositor?.get_window_actors?.() ?? global.get_window_actors();
        const workspace = global.workspace_manager.get_active_workspace();
        const out = [];
        // Actors are in stacking order, bottom to top.
        for (let i = actors.length - 1; i >= 0; i--) {
            const actor = actors[i];
            const win = actor.meta_window;
            if (!win || win.minimized || !actor.visible) continue;
            if (!TYPES.includes(win.get_window_type())) continue;
            if (!win.located_on_workspace(workspace)) continue;
            const r = win.get_frame_rect();
            out.push({title: win.get_title() ?? '', app: win.get_wm_class() ?? '',
                      x: r.x, y: r.y, w: r.width, h: r.height});
        }
        return out;
    }

    _findIn(list, px, py) {
        const w = list.find(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
        return w ? {found: true, px, py, ...w}
                 : {found: false, px, py, title: '', app: '', x: 0, y: 0, w: 0, h: 0};
    }

    _findAt(px, py) {
        return this._findIn(this._windowsSnap ?? [], px, py);
    }

    _tick() {
        if (!this._area) return;
        const W = global.stage.width, H = global.stage.height;
        if (this._area.width !== W || this._area.height !== H) this._area.set_size(W, H);
        this._phase = (this._phase + 0.6) % 12;
        const [px, py] = global.get_pointer();

        if (this._uiDirty) {
            this._uiDirty = false;
            this._rebuildUi();
        }

        if (this._tool !== 'select') {
            this._hideAnts();
            const a = this._cur;
            if (a && this._press) {
                const shift = !!(global.get_pointer()[2] & Clutter.ModifierType.SHIFT_MASK);
                const freehand = a.type === 'pen' || a.type === 'highlight';
                if (shift !== !!this._shiftOn) {
                    this._shiftOn = shift;
                    this._axis = null;
                    this._anchor = null;
                    if (!shift && this._raw) {   // keep the straight segment, continue freehand from its end
                        a.pts = [...this._raw, this._segEnd ?? this._raw.at(-1)];
                        this._raw = null;
                    }
                }
                let target = [px, py];
                if (shift) {
                    if (freehand) this._raw ??= a.pts.slice();
                    const from = freehand ? (this._anchor ??= this._raw.at(-1)) : a.pts[0];
                    const dx = px - from[0], dy = py - from[1];
                    if (a.type === 'rect' || a.type === 'ellipse') {
                        const m = Math.max(Math.abs(dx), Math.abs(dy));
                        target = [from[0] + Math.sign(dx || 1) * m, from[1] + Math.sign(dy || 1) * m];
                    } else {
                        const ax = Math.abs(dx), ay = Math.abs(dy);
                        if (Math.max(ax, ay) >= 3) {
                            if (!this._axis) this._axis = ax >= ay ? 'h' : 'v';
                            else if (this._axis === 'h' && ay > ax * 1.6) this._axis = 'v';
                            else if (this._axis === 'v' && ax > ay * 1.6) this._axis = 'h';
                        }
                        target = this._axis === 'h' ? [px, from[1]] : this._axis === 'v' ? [from[0], py] : [from[0], from[1]];
                    }
                    if (freehand) {
                        this._segEnd = target;
                        a.pts = [...this._raw, target];
                        this._touch(a);
                        return;
                    }
                }
                const last = a.pts[a.pts.length - 1];
                if (last[0] !== target[0] || last[1] !== target[1]) {
                    if (freehand) a.pts.push(target);
                    else a.pts[1] = target;
                    this._touch(a);
                    if (EFFECTS.includes(a.type)) this._ensurePreview(a);   // live while dragging
                }
            }
            return;
        }

        if (this._press) {
            if (this._drag || Math.hypot(px - this._press.x, py - this._press.y) >= DRAG_PX) {
                const x0 = Math.max(0, Math.min(this._press.x, px));
                const y0 = Math.max(0, Math.min(this._press.y, py));
                const x1 = Math.min(W, Math.max(this._press.x, px));
                const y1 = Math.min(H, Math.max(this._press.y, py));
                this._drag = {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
            }
        }
        this._hit = this._findAt(px, py);
        const d = this._drag;
        const r = d ?? (this._hit.found && !this._overUiPoint(px, py) ? this._hit : null);
        if (!r) {
            this._hideAnts();
            this._showDim({x: 0, y: 0, w: 0, h: 0}, true);   // capture mode cue: whole screen dimmed
            return;
        }
        this._showAnts(r, !d, d ? `${d.w} x ${d.h}` : `${r.app || '?'} - ${r.title || '(no title)'}  [${r.w}x${r.h}]`);

        this._showDim(r);
    }

    // Dims everything outside `r` (or the whole screen when `whole`) so capture mode is obvious.
    _showDim(r, whole = false) {
        const W = global.stage.width, H = global.stage.height;
        const strips = whole ? [[0, 0, W, H], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] : [
            [0, 0, W, r.y],
            [0, r.y + r.h, W, H - r.y - r.h],
            [0, r.y, r.x, r.h],
            [r.x + r.w, r.y, W - r.x - r.w, r.h],
        ];
        this._dim.forEach((w, i) => {
            const [x, y, sw, sh] = strips[i];
            w.set_position(x, y);
            w.set_size(Math.max(0, sw), Math.max(0, sh));
            w.show();
        });
    }

    _hideAnts() {
        this._antTint.hide();
        this._antLabel.hide();
        this._antEdges.forEach(e => e.hide());
        this._dim.forEach(w => w.hide());
    }

    _showAnts(r, tint, label) {
        const t = 2, w = Math.max(r.w, 2 * t), h = Math.max(r.h, 2 * t);
        const edges = [[r.x, r.y, w, t], [r.x, r.y + h - t, w, t], [r.x, r.y, t, h], [r.x + w - t, r.y, t, h]];
        this._antEdges.forEach((e, i) => {
            e.set_position(edges[i][0], edges[i][1]);
            e.set_size(edges[i][2], edges[i][3]);
            e.show();
            e.queue_repaint();
        });
        if (tint) {
            this._antTint.set_position(r.x, r.y);
            this._antTint.set_size(w, h);
            this._antTint.show();
        } else {
            this._antTint.hide();
        }
        if (this._antLabel.text !== label) this._antLabel.set_text(label);
        this._antLabel.set_position(r.x + 6, r.y + 6);
        this._antLabel.show();
    }

    // Is the pointer over the toolbar? (don't highlight the window behind it)
    _overUiPoint(px, py) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px, py);
        return !!actor && [this._ui, this._picker].some(w => w && (actor === w || w.contains(actor)));
    }

    // ----------------------------------------------------------- drawing

    _paintEdge(area, side) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const horizontal = side === 't' || side === 'b';
        const line = (len, off) => {
            if (horizontal) { cr.moveTo(0, 1); cr.lineTo(len, 1); } else { cr.moveTo(1, 0); cr.lineTo(1, len); }
            void off;
        };
        const len = horizontal ? w : h;
        cr.setLineWidth(2);
        // Two interleaved dash layers (dark under light) read on any background.
        cr.setDash([6, 6], this._phase);
        cr.setSourceRGBA(0, 0, 0, 0.9);
        line(len);
        cr.stroke();
        cr.setDash([6, 6], this._phase + 6);
        cr.setSourceRGBA(1, 1, 1, 1);
        line(len);
        cr.stroke();
        cr.$dispose();
    }

    _textMetrics(cr, a) {
        cr.selectFontFace('Sans', 0, a.bold ? 1 : 0);
        cr.setFontSize(a.size);
        const lines = a.text.split('\n');
        const width = Math.max(...lines.map(l => cr.textExtents(l).width));
        return {lines, width, asc: cr.fontExtents().ascent, lh: a.size * 1.2};
    }

    _drawAnn(cr, a) {
        const [r, g, b] = a.color;
        const p0 = a.pts[0], p1 = a.pts[a.pts.length - 1];
        const x = Math.min(p0[0], p1[0]), y = Math.min(p0[1], p1[1]);
        const w = Math.abs(p1[0] - p0[0]), h = Math.abs(p1[1] - p0[1]);
        cr.save();
        cr.setLineCap(1);
        cr.setLineJoin(1);
        switch (a.type) {
        case 'rect':
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(a.width);
            cr.rectangle(x, y, w, h);
            cr.stroke();
            break;
        case 'ellipse':
            cr.setSourceRGBA(r, g, b, 1);
            cr.save();
            cr.translate(x + w / 2, y + h / 2);
            cr.scale(Math.max(1, w / 2), Math.max(1, h / 2));
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            cr.setLineWidth(a.width);
            cr.stroke();
            break;
        case 'line':
        case 'arrow': {
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(a.width);
            let end = p1, head = null;
            if (a.type === 'arrow') {
                const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dist = Math.hypot(dx, dy);
                if (dist > 1) {
                    const ux = dx / dist, uy = dy / dist;
                    const L = Math.min(13 + a.width * 3.4, dist * 0.8), hw = L * 0.46;
                    const nx = -uy, ny = ux;
                    const bx = p1[0] - ux * L, by = p1[1] - uy * L;
                    const notch = [bx + ux * L * 0.26, by + uy * L * 0.26];
                    head = [p1, [bx + nx * hw, by + ny * hw], notch, [bx - nx * hw, by - ny * hw]];
                    end = notch;
                }
            }
            cr.moveTo(p0[0], p0[1]);
            cr.lineTo(end[0], end[1]);
            cr.stroke();
            if (head) {
                cr.setLineWidth(1.2);
                cr.setLineJoin(1);
                cr.moveTo(head[0][0], head[0][1]);
                for (let i = 1; i < head.length; i++) cr.lineTo(head[i][0], head[i][1]);
                cr.closePath();
                cr.fillPreserve();
                cr.stroke();
            }
            break;
        }
        case 'pen':
        case 'highlight':
            if (a.type === 'highlight') {
                cr.setSourceRGBA(r, g, b, 0.4);
                cr.setLineWidth(a.width * 4);
                cr.setLineCap(2);
            } else {
                cr.setSourceRGBA(r, g, b, 1);
                cr.setLineWidth(a.width);
            }
            cr.moveTo(a.pts[0][0], a.pts[0][1]);
            for (const p of a.pts.slice(1)) cr.lineTo(p[0], p[1]);
            if (a.pts.length === 1) cr.lineTo(a.pts[0][0] + 0.1, a.pts[0][1]);
            cr.stroke();
            break;
        case 'text': {
            const m = this._textMetrics(cr, a);
            const [tx, ty] = a.pts[0];
            if (a.bg && a.bg !== 'none') {
                const pad = 6, rad = 6, bx = tx - pad, by = ty - 4, bw = m.width + pad * 2, bh = m.lh * m.lines.length + 4;
                if (a.bg === 'dark') cr.setSourceRGBA(0, 0, 0, 0.68); else cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.newPath();
                cr.arc(bx + bw - rad, by + rad, rad, -Math.PI / 2, 0);
                cr.arc(bx + bw - rad, by + bh - rad, rad, 0, Math.PI / 2);
                cr.arc(bx + rad, by + bh - rad, rad, Math.PI / 2, Math.PI);
                cr.arc(bx + rad, by + rad, rad, Math.PI, 1.5 * Math.PI);
                cr.closePath();
                cr.fill();
            }
            cr.selectFontFace('Sans', 0, a.bold ? 1 : 0);
            cr.setFontSize(a.size);
            cr.setSourceRGBA(r, g, b, 1);
            m.lines.forEach((line, i) => {
                cr.moveTo(tx, ty + m.asc + i * m.lh);
                cr.showText(line);
            });
            break;
        }
        case 'step': {
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(p0[0], p0[1], a.r, 0, 2 * Math.PI);
            cr.fill();
            cr.selectFontFace('Sans', 0, 1);
            cr.setFontSize(a.r * 1.2);
            const label = String(a.n), ext = cr.textExtents(label);
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            cr.setSourceRGBA(lum > 0.6 ? 0 : 1, lum > 0.6 ? 0 : 1, lum > 0.6 ? 0 : 1, 1);
            cr.moveTo(p0[0] - ext.width / 2, p0[1] + ext.height / 2);
            cr.showText(label);
            break;
        }
        default:
            // blur / pixelate / erase: the effect itself is a live actor under this layer;
            // only the rectangle being dragged gets an outline.
            if (a === this._cur) {
                cr.setSourceRGBA(1, 1, 1, 0.9);
                cr.setLineWidth(1);
                cr.setDash([4, 4], 0);
                cr.rectangle(x + 0.5, y + 0.5, w, h);
                cr.stroke();
            }
        }
        cr.restore();
    }
}

return new Logic();
