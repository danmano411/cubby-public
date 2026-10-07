import AVFoundation
import Foundation
import Speech

// Voice commands with SFSpeechRecognizer, on-device only (macOS 13+): audio never leaves the Mac.
// Same line protocol as Windows' voice.ps1: {"event":"voice","line":"cmd|<phrase>|<confidence>"}.
// SAPI there matches a closed grammar; SFSpeech is free dictation, so each utterance's transcript is
// matched here against the phrase list (the longest phrase the utterance *ends with* wins, e.g.
// "hey cubby start" -> "cubby start"); utterances matching nothing are dropped.
// An utterance ends after 0.8s without new words (or at 50s, to stay clear of request limits).
// Any failure emits "voice-ended"; Cubby starts voice again 10s later, like a helper restart.
// Everything here runs on the main thread except the audio tap.
enum Voice {
  private static var recognizer: SFSpeechRecognizer?
  private static var engine: AVAudioEngine?
  private static var task: SFSpeechRecognitionTask?
  private static var settle: Timer?
  private static var maxLength: Timer?
  private static var generation = 0
  private static var phrases: [[String]] = [] // normalized words, longest phrase first
  private static var lastPartial = ""
  private static var errors = 0

  // The audio tap runs on an audio thread; it reads the current request through this lock.
  private static let reqLock = NSLock()
  private static var current: SFSpeechAudioBufferRecognitionRequest?

  static func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    default: return "undetermined"
    }
  }

  static func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    default: return "undetermined"
    }
  }

  static func requestAccess(_ kind: String) {
    if kind == "microphone" { AVCaptureDevice.requestAccess(for: .audio) { _ in } } else { SFSpeechRecognizer.requestAuthorization { _ in } }
  }

  static func norm(_ s: String) -> [String] {
    let kept = s.lowercased().unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "'" ? Character($0) : " " }
    return String(kept).split(separator: " ").map(String.init)
  }

  // m: { on, phrases: [string], wav?: path, locale?: "en-US" }
  static func configure(_ m: [String: Any]) {
    stop()
    guard bool(m["on"]) else { return }
    phrases = ((m["phrases"] as? [String]) ?? []).map(norm).filter { !$0.isEmpty }.sorted { $0.count > $1.count }
    let locale = Locale(identifier: m["locale"] as? String ?? "en-US")
    let wav = m["wav"] as? String
    let gen = generation
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async {
        guard gen == generation else { return } // stopped or reconfigured meanwhile
        guard status == .authorized else { return fail("speech recognition not allowed") }
        guard let r = SFSpeechRecognizer(locale: locale), r.isAvailable else { return fail("no recognizer for \(locale.identifier)") }
        guard r.supportsOnDeviceRecognition else { return fail("on-device recognition unavailable for \(locale.identifier)") }
        recognizer = r
        if let wav = wav { return recognizeFile(wav) }
        AVCaptureDevice.requestAccess(for: .audio) { ok in
          DispatchQueue.main.async {
            guard gen == generation else { return }
            ok ? startMic() : fail("microphone not allowed")
          }
        }
      }
    }
  }

  static func stop() {
    generation += 1
    settle?.invalidate(); settle = nil
    maxLength?.invalidate(); maxLength = nil
    if let e = engine { e.inputNode.removeTap(onBus: 0); e.stop() }
    engine = nil
    reqLock.lock(); current?.endAudio(); current = nil; reqLock.unlock()
    task?.cancel(); task = nil
    errors = 0
  }

  private static func fail(_ why: String) {
    logErr("voice: \(why)")
    stop()
    event("voice-ended", ["error": why])
  }

  private static func startMic() {
    let e = AVAudioEngine()
    let input = e.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { return fail("no microphone") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      reqLock.lock(); current?.append(buffer); reqLock.unlock()
    }
    e.prepare()
    do { try e.start() } catch { input.removeTap(onBus: 0); return fail("audio: \(error.localizedDescription)") }
    engine = e
    newUtterance()
  }

  // Start a fresh request; the previous one (if any) is ended and delivers its final result.
  private static func newUtterance() {
    guard let r = recognizer else { return }
    settle?.invalidate(); settle = nil
    maxLength?.invalidate()
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = true
    req.contextualStrings = phrases.map { $0.joined(separator: " ") }
    req.addsPunctuation = false
    reqLock.lock(); let old = current; current = req; reqLock.unlock()
    old?.endAudio()
    lastPartial = ""
    let gen = generation
    task = r.recognitionTask(with: req) { result, error in
      DispatchQueue.main.async { onResult(gen, req, result, error) }
    }
    maxLength = Timer.scheduledTimer(withTimeInterval: 50, repeats: false) { _ in if gen == generation { newUtterance() } }
  }

  private static func onResult(_ gen: Int, _ req: SFSpeechAudioBufferRecognitionRequest, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
    guard gen == generation else { return }
    let isCurrent: () -> Bool = { reqLock.lock(); defer { reqLock.unlock() }; return current === req }
    if let result = result, result.isFinal {
      errors = 0
      report(result.bestTranscription)
      return
    }
    if let result = result {
      guard isCurrent() else { return }
      let text = result.bestTranscription.formattedString
      if text != lastPartial {
        lastPartial = text
        settle?.invalidate()
        settle = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { _ in if gen == generation && isCurrent() { newUtterance() } }
      }
      return
    }
    if error != nil, isCurrent() {
      // "No speech detected" and similar end a request without a result; just listen again.
      errors += 1
      if errors > 20 { return fail("recognizer keeps failing: \(error!.localizedDescription)") }
      newUtterance()
    }
  }

  private static func report(_ t: SFTranscription) {
    let words = norm(t.formattedString)
    let segs = t.segments
    for p in phrases where words.count >= p.count && Array(words.suffix(p.count)) == p {
      // Segment confidences of the matched tail; SFSpeech sometimes reports 0 for all of them
      // ("unknown"): then a whole-utterance match counts as fairly sure, a tail match as unsure.
      let tail = segs.suffix(p.count).map { Double($0.confidence) }
      var conf = tail.isEmpty ? 0 : tail.reduce(0, +) / Double(tail.count)
      if conf == 0 { conf = words.count == p.count ? 0.85 : 0.5 }
      event("voice", ["line": "cmd|\(p.joined(separator: " "))|\(String(format: "%.2f", conf))"])
      return
    }
  }

  // Testing (CUBBY_VOICE_WAV): recognize a file once, report it, then end (Cubby restarts it, as on Windows).
  private static func recognizeFile(_ path: String) {
    guard let r = recognizer else { return }
    let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    req.requiresOnDeviceRecognition = true
    req.contextualStrings = phrases.map { $0.joined(separator: " ") }
    req.addsPunctuation = false
    let gen = generation
    task = r.recognitionTask(with: req) { result, error in
      DispatchQueue.main.async {
        guard gen == generation else { return }
        if let result = result, result.isFinal { report(result.bestTranscription); fail("end of file") }
        else if let error = error { fail("file: \(error.localizedDescription)") }
      }
    }
  }
}
