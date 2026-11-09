fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        for source in [
            "native/DrawingEditor.swift",
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
        }
    }
    tauri_build::build()
}
