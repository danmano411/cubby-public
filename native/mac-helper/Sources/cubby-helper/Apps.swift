import AppKit

enum Apps {
  // Kill All's second step. terminate() is a polite Quit (apps may ask to save); with force, whatever
  // is still running 1.5s later is force-terminated.
  static func quit(pid: pid_t, force: Bool) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    app.terminate()
    if force {
      DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
        if !app.isTerminated { app.forceTerminate() }
      }
    }
    return true
  }

  // targets: "bundle:<bundle id>" or a file path (.app bundle or any file). -> { target: dataUrl }
  static func icons(_ targets: [String], size: Int) -> [String: String] {
    var out: [String: String] = [:]
    for t in targets {
      let path: String?
      if t.hasPrefix("bundle:") {
        path = NSWorkspace.shared.urlForApplication(withBundleIdentifier: String(t.dropFirst(7)))?.path
      } else {
        path = (t as NSString).expandingTildeInPath
      }
      guard let p = path, FileManager.default.fileExists(atPath: p),
            let png = png(NSWorkspace.shared.icon(forFile: p), size) else { continue }
      out[t] = "data:image/png;base64," + png.base64EncodedString()
    }
    return out
  }

  private static func png(_ image: NSImage, _ size: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
  }

  // Apps for setup's "add apps" list: /Applications (one vendor-folder level deep), the system
  // apps, and ~/Applications. -> [{ name, bundleId, path }] sorted by name, one per bundle id.
  static func installed() -> [[String: Any]] {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    let roots: [(String, Bool)] = [ // (folder, look one level into non-.app subfolders)
      ("/Applications", true), ("/System/Applications", true), (home + "/Applications", true),
      ("/System/Library/CoreServices", false), // Finder
    ]
    var seen = Set<String>()
    var out: [[String: Any]] = []
    func add(_ path: String) {
      guard let b = Bundle(path: path) else { return }
      let id = b.bundleIdentifier ?? path
      guard !seen.contains(id) else { return }
      if path.hasPrefix("/System/Library/CoreServices") && id != "com.apple.finder" { return }
      seen.insert(id)
      var name = fm.displayName(atPath: path)
      if name.hasSuffix(".app") { name = String(name.dropLast(4)) }
      out.append(["name": name, "bundleId": b.bundleIdentifier ?? "", "path": path])
    }
    for (root, deep) in roots {
      for entry in (try? fm.contentsOfDirectory(atPath: root)) ?? [] where !entry.hasPrefix(".") {
        let p = root + "/" + entry
        if entry.hasSuffix(".app") { add(p); continue }
        var isDir: ObjCBool = false
        guard deep, fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue else { continue }
        for sub in (try? fm.contentsOfDirectory(atPath: p)) ?? [] where sub.hasSuffix(".app") { add(p + "/" + sub) }
      }
    }
    return out.sorted { ($0["name"] as? String ?? "").localizedCaseInsensitiveCompare($1["name"] as? String ?? "") == .orderedAscending }
  }
}

enum Media {
  // NX_KEYTYPE_* from IOKit's ev_keymap.h, posted as system-defined (subtype 8, "aux control button")
  // events, which is what the keyboard's media keys send. macOS routes them to the Now Playing app.
  private static let codes: [String: Int] = ["play": 16, "next": 17, "prev": 18]

  static func press(_ key: String) -> Bool {
    guard let code = codes[key] else { return false }
    for down in [true, false] {
      let state = down ? 0xA : 0xB
      guard let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero,
                                        modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)),
                                        timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
                                        data1: (code << 16) | (state << 8), data2: -1),
            let cg = ev.cgEvent else { return false }
      cg.post(tap: .cghidEventTap)
    }
    return true
  }
}
