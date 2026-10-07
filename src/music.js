// Right-edge music panel: collapsed column; opens on a music key (Alt+[ / Alt+\ / Alt+] by default) or hover.
const card = document.getElementById('card');
let peeking = false;
let hovered = false;
let peekTimer;
let collapseTimer;
let s = null;

function setOpen() {
  clearTimeout(collapseTimer);
  if (peeking || hovered) card.classList.add('open');
  else collapseTimer = setTimeout(() => card.classList.remove('open'), 600);
}
// Each key press keeps it open another 2.5s, long enough to read the new track.
cubby.on('peek', () => {
  peeking = true;
  setOpen();
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => { peeking = false; setOpen(); }, 2500);
});
// The window is as wide as the expanded panel; only the card itself takes clicks.
card.onmouseenter = () => { hovered = true; cubby.send('music-hit', true); setOpen(); };
card.onmouseleave = () => { hovered = false; cubby.send('music-hit', false); setOpen(); };

const go = () => (s.running ? cubby.send('activate', s.windows[0].hwnd) : cubby.send('launch', s.id));
document.getElementById('info').onclick = go;

cubby.on('model', (m) => {
  s = m.music;
  if (!s) return; // provider 'none': main hides this window
  card.classList.toggle('off', !s.running);
  const [artist, ...song] = (s.nowPlaying || '').split(' - ');
  document.getElementById('song').textContent = s.nowPlaying ? song.join(' - ') || artist : s.running ? 'Paused' : s.name;
  document.getElementById('artist').textContent = s.nowPlaying ? artist : s.running ? s.name : 'Not open · click to launch';
  const keys = [m.keys.musicPrev, m.keys.musicPlay, m.keys.musicNext];
  document.getElementById('keys').textContent = keys.filter(Boolean).join(' · ');
  const col = document.getElementById('col');
  col.replaceChildren();
  const icon = iconEl(s.id, s.name, m.icons, m.tints);
  icon.onclick = go;
  col.append(icon);
  if (!s.running) return;
  for (const [k, label, key] of [['prev', '⏮', keys[0]], ['play', s.nowPlaying ? '⏸' : '▶', keys[1]], ['next', '⏭', keys[2]]]) {
    const b = h('button', k === 'play' ? 'play' : null, label);
    b.title = key || '';
    b.onclick = () => cubby.send('media', k);
    col.append(b);
  }
});
