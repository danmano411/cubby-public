// Auto-update from GitHub Releases (danmano411/cubby-public), installed Windows builds only.
// Downloads in the background, then offers a restart; "Later" installs on the next quit.
//
// macOS is OFF on purpose: Squirrel.Mac verifies the update's code signature against the running
// app's, and our mac builds are unsigned (no Developer ID). Left on it would download every time and
// then fail to install. Mac users update by downloading the next dmg. When a Developer ID exists:
// drop the platform check, add `zip` to build.mac.target, and publish latest-mac.yml with releases.
const { app, dialog } = require('electron');

const EVERY_MS = 6 * 60 * 60 * 1000; // Cubby lives in the tray for days, so check more than once

const tell = (message, detail) => dialog.showMessageBox({ type: 'info', title: 'Cubby updates', message, detail, noLink: true });

// Returns checkNow(): Tray > "Check for updates", which says what it found (the background checks stay quiet).
function initUpdater(log = () => {}) {
  if (!app.isPackaged || process.platform !== 'win32') {
    return () => tell(`You have Cubby ${app.getVersion()}.`, app.isPackaged
      ? 'Updates install by themselves only on Windows. Get the newest dmg from github.com/danmano411/cubby-public/releases.'
      : 'This is a development copy; only the installed Cubby updates.');
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  let manual = false;
  // Offline, rate limits, no release yet: all fine, try again next time.
  autoUpdater.on('error', (err) => {
    log('updater', err.message);
    if (manual) tell("Cubby couldn't check for updates.", err.message);
    manual = false;
  });
  autoUpdater.on('update-not-available', () => {
    if (manual) tell(`Cubby ${app.getVersion()} is the newest version.`);
    manual = false;
  });
  autoUpdater.on('update-available', (info) => {
    if (manual) tell(`Cubby ${info.version} is out.`, "It's downloading now; Cubby will ask to restart when it's ready.");
    manual = false;
  });
  let asked = false;
  autoUpdater.on('update-downloaded', (info) => {
    if (asked) return; // one prompt per downloaded version
    asked = true;
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Cubby update ready',
      message: `Cubby ${info.version} has been downloaded.`,
      detail: 'Restart now to apply the update, or it will install the next time Cubby quits.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // errors logged above
  check();
  setInterval(check, EVERY_MS);
  return () => {
    manual = true;
    asked = false; // already downloaded and put off with "Later": ask again
    check();
  };
}

module.exports = { initUpdater };
