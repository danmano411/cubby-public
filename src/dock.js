// Socials strip: every app in a ping group.
cubby.on('model', (m) => {
  const apps = m.groups.filter((g) => g.ping).flatMap((g) => g.apps);  const dock = document.getElementById('dock');
  dock.replaceChildren();
  const open = h('div', 'slot open-tray');
  open.title = 'Open Cubby';
  open.append(h('span', 'logo'));
  open.onclick = () => cubby.send('open-tray');
  dock.append(open, h('div', 'sep'));
  for (const a of apps) {
    const s = h('div', `slot ${a.running ? '' : 'closed'}`);
    s.title = a.running ? a.name : `${a.name} (not open, click to launch)`;
    s.append(iconEl(a.id, a.name, m.icons, m.tints));
    if (a.unread) s.append(h('span', 'badge', a.unread));
    else if (a.pinged) s.append(h('span', 'dot'));
    s.onclick = () => (a.running ? cubby.send('activate', a.windows[0].hwnd) : cubby.send('launch', a.id));
    dock.append(s);
  }
});
