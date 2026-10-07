// Known apps per platform (catalog/{windows,mac}.json): match, launch and quirks, so configs can
// say "discord" instead of hand-written AUMIDs or bundle IDs.
const PLATFORM = process.platform === 'darwin' ? 'mac' : 'windows';
const load = (platform = PLATFORM) => require(`./catalog/${platform}.json`);
const entryId = (e) => (typeof e === 'string' ? e : e?.id);
const get = (id, platform) => load(platform).find((c) => c.id === id) || null;

// Group entry (catalog id or inline object) -> { id, name, category, match, launch, badgeOffset, tint },
// with per-app overrides from config.apps[id] applied. null = unknown id.
function resolve(entry, overrides = {}, platform) {
  const base = typeof entry === 'string' ? get(entry, platform) : entry;
  if (!base) return null;
  const o = overrides[base.id] || {};
  return { ...base, ...o, launch: { ...base.launch, ...o.launch } };
}

// Runtime copy of the config with every app resolved (unknown ids dropped; validate() reports them).
// music: the player app for this provider (inline entry wins over the provider's catalog app), or null.
function resolveConfig(config, provider, platform) {
  const res = (e) => resolve(e, config.apps, platform);
  let music = null;
  if (provider) {
    const { provider: _, ...inline } = config.music || {};
    music = res(inline.match ? inline : inline.app || provider.appRef);
    if (music) music.tint = music.tint || provider.tint;
  }
  return { ...config, groups: config.groups.map((g) => ({ ...g, apps: g.apps.map(res).filter(Boolean) })), music };
}

module.exports = { platform: PLATFORM, load, get, entryId, resolve, resolveConfig };
