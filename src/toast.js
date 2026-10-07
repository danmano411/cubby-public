cubby.on('toast', (t) => {
  const el = document.getElementById('toast');
  el.replaceChildren();
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  const text = h('div', 'text');
  text.append(h('div', 'name', t.headline || `${t.name} wants you`), h('div', 'sub', (t.name ? cleanTitle(t.title, t.name) : t.title) || 'New activity'));
  const x = h('button', 'x', '✕');
  x.onclick = (e) => { e.stopPropagation(); cubby.send('toast-close'); };
  el.append(iconEl(t.id, t.name || 'Cubby', { [t.id]: t.icon }), text, x);
  el.onclick = () => cubby.send('toast-click', t.hwnd);
});
