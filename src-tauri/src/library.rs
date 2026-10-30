//! The screenshot library: scanning, thumbnails, rename/delete.

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const EXTS: [&str; 5] = ["png", "jpg", "jpeg", "bmp", "webp"];

#[derive(Serialize, Clone)]
pub struct Item {
    pub path: String,
    pub name: String,
    /// Source application / mode parsed from the file name ("" if unknown).
    pub app: String,
    pub size: u64,
    pub mtime: f64,
    pub width: u32,
    pub height: u32,
}

/// Bump to invalidate cached thumbnails after changing how they are made.
const THUMB_VERSION: u32 = 2;

pub fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// "Firefox-20260101-120000.png" -> "Firefox"
fn app_from_name(stem: &str) -> String {
    let parts: Vec<&str> = stem.rsplitn(3, '-').collect(); // [time, date, app]
    if parts.len() == 3
        && parts[0].len() == 6
        && parts[1].len() == 8
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].chars().all(|c| c.is_ascii_digit())
    {
        return parts[2].replace('_', " ");
    }
    String::new()
}

pub fn scan(dir: &Path) -> Vec<Item> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut items: Vec<Item> = rd
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if !path.is_file() || !is_image(&path) {
                return None;
            }
            let meta = e.metadata().ok()?;
            let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64();
            let (width, height) = image::image_dimensions(&path).unwrap_or((0, 0));
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            Some(Item {
                app: app_from_name(&stem),
                name: path.file_name()?.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
                mtime,
                width,
                height,
            })
        })
        .collect();
    items.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
    items
}

/// Returns the path of a cached JPEG thumbnail, creating it if needed.
pub fn thumbnail(cache_dir: &Path, src: &Path) -> Result<PathBuf, String> {
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    meta.len().hash(&mut h);
    THUMB_VERSION.hash(&mut h);
    meta.modified().ok().hash(&mut h);
    let out = cache_dir.join(format!("{:016x}.jpg", h.finish()));
    if out.exists() {
        return Ok(out);
    }
    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let img = image::open(src).map_err(|e| e.to_string())?;
    // Lanczos at ~2x the card size stays crisp on HiDPI; cached, so the cost is paid once.
    let thumb = if img.width() > 760 || img.height() > 570 {
        img.resize(760, 570, image::imageops::FilterType::Lanczos3).to_rgb8()
    } else {
        img.to_rgb8()   // never enlarge
    };
    let tmp = out.with_extension("tmp");
    {
        let f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(f), 92);
        enc.encode_image(&thumb).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    p
}

pub fn rename(src: &Path, new_name: &str) -> Result<PathBuf, String> {
    let clean: String = new_name.trim().chars().filter(|c| !matches!(c, '/' | '\\' | '\0')).collect();
    if clean.is_empty() {
        return Err("empty name".into());
    }
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let stem = clean.strip_suffix(&format!(".{ext}")).unwrap_or(&clean);
    let dest = src.with_file_name(format!("{stem}.{ext}"));
    if dest == src {
        return Ok(dest);
    }
    if dest.exists() {
        return Err("a file with that name already exists".into());
    }
    std::fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}
