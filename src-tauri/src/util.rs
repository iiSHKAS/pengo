use std::process::Command;

pub fn in_flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists()
}

/// Runs a command on the host (escaping a Flatpak sandbox if we are in one).
pub fn run(args: &[&str]) -> Result<String, String> {
    let mut cmd;
    if in_flatpak() {
        cmd = Command::new("flatpak-spawn");
        cmd.arg("--host").args(args);
    } else {
        cmd = Command::new(args[0]);
        cmd.args(&args[1..]);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

pub fn sanitize(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .take(40)
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() { "capture".into() } else { s }
}
