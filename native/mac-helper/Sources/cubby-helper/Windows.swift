import AppKit
import ApplicationServices

// CGWindowID of an AX window. Private but long-stable (used by AltTab, Rectangle, yabai); without it
// windows are matched to AX elements by frame instead.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

// ---- AX helpers ---------------------------------------------------------------------------
func axValue(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func axString(_ el: AXUIElement, _ name: String) -> String? { axValue(el, name) as? String }
func axBool(_ el: AXUIElement, _ name: String) -> Bool? { (axValue(el, name) as? NSNumber)?.boolValue }
func axElement(_ el: AXUIElement, _ name: String) -> AXUIElement? {
  guard let v = axValue(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(v, to: AXUIElement.self)
}
func axElements(_ el: AXUIElement, _ name: String) -> [AXUIElement] { (axValue(el, name) as? [AXUIElement]) ?? [] }
func axSet(_ el: AXUIElement, _ name: String, _ value: CFTypeRef) { AXUIElementSetAttributeValue(el, name as CFString, value) }

func axFrame(_ el: AXUIElement) -> CGRect? {
  guard let p = axValue(el, "AXPosition"), let s = axValue(el, "AXSize"),
        CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
        AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
  return CGRect(origin: point, size: size)
}

func axApp(_ pid: pid_t) -> AXUIElement {
  let el = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(el, 0.3) // a hung app must not stall every list
  return el
}

func axWindowID(_ el: AXUIElement) -> CGWindowID? {
  var id: CGWindowID = 0
  return _AXUIElementGetWindow(el, &id) == .success && id != 0 ? id : nil
}

// ---- Window list ----------------------------------------------------------------------------
// Coordinates: CGWindowList and AX both use global *top-left-origin* points (origin = top-left of
// the primary display, y grows down), the same space as Electron's screen API on macOS, so frames
// go out unchanged. Only NSScreen (Cocoa, bottom-left origin) needs flipping; see screenFrames().
enum Windows {
  struct AXWin { let element: AXUIElement; let title: String; let minimized: Bool; let frame: CGRect? }

  // AX scans are the slow part, so each app's AX windows are cached briefly; activation / launch /
  // our own window commands invalidate. Touched only on `work`.
  private static var axCache: [pid_t: (at: Date, wins: [CGWindowID: AXWin])] = [:]
  private static var owner: [CGWindowID: pid_t] = [:] // last seen pid of every listed window

  static func invalidate(_ pid: pid_t? = nil) {
    if let pid = pid { axCache[pid] = nil } else { axCache.removeAll() }
  }

  static func axWindows(_ pid: pid_t, maxAge: TimeInterval = 1.5) -> [CGWindowID: AXWin] {
    if let c = axCache[pid], Date().timeIntervalSince(c.at) < maxAge { return c.wins }
    var wins: [CGWindowID: AXWin] = [:]
    for el in axElements(axApp(pid), "AXWindows") {
      guard let id = axWindowID(el) else { continue }
      wins[id] = AXWin(element: el, title: axString(el, "AXTitle") ?? "", minimized: axBool(el, "AXMinimized") ?? false, frame: axFrame(el))
    }
    axCache[pid] = (at: Date(), wins: wins)
    return wins
  }

  // Switcher-worthy windows, front to back (≈ most recently used first), then minimized windows and
  // windows of hidden apps (from AX: they aren't on screen, so CGWindowList doesn't have them).
  // Windows on other Spaces / in full-screen Spaces aren't listed (neither API reports them reliably).
  static func list() -> [String: Any] {
    var apps: [pid_t: NSRunningApplication] = [:]
    for a in NSWorkspace.shared.runningApplications where a.activationPolicy == .regular { apps[a.processIdentifier] = a }
    let trusted = AXIsProcessTrusted()
    let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var out: [[String: Any]] = []
    var seen = Set<CGWindowID>()
    owner.removeAll()

    func add(_ id: CGWindowID, _ app: NSRunningApplication, _ title: String, _ minimized: Bool, _ frame: CGRect?) {
      guard !seen.contains(id) else { return }
      seen.insert(id)
      owner[id] = app.processIdentifier
      var w: [String: Any] = [
        "id": Int(id), "pid": Int(app.processIdentifier), "title": title,
        "name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "",
        "path": (app.bundleURL ?? app.executableURL)?.path ?? "",
        "minimized": minimized, "hidden": app.isHidden,
      ]
      if let f = frame { w["frame"] = rectDict(f) }
      out.append(w)
    }

    for w in info {
      guard int(w[kCGWindowLayer as String]) == 0,
            let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
            let app = apps[pid_t(int(w[kCGWindowOwnerPID as String]))],
            ((w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
            let b = w[kCGWindowBounds as String] as? NSDictionary,
            let frame = CGRect(dictionaryRepresentation: b as CFDictionary),
            frame.width >= 50, frame.height >= 50 else { continue }
      // kCGWindowName is empty without Screen Recording; AX titles only need Accessibility.
      var title = w[kCGWindowName as String] as? String ?? ""
      if title.isEmpty, trusted { title = axWindows(app.processIdentifier)[id]?.title ?? "" }
      add(id, app, title, false, frame)
    }

    if trusted {
      for (pid, app) in apps {
        for (id, w) in axWindows(pid) where (w.minimized || app.isHidden) && !seen.contains(id) {
          let sub = axString(w.element, "AXSubrole")
          guard sub == nil || sub == "AXStandardWindow" else { continue }
          add(id, app, w.title, true, w.frame)
        }
      }
    }
    return ["windows": out, "foreground": Int(foreground(trusted, info))]
  }

  // Frontmost app's focused window; without Accessibility, its frontmost on-screen window.
  static func foreground(_ trusted: Bool, _ info: [[String: Any]]) -> CGWindowID {
    guard let front = NSWorkspace.shared.frontmostApplication else { return 0 }
    if trusted, let el = axElement(axApp(front.processIdentifier), "AXFocusedWindow"), let id = axWindowID(el) { return id }
    let pid = Int(front.processIdentifier)
    for w in info where int(w[kCGWindowOwnerPID as String]) == pid && int(w[kCGWindowLayer as String]) == 0 {
      if let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value { return id }
    }
    return 0
  }

  // AX element for a CGWindowID: by _AXUIElementGetWindow, else by matching the CG frame.
  static func find(_ id: CGWindowID) -> (NSRunningApplication, AXUIElement)? {
    var pid = owner[id]
    var cgFrame: CGRect?
    if let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first {
      pid = pid ?? pid_t(int(info[kCGWindowOwnerPID as String]))
      if let b = info[kCGWindowBounds as String] as? NSDictionary { cgFrame = CGRect(dictionaryRepresentation: b as CFDictionary) }
    }
    guard let p = pid, let app = NSRunningApplication(processIdentifier: p) else { return nil }
    invalidate(p)
    if let w = axWindows(p)[id] { return (app, w.element) }
    if let f = cgFrame {
      for el in axElements(axApp(p), "AXWindows") {
        if let r = axFrame(el), abs(r.minX - f.minX) <= 1, abs(r.minY - f.minY) <= 1, abs(r.width - f.width) <= 1, abs(r.height - f.height) <= 1 {
          return (app, el)
        }
      }
    }
    return nil
  }

  // AXFrontmost goes through Accessibility, which isn't subject to macOS 14's cooperative activation
  // (a background process can't always activate another app with NSRunningApplication.activate).
  static func focus(_ id: CGWindowID) -> Bool {
    guard case let (app, el)? = find(id) else { return false }
    if app.isHidden { app.unhide() }
    if axBool(el, "AXMinimized") == true { axSet(el, "AXMinimized", kCFBooleanFalse) }
    axSet(axApp(app.processIdentifier), "AXFrontmost", kCFBooleanTrue)
    AXUIElementPerformAction(el, "AXRaise" as CFString)
    axSet(el, "AXMain", kCFBooleanTrue)
    axSet(el, "AXFocused", kCFBooleanTrue)
    app.activate(options: [.activateIgnoringOtherApps]) // deprecated in 14 but still honored; AXFrontmost does the real work
    invalidate(app.processIdentifier)
    return true
  }

  static func minimize(_ id: CGWindowID) -> Bool {
    guard case let (app, el)? = find(id) else { return false }
    axSet(el, "AXMinimized", kCFBooleanTrue)
    invalidate(app.processIdentifier)
    return true
  }

  // Polite close, like clicking the red button (apps may still ask to save).
  static func close(_ id: CGWindowID) -> Bool {
    guard case let (app, el)? = find(id), let button = axElement(el, "AXCloseButton") else { return false }
    let ok = AXUIElementPerformAction(button, "AXPress" as CFString) == .success
    invalidate(app.processIdentifier)
    return ok
  }

  // "Fill the screen" rather than pressing the green button: that one toggles native full screen
  // (its own Space) and a second press would undo it. Cubby calls maximize twice on purpose.
  static func maximize(_ id: CGWindowID) -> Bool {
    guard case let (app, el)? = find(id), let f = axFrame(el) else { return false }
    let center = CGPoint(x: f.midX, y: f.midY)
    let screens = screenFrames()
    guard let target = screens.first(where: { $0.frame.contains(center) }) ?? screens.first else { return false }
    var origin = target.visible.origin
    var size = target.visible.size
    // Size, position, size: some apps clamp the size to the screen they're currently on.
    if let s = AXValueCreate(.cgSize, &size) { axSet(el, "AXSize", s) }
    if let p = AXValueCreate(.cgPoint, &origin) { axSet(el, "AXPosition", p) }
    if let s = AXValueCreate(.cgSize, &size) { axSet(el, "AXSize", s) }
    invalidate(app.processIdentifier)
    return true
  }

  // NSScreen frames are Cocoa coordinates (origin bottom-left of the primary screen, y up). Flip to
  // the top-left space: y' = primaryHeight - maxY. NSScreen.screens[0] is the primary (menu bar)
  // screen, whose top-left is the global origin. Assumes that stays true with the menu bar moved.
  static func screenFrames() -> [(frame: CGRect, visible: CGRect)] {
    let read = { () -> [(frame: CGRect, visible: CGRect)] in
      guard let primary = NSScreen.screens.first else { return [] }
      let h = primary.frame.height
      let flip = { (r: CGRect) in CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height) }
      return NSScreen.screens.map { (frame: flip($0.frame), visible: flip($0.visibleFrame)) }
    }
    return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
  }
}
