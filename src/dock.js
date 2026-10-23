// Right-edge bar: the clock (clock.js) and/or the socials strip (every app in a ping group).
cubby.on('tuck', (on) => document.body.classList.toggle('tucked', on));
cubby.on('model', (m) => {
  document.getElementById('clock').hidden = !m.panels.clock;
  document.body.classList.toggle('joined', !!(m.panels.music && m.music));
  document.getElementById('split').hidden = !(m.panels.clock && m.panels.socials);
  const dock = document.getElementById('socials');
  dock.hidden = !m.panels.socials;
  const apps = m.groups.filter((g) => g.ping).flatMap((g) => g.apps);
  // The edge line (shown while the bar is hidden) glows for the socials' pings.
  document.body.dataset.edge = !m.panels.socials ? '' : apps.some((a) => a.unread) ? 'unread' : apps.some((a) => a.pinged) ? 'pinged' : '';
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
