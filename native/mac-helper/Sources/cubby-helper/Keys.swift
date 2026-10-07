import AppKit
import CoreGraphics

// Global keys through a CGEventTap: the switch key (Option+Tab by default) and the other binds
// (search, media). Same rules as the Windows hook: modifiers must match exactly except Shift, which
// is free on binds that don't name it (Shift+switch = back); a swallowed key's key-up is swallowed too.
// An active (event-modifying) tap needs Accessibility; until it's granted, creation is retried every 5s.
struct KeySpec {
  let alt: Bool, ctrl: Bool, shift: Bool, cmd: Bool
  let key: Int64

  init?(_ v: Any?) {
    guard let d = v as? [String: Any], let k = d["key"] as? NSNumber else { return nil }
    alt = bool(d["alt"]); ctrl = bool(d["ctrl"]); shift = bool(d["shift"]); cmd = bool(d["cmd"])
    key = k.int64Value
  }

  func fits(_ m: CGEventFlags) -> Bool {
    alt == m.contains(.maskAlternate) && ctrl == m.contains(.maskControl) && cmd == m.contains(.maskCommand) && (!shift || m.contains(.maskShift))
  }
}

private let tapCallback: CGEventTapCallBack = { _, type, ev, _ in Keys.handle(type, ev) }

enum Keys {
  private static let lock = NSLock()
  private static var active = false
  private static var switchSpec: KeySpec?
  private static var take = false
  private static var binds: [(id: String, spec: KeySpec)] = []
  private static var releaseMask: CGEventFlags = .maskAlternate
  private static var prevFlags: CGEventFlags = []
  private static var swallowed = Set<Int64>()
  private static var tap: CFMachPort?
  private static var tapStarted = false
  private static var systemSwitcherOff = false

  // m: { switch: spec | null, take: bool, binds: [{ id, spec }] }; nil = unhook (the tap stays, idle).
  static func configure(_ m: [String: Any]?) {
    lock.lock()
    active = m != nil
    switchSpec = KeySpec(m?["switch"])
    take = bool(m?["take"])
    binds = ((m?["binds"] as? [[String: Any]]) ?? []).compactMap { b -> (id: String, spec: KeySpec)? in
      guard let id = b["id"] as? String, let s = KeySpec(b["spec"]) else { return nil }
      return (id, s)
    }
    // Letting go of the switch's modifier ends the switch session.
    if let s = switchSpec, !s.alt { releaseMask = s.cmd ? .maskCommand : s.ctrl ? .maskControl : .maskAlternate } else { releaseMask = .maskAlternate }
    let wantSystemOff = active && take && switchSpec.map { $0.cmd && $0.key == 48 && !$0.alt && !$0.ctrl } == true
    let started = tapStarted
    tapStarted = tapStarted || active
    let port = tap
    lock.unlock()

    setSystemSwitcher(off: wantSystemOff)
    if active && !started { Thread.detachNewThread { runTap() } }
    if let port = port, active, !CGEvent.tapIsEnabled(tap: port) { CGEvent.tapEnable(tap: port, enable: true) }
  }

  private static func runTap() {
    let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
    while true {
      if let port = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                      eventsOfInterest: mask, callback: tapCallback, userInfo: nil) {
        lock.lock(); tap = port; lock.unlock()
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        event("tap", ["ok": true])
        CFRunLoopRun()
        return
      }
      event("tap", ["ok": false, "error": "event tap refused (Accessibility / Input Monitoring not granted?)"])
      Thread.sleep(forTimeInterval: 5)
    }
  }

  // Runs on the tap thread for every key event system-wide: decide fast, report asynchronously.
  static func handle(_ type: CGEventType, _ ev: CGEvent) -> Unmanaged<CGEvent>? {
    let pass = Unmanaged.passUnretained(ev)
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      lock.lock(); let port = tap; lock.unlock()
      if let port = port { CGEvent.tapEnable(tap: port, enable: true) }
      event("tap", ["ok": true, "reenabled": type == .tapDisabledByTimeout ? "timeout" : "user-input"])
      return pass
    }
    lock.lock()
    defer { lock.unlock() }
    let flags = ev.flags
    if type == .flagsChanged {
      if active && prevFlags.contains(releaseMask) && !flags.contains(releaseMask) { event("release") }
      prevFlags = flags
      return pass
    }
    prevFlags = flags
    let code = ev.getIntegerValueField(.keyboardEventKeycode)
    if type == .keyUp { return swallowed.remove(code) != nil ? nil : pass }
    guard type == .keyDown, active else { return pass }
    let repeating = ev.getIntegerValueField(.keyboardEventAutorepeat) != 0
    for b in binds where b.spec.key == code && b.spec.fits(flags) {
      swallowed.insert(code)
      if !repeating { event("key", ["id": b.id]) } // holding the search key mustn't toggle the tray
      return nil
    }
    if let s = switchSpec, take, s.key == code, s.fits(flags) {
      swallowed.insert(code)
      event("switch", ["back": flags.contains(.maskShift) && !s.shift]) // repeats cycle, like holding Alt+Tab
      return nil
    }
    return pass
  }

  // Cmd+Tab takeover (experimental). The Dock's switcher is a "symbolic hotkey" handled before most
  // event taps see it, so it's switched off with the private CGSSetSymbolicHotKeyEnabled (as AltTab
  // does), looked up at runtime so a missing symbol only disables the takeover.
  // 1 = Cmd+Tab, 2 = Cmd+Shift+Tab.
  private typealias SetHotKey = @convention(c) (Int32, Bool) -> Int32
  private static let setHotKey: SetHotKey? = {
    let name = "CGSSetSymbolicHotKeyEnabled"
    var sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) // RTLD_DEFAULT
    if sym == nil, let h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY) { sym = dlsym(h, name) }
    return sym.map { unsafeBitCast($0, to: SetHotKey.self) }
  }()

  private static func setSystemSwitcher(off: Bool) {
    guard off != systemSwitcherOff, let f = setHotKey else { return }
    _ = f(1, !off)
    _ = f(2, !off)
    systemSwitcherOff = off
  }

  static func restoreSystemSwitcher() {
    guard let f = setHotKey else { return }
    _ = f(1, true)
    _ = f(2, true)
    systemSwitcherOff = false
  }
}
