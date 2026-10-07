// Shared bits for overlay / dock / toast.
const HUES = [225, 195, 155, 35, 350, 100, 15, 180]; // muted, no purple
// tints[id]: paint a white Store-app glyph in brand color, using the icon as a stencil
// (e.g. Spotify's white logo -> green circle; its transparent stripes stay see-through).
function iconEl(id, name, icons, tints) {
  const el = document.createElement('div');
  el.className = 'icon';
  if (icons && icons[id] && tints && tints[id]) {
    el.style.background = tints[id];
    el.style.webkitMask = `url(${icons[id]}) center / contain no-repeat`;
  } else if (icons && icons[id]) el.style.backgroundImage = `url(${icons[id]})`;
  else {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    el.style.background = `hsl(${HUES[h % HUES.length]} 28% 42%)`;
    el.textContent = name.slice(0, 1).toUpperCase();
  }
  return el;
}

// "Chat | Personal | me@x.com | Microsoft Teams" -> "Chat | Personal"; "YouTube - Google Chrome" -> "YouTube"
function cleanTitle(title, appName) {
  const t = title
    .replace(/\s*[-|·–]\s*(Google Chrome|Microsoft Teams|Slack|Discord|Notion Calendar|Notepad|File Explorer|Arc)\s*$/i, '')
    .replace(/\s*\|\s*[^\s|]+@[^\s|]+/g, '');
  return t === appName ? '' : t;
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
