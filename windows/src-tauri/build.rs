fn main() {
    let skip_tauri_build = std::env::var("NOCTURNE_SKIP_TAURI_BUILD")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false);
    if skip_tauri_build {
        return;
    }
    tauri_build::build();
}
