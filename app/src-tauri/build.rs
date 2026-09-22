fn main() {
    // `tauri-build` only tracks tauri.conf.json, so a changed icon leaves the
    // cached resource (and its embedded .ico) in place on the next build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
