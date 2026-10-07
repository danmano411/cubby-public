// swift-tools-version:5.7
import Foundation
import PackageDescription

// Info.plist is linked into the binary (__TEXT,__info_plist) so TCC has usage strings when the helper
// runs on its own (dev, from Terminal). Spawned by Cubby.app, macOS attributes permissions to the app.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
  name: "cubby-helper",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "cubby-helper",
      path: "Sources/cubby-helper",
      linkerSettings: [
        .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist]),
      ]
    ),
  ]
)
