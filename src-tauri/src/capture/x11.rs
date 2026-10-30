//! Generic X11 capture: grab the root window, enumerate the visible top-level
//! windows (EWMH) so the overlay can offer click-to-pick. Works on any distro/WM.

use image::RgbaImage;
use serde::Serialize;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, ImageFormat, Window};
use x11rb::rust_connection::RustConnection;

#[derive(Serialize, Clone, Debug)]
pub struct WinRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub title: String,
    pub app: String,
}

pub struct Frozen {
    pub img: RgbaImage,
    pub windows: Vec<WinRect>,
}

impl Frozen {
    pub fn crop(&self, x: i64, y: i64, w: i64, h: i64) -> Option<RgbaImage> {
        let (iw, ih) = (self.img.width() as i64, self.img.height() as i64);
        let x0 = x.clamp(0, iw);
        let y0 = y.clamp(0, ih);
        let x1 = (x + w).clamp(0, iw);
        let y1 = (y + h).clamp(0, ih);
        if x1 - x0 < 1 || y1 - y0 < 1 {
            return None;
        }
        Some(image::imageops::crop_imm(&self.img, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32).to_image())
    }
}

fn atom(conn: &RustConnection, name: &str) -> Result<Atom, String> {
    Ok(conn
        .intern_atom(false, name.as_bytes())
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom)
}

fn prop32(conn: &RustConnection, win: Window, prop: Atom) -> Vec<u32> {
    conn.get_property(false, win, prop, AtomEnum::ANY, 0, 8192)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|it| it.collect()))
        .unwrap_or_default()
}

fn prop8(conn: &RustConnection, win: Window, prop: Atom) -> Vec<u8> {
    conn.get_property(false, win, prop, AtomEnum::ANY, 0, 8192)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|r| r.value)
        .unwrap_or_default()
}

pub fn grab() -> Result<Frozen, String> {
    let (conn, num) = RustConnection::connect(None).map_err(|e| format!("cannot open the X display: {e}"))?;
    let setup = conn.setup();
    let screen = &setup.roots[num];
    let root = screen.root;
    let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);

    let bpp = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == screen.root_depth)
        .map(|f| f.bits_per_pixel)
        .unwrap_or(32);
    if bpp != 32 {
        return Err(format!("unsupported X pixel format ({bpp} bpp)"));
    }
    let lsb = setup.image_byte_order == x11rb::protocol::xproto::ImageOrder::LSB_FIRST;

    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, root, 0, 0, w, h, !0)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| format!("GetImage failed: {e}"))?;
    let data = reply.data;
    if data.len() < (w as usize) * (h as usize) * 4 {
        return Err("short image data from the X server".into());
    }
    let mut rgba = Vec::with_capacity(w as usize * h as usize * 4);
    for px in data.chunks_exact(4).take(w as usize * h as usize) {
        if lsb {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        } else {
            rgba.extend_from_slice(&[px[1], px[2], px[3], 255]);
        }
    }
    let img = RgbaImage::from_raw(w as u32, h as u32, rgba).ok_or("bad image buffer")?;
    let windows = windows(&conn, root, w as i32, h as i32).unwrap_or_default();
    Ok(Frozen { img, windows })
}

fn windows(conn: &RustConnection, root: Window, sw: i32, sh: i32) -> Result<Vec<WinRect>, String> {
    let a_list = atom(conn, "_NET_CLIENT_LIST_STACKING")?;
    let a_state = atom(conn, "_NET_WM_STATE")?;
    let a_hidden = atom(conn, "_NET_WM_STATE_HIDDEN")?;
    let a_type = atom(conn, "_NET_WM_WINDOW_TYPE")?;
    let a_desktop_t = atom(conn, "_NET_WM_WINDOW_TYPE_DESKTOP")?;
    let a_desk = atom(conn, "_NET_WM_DESKTOP")?;
    let a_cur = atom(conn, "_NET_CURRENT_DESKTOP")?;
    let a_frame = atom(conn, "_NET_FRAME_EXTENTS")?;
    let a_gtk = atom(conn, "_GTK_FRAME_EXTENTS")?;
    let a_name = atom(conn, "_NET_WM_NAME")?;
    let a_class = atom(conn, "WM_CLASS")?;

    let current = prop32(conn, root, a_cur).first().copied();
    let mut out = Vec::new();
    for win in prop32(conn, root, a_list).into_iter().rev() {
        if prop32(conn, win, a_state).contains(&a_hidden) || prop32(conn, win, a_type).contains(&a_desktop_t) {
            continue;
        }
        if let (Some(cur), Some(d)) = (current, prop32(conn, win, a_desk).first().copied()) {
            if d != 0xFFFF_FFFF && d != cur {
                continue;
            }
        }
        let Some(geo) = conn.get_geometry(win).ok().and_then(|c| c.reply().ok()) else { continue };
        let Some(pos) = conn.translate_coordinates(win, root, 0, 0).ok().and_then(|c| c.reply().ok()) else { continue };
        let mut x = pos.dst_x as i32;
        let mut y = pos.dst_y as i32;
        let mut w = geo.width as i32;
        let mut h = geo.height as i32;
        let fe = prop32(conn, win, a_frame);
        if fe.len() == 4 {
            // left, right, top, bottom: the WM frame (title bar, borders)
            x -= fe[0] as i32;
            y -= fe[2] as i32;
            w += (fe[0] + fe[1]) as i32;
            h += (fe[2] + fe[3]) as i32;
        }
        let ge = prop32(conn, win, a_gtk);
        if ge.len() == 4 {
            // GTK client-side decoration: the window includes an invisible shadow margin
            x += ge[0] as i32;
            y += ge[2] as i32;
            w -= (ge[0] + ge[1]) as i32;
            h -= (ge[2] + ge[3]) as i32;
        }
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = ((x + w).min(sw), (y + h).min(sh));
        if x1 - x0 < 8 || y1 - y0 < 8 {
            continue;
        }
        let mut title = String::from_utf8_lossy(&prop8(conn, win, a_name)).into_owned();
        if title.is_empty() {
            title = String::from_utf8_lossy(&prop8(conn, win, AtomEnum::WM_NAME.into())).into_owned();
        }
        let class = prop8(conn, win, a_class);
        let parts: Vec<String> = class
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        let app = parts.get(1).or_else(|| parts.first()).cloned().unwrap_or_default();
        out.push(WinRect { x: x0, y: y0, w: x1 - x0, h: y1 - y0, title, app });
    }
    Ok(out)
}

/// Asks the window manager to activate one of our windows (EWMH _NET_ACTIVE_WINDOW,
/// sent as a pager so focus-stealing prevention lets it through).
pub fn activate_own_window() -> Result<(), String> {
    use x11rb::protocol::xproto::{ClientMessageEvent, EventMask};
    let (conn, num) = RustConnection::connect(None).map_err(|e| e.to_string())?;
    let root = conn.setup().roots[num].root;
    let a_list = atom(&conn, "_NET_CLIENT_LIST")?;
    let a_pid = atom(&conn, "_NET_WM_PID")?;
    let a_active = atom(&conn, "_NET_ACTIVE_WINDOW")?;
    let pid = std::process::id();
    let win = prop32(&conn, root, a_list)
        .into_iter()
        .rev()
        .find(|w| prop32(&conn, *w, a_pid).first() == Some(&pid))
        .ok_or("own window not found")?;
    let ev = ClientMessageEvent::new(32, win, a_active, [2u32, 0, 0, 0, 0]);
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, ev)
        .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())
}
