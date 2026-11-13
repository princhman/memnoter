fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        for source in [
            "native/DrawingEditor.swift",
            "native/DrawingSession.swift",
            "native/DrawingCanvas.swift",
            "native/EmbeddedDrawingHost.swift",
            "native/DrawingPresentation.swift",
            "../apple-shared/DrawingDocument.swift",
        ] {
            println!("cargo:rerun-if-changed={source}");
        }
        let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            other => panic!("Unsupported Mac architecture: {other}"),
        };
        let status = std::process::Command::new("xcrun")
            .args([
                "swiftc",
                "-parse-as-library",
                "-swift-version",
                "6",
                "-O",
                "-target",
                &format!("{arch}-apple-macos14.0"),
                "-emit-library",
                "-module-name",
                "MemnoterDrawing",
                "-Xlinker",
                "-install_name",
                "-Xlinker",
                "@rpath/libMemnoterDrawing.dylib",
                "../apple-shared/DrawingDocument.swift",
                "native/DrawingEditor.swift",
                "native/DrawingSession.swift",
                "native/DrawingCanvas.swift",
                "native/EmbeddedDrawingHost.swift",
                "native/DrawingPresentation.swift",
                "-o",
                "native/libMemnoterDrawing.dylib",
            ])
            .status()
            .expect("Compile the embedded Mac drawing editor");
        assert!(status.success(), "Mac drawing editor compilation failed");
        println!(
            "cargo:rustc-link-search=native={}/native",
            std::env::var("CARGO_MANIFEST_DIR").unwrap()
        );
        println!("cargo:rustc-link-lib=dylib=MemnoterDrawing");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            println!(
                "cargo:rustc-link-arg=-Wl,-rpath,{}/native",
                std::env::var("CARGO_MANIFEST_DIR").unwrap()
            );
            // An unbundled dev binary has no bundle identifier, and PencilKit
            // saves drawing state into preferences keyed by it, which traps on
            // NULL. Embedding an Info.plist gives NSBundle.main an identifier.
            let plist = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("Info.plist");
            std::fs::write(
                &plist,
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.vladyslavnalyvaiko.memnoter.dev</string>
<key>CFBundleName</key><string>Memnoter Dev</string>
</dict></plist>
"#,
            )
            .expect("Write the dev Info.plist");
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                plist.display()
            );
        }
    }
    tauri_build::build()
}
