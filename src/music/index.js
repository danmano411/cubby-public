// Music player providers (plan §6). A provider is
//   { name, appRef, tint, nowPlaying(app) -> string | null, control(cmd) }
// appRef: catalog id of the player app (shown in the strip / panel, launched on click).
// nowPlaying gets the model's music app ({ running, windows: [{ title }] }); cmd: 'prev' | 'play' | 'next'.
// 'none' has no provider: the strip, the panel and the media keys are hidden.
// A platform adapter can supply its own (adapter.musicProviders, e.g. AppleScript on macOS); those win.
const PROVIDERS = {
  // Spotify's window title is "Artist - Song" while playing and "Spotify ..." when paused.
  spotify: (adapter) => ({
    name: 'Spotify',
    appRef: 'spotify',
    tint: '#1DB954',
    nowPlaying: (app) => app.windows.find((w) => !/^spotify/i.test(w.title))?.title || null,
    control: (cmd) => adapter.mediaKey(cmd),
  }),
  system: (adapter) => require('./system-windows')(adapter), // Windows only for now
  none: () => null,
};
// 'apple-music' exists only through the mac adapter.
const BY_PLATFORM = { win32: ['spotify', 'system', 'none'], darwin: ['spotify', 'apple-music', 'none'] };

// What config.music.provider may be on this platform.
const names = (platform = process.platform) => BY_PLATFORM[platform] || ['none'];
const get = (name, adapter) => {
  const make = names().includes(name) && ((adapter?.musicProviders || {})[name] || PROVIDERS[name]);
  return make ? make(adapter) : null;
};

module.exports = { names, get };
