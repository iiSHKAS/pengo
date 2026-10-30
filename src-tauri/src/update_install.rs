// Adapted from Sonux / Mixweave (GPL-3.0-only). See docs/updates.md.
//! AppImage-only atomic replacement. Call only with signature-verified bytes.
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

pub fn is_appimage(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x7fELF") && bytes.get(8..11) == Some(b"AI\x02")
}

pub fn validate_path(path: &Path) -> io::Result<fs::Metadata> {
    use std::io::Read;
    let meta = fs::symlink_metadata(path)?;
    if !path.is_absolute() || !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::other(
            "AppImage must be a regular file owned by the current user (not a symlink)",
        ));
    }
    let mut header = [0; 11];
    fs::File::open(path)?.read_exact(&mut header)?;
    if !is_appimage(&header) {
        return Err(io::Error::other("Not a type-2 AppImage"));
    }
    Ok(meta)
}

pub fn install(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if !is_appimage(bytes) {
        return Err(io::Error::other(
            "The signed download is not a type-2 AppImage",
        ));
    }
    let original = validate_path(path)?;
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing AppImage directory"))?;
    // Reserve space for both staged image and durable recovery copy.
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(dir.as_os_str().as_bytes())?;
    let mut space = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(name.as_ptr(), space.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let space = unsafe { space.assume_init() };
    let available = u128::from(space.f_bavail) * u128::from(space.f_frsize);
    if available < bytes.len() as u128 + u128::from(original.len()) + 10 * 1024 * 1024 {
        return Err(io::Error::other(
            "Not enough space for the update and recovery copy",
        ));
    }
    let mut staged = tempfile::NamedTempFile::new_in(dir)?;
    staged.write_all(bytes)?;
    staged
        .as_file()
        .set_permissions(fs::Permissions::from_mode(
            (original.mode() & 0o777) | 0o100,
        ))?;
    staged.as_file().sync_all()?;
    let mut backup = tempfile::NamedTempFile::new_in(dir)?;
    io::copy(&mut fs::File::open(path)?, backup.as_file_mut())?;
    backup
        .as_file()
        .set_permissions(fs::Permissions::from_mode(
            (original.mode() & 0o777) | 0o100,
        ))?;
    backup.as_file().sync_all()?;
    let current = validate_path(path)?;
    if (
        original.dev(),
        original.ino(),
        original.len(),
        original.mtime(),
        original.mtime_nsec(),
    ) != (
        current.dev(),
        current.ino(),
        current.len(),
        current.mtime(),
        current.mtime_nsec(),
    ) {
        return Err(io::Error::other(
            "AppImage changed during update; retry after stopping other update managers",
        ));
    }
    let mut backup_name = path.as_os_str().to_os_string();
    backup_name.push(".previous");
    backup
        .persist(Path::new(&backup_name))
        .map_err(|e| e.error)?;
    fs::File::open(dir)?.sync_all()?;
    staged.persist(path).map_err(|e| e.error)?;
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(version: u8) -> Vec<u8> {
        let mut data = vec![0; 128];
        data[..4].copy_from_slice(b"\x7fELF");
        data[8..11].copy_from_slice(b"AI\x02");
        data[127] = version;
        data
    }
    #[test]
    fn replacement_keeps_recovery_and_open_old_inode() {
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Pengo's AppImage.AppImage");
        fs::write(&path, image(1)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
        let mut running = fs::File::open(&path).unwrap();
        install(&path, &image(2)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), image(2));
        assert_eq!(
            fs::read(path.with_file_name("Pengo's AppImage.AppImage.previous")).unwrap(),
            image(1)
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o750);
        let mut old = Vec::new();
        running.read_to_end(&mut old).unwrap();
        assert_eq!(old, image(1), "running process retains the old inode");
        install(&path, &image(3)).unwrap();
        assert_eq!(
            fs::read(path.with_file_name("Pengo's AppImage.AppImage.previous")).unwrap(),
            image(2)
        );
    }
    #[test]
    fn rejects_invalid_download_without_changing_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Pengo.AppImage");
        fs::write(&path, image(1)).unwrap();
        for bad in [vec![], b"not an AppImage".to_vec(), {
            let mut v = image(2);
            v[10] = 1;
            v
        }] {
            assert!(install(&path, &bad).is_err());
            assert_eq!(fs::read(&path).unwrap(), image(1));
        }
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn rejects_symlink_directory_and_non_appimage_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.AppImage");
        let link = dir.path().join("link.AppImage");
        fs::write(&real, image(1)).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(install(&link, &image(2)).is_err());
        assert!(validate_path(dir.path()).is_err());
        fs::write(&real, b"plain binary").unwrap();
        assert!(install(&real, &image(2)).is_err());
        assert_eq!(fs::read(&real).unwrap(), b"plain binary");
    }
}
