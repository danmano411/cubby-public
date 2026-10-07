import AppKit
import ApplicationServices

// Dock badges (the red "3" / "•"): each Dock tile exposes its badge text as AXStatusLabel. Polled
// every 2s like the Windows taskbar scan; emits { "badges": { "<bundle id>": "<label>" } } whenever
// the map changes (the first scan always). Needs Accessibility.
enum Badges {
  private static let queue = DispatchQueue(label: "cubby.badges")
  private static var timer: DispatchSourceTimer?
  private static var last: [String: String]?

  static func set(on: Bool) {
    queue.async {
      timer?.cancel()
      timer = nil
      last = nil
      guard on else { return }
      let t = DispatchSource.makeTimerSource(queue: queue)
      t.schedule(deadline: .now(), repeating: 2)
      t.setEventHandler { scan() }
      t.resume()
      timer = t
    }
  }

  private static func scan() {
    guard AXIsProcessTrusted(),
          let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else { return }
    let root = AXUIElementCreateApplication(dock.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1)
    var out: [String: String] = [:]
    for list in axElements(root, "AXChildren") where axString(list, "AXRole") == "AXList" {
      for item in axElements(list, "AXChildren") where axString(item, "AXSubrole") == "AXApplicationDockItem" {
        guard let label = axString(item, "AXStatusLabel"), !label.isEmpty else { continue }
        // A pinned tile of a quit app can keep a stale badge; only running apps count (as on Windows).
        if axBool(item, "AXIsApplicationRunning") == false { continue }
        let url = axValue(item, "AXURL") as? URL
        let key = url.flatMap { Bundle(url: $0)?.bundleIdentifier } ?? axString(item, "AXTitle") ?? ""
        if !key.isEmpty { out[key] = label }
      }
    }
    if out != last {
      last = out
      event("badges", ["badges": out])
    }
  }
}

enum Permissions {
  // Cubby's first-run screen shows these and deep-links to System Settings (src/platform/mac).
  // Spawned by Cubby.app, macOS checks the *app* (the responsible process), not this binary.
  static func status() -> [String: Any] {
    [
      "accessibility": AXIsProcessTrusted(),
      "screenRecording": CGPreflightScreenCaptureAccess(),
      "inputMonitoring": CGPreflightListenEventAccess(),
      "microphone": Voice.micStatus(),
      "speech": Voice.speechStatus(),
    ]
  }

  // Shows the system prompt where macOS has one (each only once per app; after that, Settings).
  static func request(_ kind: String) -> Bool {
    switch kind {
    case "accessibility":
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      return AXIsProcessTrustedWithOptions(opts)
    case "screenRecording": return CGRequestScreenCaptureAccess()
    case "inputMonitoring": return CGRequestListenEventAccess()
    case "microphone", "speech": Voice.requestAccess(kind); return true
    default: return false
    }
  }
}

// App launched / quit / activated / hidden: refresh the window list right away and push it, so
// Cubby's cached list (and its activate / create / destroy events) doesn't wait for the next poll.
enum Workspace {
  private static var observers: [NSObjectProtocol] = []

  static func start() {
    let nc = NSWorkspace.shared.notificationCenter
    let names: [(Notification.Name, String)] = [
      (NSWorkspace.didActivateApplicationNotification, "activate"),
      (NSWorkspace.didLaunchApplicationNotification, "launch"),
      (NSWorkspace.didTerminateApplicationNotification, "terminate"),
      (NSWorkspace.didHideApplicationNotification, "hide"),
      (NSWorkspace.didUnhideApplicationNotification, "unhide"),
    ]
    for (name, kind) in names {
      observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { note in
        let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
        work.async {
          Windows.invalidate(pid)
          var r = Windows.list()
          r["reason"] = kind
          event("windows", r)
        }
      })
    }
  }
}
