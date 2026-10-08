// Platform adapter for this OS. main.js and session.js talk only to this, never to OS APIs.
//
// Interface (every adapter exports all of these; `win` is a window handle number from listWindows):
//   listWindows({ excludePid }) -> [{ hwnd, title, pid, exePath, exe, minimized }]  switcher-worthy
//                                  top-level windows, most recently used first. exe is lowercased basename.
//   focus(win)  minimize(win)  maximize(win)  close(win)   close = polite (like clicking X)
//   foreground() -> win          isWindow(win) -> bool
//   windowRect(win, { excludePid }) -> { x, y, width, height } | null   on-screen rect in DIP (Electron's
//                                  screen space); null when minimized / hidden / cloaked, the desktop /
//                                  taskbar, or a window of excludePid
//   handleOf(browserWindow) -> win              our own Electron window as a handle for focus()
//   forceForeground(win) -> bool   (optional)   bring one of OUR windows to the front without synthetic input
//   keepOnTop(win) -> bool         lift one of OUR topmost windows back above ordinary windows if it slipped
//                                  under them; true = it had to
//   mediaKey(cmd)                cmd: 'prev' | 'play' | 'next'
//   parseAccelerator(accel) -> spec | null      "Alt+Tab", "Alt+`", "Alt+\\" ... null = can't hook it
//   hookKeys({ switchKey, takeSwitch(), onSwitch(back), onRelease(), binds: { accel: fn } }) -> unhook | null
//                                  switchKey is claimed only while takeSwitch() is true; onRelease fires when
//                                  its modifier is let go. null = hook couldn't be installed.
//   onShellEvents(browserWindow, { flash(win), activate(win), create(win), destroy(win) })
//   launch(launchSpec)           { uri } | { appId } | { exe } (Windows) / { bundleId } | { path } (mac)
//   quitApp({ pid, exe }, { force = true }) -> bool    false = protected process, left alone
//   isProtected({ pid, exe }) -> bool                  e.g. explorer.exe: close windows, never kill
//   iconTarget(app) -> string | null                   cache key / render target for an app's icon
//   renderIcons(targets) -> Promise<{ [target]: dataUrl }>  only the ones that rendered. Call it freely: the
//                                  adapter queues it (Windows: one helper at a time, failed/hung targets not retried)
//   startBadgeWatcher(onBadges({ [appId]: text })) -> stop
//   startVoice({ phrases: [string], wav? }, onLine("<grammar>|<text>|<confidence>")) -> stop
//   listInstalledApps() -> Promise<[{ name, launch }]>
//   removeStaleLoginItems(keepName, commandParts)      login items left by an older app id
// Long-running helpers (badges, voice) restart themselves after a crash until stop() is called.
const ADAPTERS = { win32: './windows', darwin: './mac' };
if (!ADAPTERS[process.platform]) throw new Error(`Cubby doesn't support ${process.platform} yet`);
module.exports = require(ADAPTERS[process.platform]);
