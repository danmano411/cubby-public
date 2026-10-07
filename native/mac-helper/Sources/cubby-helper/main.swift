// cubby-helper: Cubby's macOS side. One long-lived process, driven by src/platform/mac over stdio.
//   stdin:  {"id": 1, "cmd": "list", ...params}                     one request per line
//   stdout: {"id": 1, "ok": true, "result": ...} | {"id": 1, "ok": false, "error": "..."}
//           {"event": "key" | "switch" | "release" | "badges" | "voice" | "voice-ended" | "windows" | "tap", ...}
// One-shot modes for synchronous checks: `cubby-helper --permissions`, `cubby-helper --list`.
// Exits when stdin closes (Cubby quit or crashed), restoring Cmd+Tab if it was taken over.
import AppKit
import Foundation

signal(SIGPIPE, SIG_DFL) // parent gone mid-write: just die

let args = CommandLine.arguments
if args.contains("--permissions") { printNow(Permissions.status()); exit(0) }
if args.contains("--list") { printNow(Windows.list()); exit(0) }

// An earlier run killed with SIGKILL can't have restored the system switcher; do it now.
Keys.restoreSystemSwitcher()

func shutdown() -> Never {
  Keys.restoreSystemSwitcher()
  exit(0)
}

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  s.setEventHandler { shutdown() }
  s.resume()
  signalSources.append(s)
}

func win(_ m: [String: Any]) -> CGWindowID { CGWindowID(truncatingIfNeeded: int(m["win"])) }

func run(_ cmd: String, _ m: [String: Any]) throws -> Any {
  switch cmd {
  case "ping": return "pong"
  case "permissions": return Permissions.status()
  case "requestPermission": return Permissions.request(m["kind"] as? String ?? "")
  case "list": return Windows.list()
  case "focus": return Windows.focus(win(m))
  case "minimize": return Windows.minimize(win(m))
  case "maximize": return Windows.maximize(win(m))
  case "close": return Windows.close(win(m))
  case "quit": return Apps.quit(pid: pid_t(truncatingIfNeeded: int(m["pid"])), force: m["force"] == nil || bool(m["force"]))
  case "icons": return Apps.icons(m["targets"] as? [String] ?? [], size: int(m["size"], 64))
  case "apps": return Apps.installed()
  case "media": return Media.press(m["key"] as? String ?? "")
  default: throw Failure("unknown command \(cmd)")
  }
}

func handle(_ m: [String: Any]) {
  guard let cmd = m["cmd"] as? String else { return }
  let id = m["id"]
  switch cmd {
  case "hookKeys": Keys.configure(m); reply(id, true)
  case "unhookKeys": Keys.configure(nil); reply(id, true)
  case "badges": Badges.set(on: bool(m["on"])); reply(id, true)
  case "voice": DispatchQueue.main.async { Voice.configure(m); reply(id, true) }
  default:
    work.async {
      do { reply(id, try run(cmd, m)) } catch { reply(id, nil, error: "\(error)") }
    }
  }
}

Workspace.start()

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    handle(m)
  }
  DispatchQueue.main.async { shutdown() }
}

RunLoop.main.run()
