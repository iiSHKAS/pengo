use base64::{engine::general_purpose::STANDARD, Engine};
use minisign::{PublicKey, PublicKeyBox, SecretKey, SecretKeyBox};
use std::{
    env, fs,
    io::Cursor,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 3 {
        return Err("usage: signing VERSION APPIMAGE".into());
    }
    let version = &args[1];
    if version.split('.').count() != 3
        || !version
            .split('.')
            .all(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err("version must use X.Y.Z".into());
    }
    let path = PathBuf::from(&args[2]);
    let data = fs::read(&path)?;
    if data.get(8..11) != Some(b"AI\x02") {
        return Err("expected a type-2 AppImage".into());
    }
    let encoded = env::var("TAURI_SIGNING_PRIVATE_KEY")?;
    let key_text = if encoded.trim_start().starts_with("untrusted comment:") {
        encoded
    } else {
        String::from_utf8(STANDARD.decode(encoded.trim())?)?
    };
    let password = env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap_or_default();
    let secret = SecretKey::from_box(SecretKeyBox::from_string(&key_text)?, Some(password))?;
    let public_text =
        String::from_utf8(STANDARD.decode(env::var("TAURI_UPDATER_PUBLIC_KEY")?.trim())?)?;
    let public = PublicKey::from_box(PublicKeyBox::from_string(&public_text)?)?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let signature = sign_image(&data, version, &public, &secret, timestamp)?;
    fs::write(
        format!("{}.sig", path.display()),
        STANDARD.encode(signature.to_string()) + "\n",
    )?;
    println!("Signed and verified AppImage for version {version}");
    Ok(())
}

fn sign_image(
    data: &[u8],
    version: &str,
    public: &PublicKey,
    secret: &SecretKey,
    timestamp: u64,
) -> Result<minisign::SignatureBox, minisign::PError> {
    let comment = format!("timestamp:{timestamp}\tfile:Pengo.AppImage\tversion:{version}");
    let signature = minisign::sign(
        Some(public),
        secret,
        Cursor::new(data),
        Some(&comment),
        None,
    )?;
    minisign::verify(public, &signature, Cursor::new(data), true, false, false)?;
    Ok(signature)
}
