// 'system' music provider on Windows: whatever app is playing (Spotify, a browser tab, Media Player, ...)
// through the system media controls. One long-running PowerShell helper (platform/windows/media.ps1) is
// shared by every provider instance: it is started on first use, restarted if it dies, and ends when
// Cubby does (it exits when its stdin closes).
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'platform', 'windows', 'media.ps1');
const RESTART_MS = 10000;

let proc = null;
let state = null; // last JSON line from the helper
let timer = null;

function start() {
  if (proc || timer || process.platform !== 'win32') return;
  const p = (proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true }));
  let buf = '';
  p.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      try { state = JSON.parse(buf.slice(0, i)); } catch {}
    }
  });
  p.stdin.on('error', () => {}); // EPIPE if it just died; the exit handler cleans up
  p.on('error', () => {});
  p.on('exit', () => {
    if (proc !== p) return;
    proc = null;
    state = null;
    timer = setTimeout(() => { timer = null; start(); }, RESTART_MS);
    timer.unref();
  });
  // Don't let the helper keep Cubby's event loop (or a smoke run) alive.
  p.unref();
  for (const s of [p.stdin, p.stdout, p.stderr]) s.unref?.();
}

// "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" -> "Spotify", "chrome.exe" -> "chrome", "Pkg.Name_hash!App" -> "Name"
function appName(id = '') {
  const [pkg, app] = String(id).split('!');
  if (app && !/^app$/i.test(app)) return app;
  return pkg.replace(/\.exe$/i, '').replace(/_.*$/, '').split('.').pop();
}

// The panel splits "Artist - Song"; sessions without an artist (browser tabs) show the app instead.
function format(s) {
  if (!s || !s.playing || !s.title) return null;
  const artist = s.artist || appName(s.app);
  return artist ? `${artist} - ${s.title}` : s.title;
}

module.exports = (adapter) => ({
  name: 'System media',
  // The strip needs a player app to show and launch; music.app in config.json picks another one.
  appRef: 'spotify',
  tint: null,
  nowPlaying: () => {
    start();
    return format(state);
  },
  control: (cmd) => {
    start();
    if (proc?.stdin.writable) proc.stdin.write(`${cmd}\n`);
    else adapter.mediaKey(cmd); // helper not up yet: the media key goes to the same current session
  },
});
module.exports.format = format;
