// Stand-in for cubby-helper that speaks the same stdio protocol, so the Node client can be tested
// on any OS. Commands: ping, list, slow (never answers), fail (error reply), crash (exits 1).
// hookKeys answers and then emits a "switch" event, so tests can see standing state being replayed.
const readline = require('readline');

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  switch (m.cmd) {
    case 'ping': return out({ id: m.id, ok: true, result: 'pong' });
    case 'list': return out({ id: m.id, ok: true, result: { windows: [{ id: 7, pid: 42, title: '', name: 'Notes', bundleId: 'com.apple.Notes', path: '/System/Applications/Notes.app', minimized: false, hidden: false, frame: { x: -2560, y: -680, width: 800, height: 600 } }], foreground: 7 } });
    case 'fail': return out({ id: m.id, ok: false, error: 'nope' });
    case 'slow': return undefined;
    case 'crash': return process.exit(1);
    case 'hookKeys': out({ id: m.id, ok: true, result: true }); return out({ event: 'switch', back: !!m.take });
    default: return out({ id: m.id, ok: false, error: `unknown command ${m.cmd}` });
  }
});
