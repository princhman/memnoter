// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "MemnoterCore", platforms: [.iOS(.v17)],
    products: [.library(name: "MemnoterCore", targets: ["MemnoterCore"])],
    targets: [
        .binaryTarget(name: "memnoter_ffiFFI", path: "MemnoterFFI.xcframework"),
        .target(name: "MemnoterCore", dependencies: ["memnoter_ffiFFI"])
    ]
)
