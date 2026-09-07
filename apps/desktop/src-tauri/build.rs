fn main() {
    #[cfg(windows)]
    copy_handoff_proxy();
    tauri_build::build()
}

/// Places the terminal-handoff proxy/stub DLL next to the built
/// executable. COM loads it (per the `Interface\…\ProxyStubClsid32`
/// registration Agent Terminal writes) to marshal the console's handle
/// parameters across the process boundary, so the portable app directory
/// must carry it alongside the exe.
#[cfg(windows)]
fn copy_handoff_proxy() {
    use std::path::PathBuf;

    const PROXY_DLL: &str = "agent-terminal-proxy.dll";

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = manifest.join("handoff-proxy").join(PROXY_DLL);
    println!("cargo:rerun-if-changed={}", source.display());
    if !source.exists() {
        println!(
            "cargo:warning={PROXY_DLL} is missing; the default terminal handoff will not marshal"
        );
        return;
    }
    // OUT_DIR is target/<profile>/build/<pkg>-<hash>/out; the executable
    // is written three levels up.
    let Some(target_dir) = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .and_then(|out| out.ancestors().nth(3).map(PathBuf::from))
    else {
        return;
    };
    let _ = std::fs::copy(&source, target_dir.join(PROXY_DLL));
}
