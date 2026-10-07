// What icons.ps1 renders for an app: shell:AppsFolder\<AppID> (Start-menu quality, works for closed
// and Store apps) or the exe path. Pure, so it's testable off Windows.
const path = require('path').win32;

const APPS_FOLDER = 'shell:::{4234d49b-0245-4df3-b780-3893943456e1}\\';
const expandEnv = (s) => s.replace(/%([^%]+)%/g, (_, k) => process.env[k] || '');

// The shell's image factory never returns for some Start-menu ids, and the helper then hangs for
// good: "{KnownFolderGuid}\x.exe" ids (rendered from the real path instead) and Office's
// "Microsoft.Office.X.EXE.15" (no icon: the tray shows a letter tile).
const KNOWN_FOLDERS = {
  '1AC14E77-02E7-4E5D-B744-2EB1AE5198B7': '%WINDIR%\\System32', 'D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27': '%WINDIR%\\SysWOW64',
  '6D809377-6AF0-444B-8957-A3773F02200E': '%ProgramFiles%', '7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E': '%ProgramFiles(x86)%',
  'F38BF404-1D43-42F2-9305-67DE0B28FC23': '%WINDIR%', 'A77F5D77-2E2B-44C3-A6A2-ABA601054A51': '%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs',
};

// Network paths (\\server\share\...) are skipped too: the shell waits on the server, ~25s for one that
// is offline, per item. Their apps get letter tiles.
const local = (p) => (/^[\\/]{2}(?![?.][\\/])/.test(p) ? null : p);

function iconTarget(app, expand = expandEnv) {
  const id = app.launch?.appId;
  const exe = app.launch?.exe;
  if (!id) return exe ? local(path.normalize(expand(exe))) : null;
  const m = /^\{([0-9A-F-]{36})\}\\(.+)$/i.exec(id);
  if (m) {
    const dir = KNOWN_FOLDERS[m[1].toUpperCase()];
    return dir ? local(path.normalize(expand(path.join(dir, m[2])))) : null;
  }
  return /\.exe\.\d+$/i.test(id) || !local(id) ? null : APPS_FOLDER + id;
}

module.exports = { iconTarget, expandEnv };
