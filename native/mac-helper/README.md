# cubby-helper (macOS)

Cubby's native side on macOS: a small Swift command-line tool that `src/platform/mac` starts once
and talks to over stdio, one JSON object per line. Using a separate process means there's no native
Node addon to rebuild for every Electron version. It's the same pattern as the PowerShell helpers
on Windows.

**Status: experimental.** It was written without a Mac. It has never been compiled or run.
[Untested assumptions](#untested-assumptions) lists what to check first.

## Build

Requires Xcode 15+ (or its Command Line Tools) on macOS 13 or later.

```sh
cd native/mac-helper
swift build -c release                       # -> .build/release/cubby-helper (this Mac's arch)
codesign -s - --force .build/release/cubby-helper   # ad-hoc sign (see below)
```

Universal binary for a release build:

```sh
swift build -c release --arch arm64 --arch x86_64   # -> .build/apple/Products/Release/cubby-helper
codesign -s - --force .build/apple/Products/Release/cubby-helper
```

**Why sign it.** macOS ties privacy permissions (Accessibility, Input Monitoring, Screen Recording)
to a code signature. With an ad-hoc signature (`-s -`), a permission granted once still applies
after Cubby restarts. Without any signature, macOS may ask again after every rebuild.

**Where Cubby looks for the binary**, in this order:
1. `$CUBBY_HELPER`
2. `<Cubby.app>/Contents/Resources/cubby-helper` (packaged; `process.resourcesPath`)
3. `native/mac-helper/.build/release/cubby-helper`
4. `native/mac-helper/.build/apple/Products/Release/cubby-helper`

Packaging needs an electron-builder `extraResources` entry that copies the built binary to
`cubby-helper`. That entry isn't added yet.

## Try it by hand

```sh
.build/release/cubby-helper --permissions     # {"accessibility":false,"screenRecording":false,...}
.build/release/cubby-helper --list            # {"windows":[...],"foreground":1234}
printf '{"id":1,"cmd":"ping"}\n{"id":2,"cmd":"list"}\n' | .build/release/cubby-helper
```

Run from Terminal, macOS asks on behalf of **Terminal** (the "responsible process"). When Cubby
spawns the helper, every permission belongs to **Cubby.app**. So grant permissions to whichever one
you're testing with.

## Protocol

The helper reads one request per line from stdin, `{"id": <n>, "cmd": "<name>", ...params}`. It
answers each one with `{"id": <n>, "ok": true, "result": ...}` or
`{"id": <n>, "ok": false, "error": "..."}`. Events have no `id` and arrive at any time.

| cmd | params | result |
|---|---|---|
| `ping` | | `"pong"` |
| `permissions` | | `{ accessibility, screenRecording, inputMonitoring: bool, microphone, speech: "granted"\|"denied"\|"undetermined" }` |
| `requestPermission` | `kind`: one of the keys above | bool (shows the system prompt where there is one) |
| `list` | | `{ windows: [{ id, pid, title, name, bundleId, path, minimized, hidden, frame }], foreground }` |
| `focus` / `minimize` / `maximize` / `close` | `win` (CGWindowID) | bool |
| `quit` | `pid`, `force` (default true) | bool. Polite `terminate()`, then `forceTerminate()` after 1.5s if `force` |
| `icons` | `targets`: `["bundle:<id>" \| "<path>"]`, `size` (px, default 64) | `{ target: "data:image/png;base64,..." }` (missing ones left out) |
| `apps` | | `[{ name, bundleId, path }]` from /Applications, /System/Applications, ~/Applications (+ Finder) |
| `media` | `key`: `prev` \| `play` \| `next` | bool |
| `hookKeys` | `switch`: spec \| null, `take`: bool, `binds`: `[{ id, spec }]` | true. A spec is `{ alt, ctrl, shift, cmd, key }` (`key` = macOS virtual keycode) |
| `unhookKeys` | | true |
| `badges` | `on`: bool | true |
| `voice` | `on`, `phrases`: [string], `wav`?: path, `locale`?: `"en-US"` | true |

| event | fields | when |
|---|---|---|
| `switch` | `back` | the switch key was pressed (held Shift → `back`). Swallowed while `take` is true |
| `key` | `id` | a bind fired (its `id` is the accelerator string Cubby sent) |
| `release` | | the switch key's modifier (Option by default) was released |
| `tap` | `ok`, `error` / `reenabled` | event tap created / refused / re-enabled after `kCGEventTapDisabledByTimeout` |
| `badges` | `badges: { bundleId: label }` | Dock badges changed (the first scan is always sent) |
| `voice` | `line`: `"cmd\|<phrase>\|<confidence>"` | an utterance ended with one of the phrases |
| `voice-ended` | `error` | the recognizer stopped (Cubby restarts it after 10s) |
| `windows` | same as `list` + `reason` | an app activated / launched / quit / hid / unhid |

**Coordinates.** Window frames are global **top-left-origin points**: the origin is the primary
display's top-left corner and y grows downward. `CGWindowListCopyWindowInfo` and the AX
position/size attributes already use this space. Electron's `screen` API uses it on macOS too, so
`src/layout.js` and the frames agree with no conversion. Only `NSScreen` (Cocoa) is bottom-left
origin. `maximize` flips its frames with `y' = primaryHeight - maxY`, where the primary is
`NSScreen.screens[0]`. This assumes `NSScreen.screens[0]` is the screen whose top-left is the
global origin. Points are not pixels, so a 2x display reports the same numbers as Electron DIPs.

## Permissions used

| Permission | Used for | Without it |
|---|---|---|
| Accessibility | focus / minimize / close / fill-screen (AX), titles via AX, minimized windows, Dock badges, the event tap, posting media keys | windows are listed but can't be focused; no keys; no badges |
| Screen Recording | `kCGWindowName` (window titles) | titles fall back to AX titles (needs Accessibility), else the app name |
| Input Monitoring | reported only; some macOS versions want it for keyboard event taps | |
| Microphone + Speech Recognition | voice | voice stays off |

Cubby.app's Info.plist needs `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`
and `NSAppleEventsUsageDescription` (the music providers use AppleScript). Without them, macOS
kills the process at the first prompt.

## Untested assumptions

Nothing here has been compiled or run. Each item is something to check on a real Mac.

1. **It compiles.**
   - Static members are used without `Self.` inside escaping closures in the `enum` namespaces.
     If the compiler wants `Self.`, add it.
   - `guard case let (a, b)? = ...` destructuring.
   - The `#filePath` Info.plist path in `Package.swift`.
2. **`_AXUIElementGetWindow`** (private, via `@_silgen_name`) links from ApplicationServices and
   returns the CGWindowID. If it fails, `find()` falls back to matching frames.
3. **Electron's `BrowserWindow.getMediaSourceId()`** is `window:<CGWindowID>:0` on macOS. It's
   used by `handleOf`.
4. **Focus.** It sets `AXFrontmost` on the app, then `AXRaise` + `AXMain` on the window, then
   `NSRunningApplication.activate`. The assumption is that this beats macOS 14's cooperative
   activation from a background helper.
5. **Window filter.** It keeps windows that are on-screen, layer 0, alpha > 0, at least 50×50
   points, and owned by apps whose activation policy is `.regular`. Minimized windows and windows
   of hidden apps come from AX (subrole `AXStandardWindow`). Windows on other Spaces aren't
   listed.
6. **Front-to-back order** from `CGWindowListCopyWindowInfo` is used as "most recently used
   first".
7. **The event tap.**
   - It is an active `.cghidEventTap` / `.headInsertEventTap` tap. The assumption is that
     Accessibility is enough to create it (Input Monitoring is reported but not required).
   - Swallowing key-down and key-up keeps Option+Tab, Option+\` and Option+[ from typing
     characters.
   - It is re-enabled on `tapDisabledByTimeout` and `tapDisabledByUserInput`. Secure input,
     such as password fields, still blocks it.
8. **Cmd+Tab takeover (experimental).**
   - `CGSSetSymbolicHotKeyEnabled(1|2, false)` is looked up with `dlsym`, then from SkyLight.
   - It's restored on unhook, SIGTERM/INT/HUP, and stdin EOF, and at every helper start in case
     of a SIGKILL.
   - If the symbol is missing, the tap alone tries to swallow Cmd+Tab, which probably won't beat
     the Dock.
9. **Media keys.**
   - NX_KEYTYPE_PLAY / NEXT / PREVIOUS (16 / 17 / 18) are posted as `NSEvent.otherEvent`
     subtype 8 with data1 `(code << 16) | (0xA|0xB << 8)`. macOS is assumed to route them to the
     Now Playing app.
   - Posting may need Accessibility.
10. **Dock badges.**
    - The Dock's AX tree is `AXList` → `AXApplicationDockItem` with `AXStatusLabel`, `AXURL`
      (the .app URL) and `AXIsApplicationRunning`.
    - The labels are assumed to be digits or a symbol, which Cubby's `parseBadge` turns into a
      count or a dot.
11. **Voice.**
    - On-device SFSpeech with partial results; 0.8s of no new words ends an utterance, and the
      next request starts right away (two tasks overlap briefly).
    - Final results are assumed to arrive after `endAudio()`.
    - Segment confidences are averaged; when all are 0, the helper reports 0.85 for a match of
      the whole utterance and 0.5 for a match at its end.
    - No silence detection beyond this, and no mic-change handling: a failure leads to
      `voice-ended`, and Cubby restarts voice.
12. **TCC attribution.**
    - Permissions follow the responsible process (Cubby.app), so the Info.plist embedded here
      only matters when the helper runs standalone.
    - The `-sectcreate __TEXT __info_plist` linker flag works with `swift build`.
13. **`NSWorkspace` notifications** and `frontmostApplication` update in a plain CLI process,
    because the main thread runs `RunLoop.main`.
14. **Coordinates.** See above. Electron's display bounds and CG window bounds are assumed to share
    one top-left-origin point space with every arrangement, including displays above or left of
    the primary.
