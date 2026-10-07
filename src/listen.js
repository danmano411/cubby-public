// state: { mode: 'listening', hint } or { mode: 'heard', label, danger }
cubby.on('cue', (s) => {
  const cue = document.getElementById('cue');
  cue.className = s.mode + (s.danger ? ' danger' : '');
  cue.style.animation = 'none';
  void cue.offsetWidth;
  cue.style.animation = '';
  document.getElementById('title').textContent = s.mode === 'listening' ? 'Listening…' : s.label;
  document.getElementById('sub').textContent = s.mode === 'listening' ? s.hint || '' : 'Cubby';
});
