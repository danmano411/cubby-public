import CoreGraphics
import Foundation

// Newline-delimited JSON on stdout. Writes go through one serial queue so the key tap callback
// never blocks on a full pipe, and replies/events keep their order.
private let out = DispatchQueue(label: "cubby.out")

// Commands that touch AX / CG / NSWorkspace run here, one at a time (AX calls can be slow).
let work = DispatchQueue(label: "cubby.work")

func emit(_ obj: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(obj), var data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  data.append(0x0A)
  out.async { FileHandle.standardOutput.write(data) }
}

// One-shot CLI modes print synchronously and exit.
func printNow(_ obj: Any) {
  if let data = try? JSONSerialization.data(withJSONObject: obj) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
}

func event(_ name: String, _ fields: [String: Any] = [:]) {
  var o = fields
  o["event"] = name
  emit(o)
}

func reply(_ id: Any?, _ result: Any?, error: String? = nil) {
  guard let id = id else { return }
  var o: [String: Any] = ["id": id, "ok": error == nil]
  if let error = error { o["error"] = error } else { o["result"] = result ?? NSNull() }
  emit(o)
}

func logErr(_ msg: String) {
  FileHandle.standardError.write(Data((msg + "\n").utf8))
}

struct Failure: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}

func int(_ v: Any?, _ fallback: Int = 0) -> Int { (v as? NSNumber)?.intValue ?? fallback }
func bool(_ v: Any?) -> Bool { (v as? NSNumber)?.boolValue ?? false }
func rectDict(_ r: CGRect) -> [String: Any] {
  ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.size.width), "height": Double(r.size.height)]
}
