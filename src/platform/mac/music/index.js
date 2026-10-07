// macOS music providers (plan §6): Spotify and Apple Music over AppleScript (osascript), with the
// same shape as src/music/index.js: (adapter) -> { name, appRef, tint, nowPlaying(app), control(cmd) }.
// nowPlaying must answer synchronously, so it returns the last answer and refreshes in the background
// (at most one osascript at a time, about once a second while the player has a window).
// Every script first checks "is running": a bare `tell application` would launch the player.
// The first call makes macOS ask "Cubby wants to control Spotify/Music" (Automation permission).
const { execFile } = require('child_process');

const osa = (lines) => new Promise((resolve) => {
  execFile('osascript', lines.flatMap((l) => ['-e', l]), { timeout: 3000 }, (err, out) => resolve(err ? null : String(out).trim()));
});

// Both players use the same dictionary terms for these.
const COMMANDS = { prev: 'previous track', play: 'playpause', next: 'next track' };

const nowPlayingScript = (bundleId) => [
  `if application id "${bundleId}" is running then`,
  `  tell application id "${bundleId}"`,
  '    if player state is playing then return (artist of current track) & " - " & (name of current track)',
  '  end tell',
  'end if',
  'return ""',
];

const controlScript = (bundleId, cmd) => [
  `if application id "${bundleId}" is running then`,
  `  tell application id "${bundleId}" to ${COMMANDS[cmd]}`,
  'end if',
];

function player({ name, appRef, bundleId, tint }) {
  return (adapter) => {
    let text = null;
    let at = 0;
    let busy = false;
    let running = false;
    const refresh = async () => {
      busy = true;
      text = (await osa(nowPlayingScript(bundleId))) || null; // "" = paused / stopped
      at = Date.now();
      busy = false;
    };
    return {
      name,
      appRef,
      tint,
      // app: the model's player app ({ running, windows }). Like Windows (title-based), no window = nothing shown.
      nowPlaying(app) {
        running = !!app?.running;
        if (!running) return (text = null);
        if (!busy && Date.now() - at > 900) refresh();
        return text;
      },
      // Player not seen running: fall back to the media keys (they reach whatever is playing).
      control(cmd) {
        if (!COMMANDS[cmd]) return;
        if (!running) return adapter.mediaKey(cmd);
        osa(controlScript(bundleId, cmd)).then(() => { at = 0; });
      },
    };
  };
}

module.exports = {
  spotify: player({ name: 'Spotify', appRef: 'spotify', bundleId: 'com.spotify.client', tint: '#1DB954' }),
  'apple-music': player({ name: 'Music', appRef: 'apple-music', bundleId: 'com.apple.Music', tint: '#FA2D48' }),
};
