// Auto-update from GitHub Releases (danmano411/cubby-public), installed Windows builds only.
// Downloads in the background, then offers a restart; "Later" installs on the next quit.
//
// macOS is OFF on purpose: Squirrel.Mac verifies the update's code signature against the running
// app's, and our mac builds are unsigned (no Developer ID). Left on it would download every time and
// then fail to install. Mac users update by downloading the next dmg. When a Developer ID exists:
// drop the platform check, add `zip` to build.mac.target, and publish latest-mac.yml with releases.
const { app, dialog } = require('electron');

const EVERY_MS = 6 * 60 * 60 * 1000; // Cubby lives in the tray for days, so check more than once

function initUpdater(log = () => {}) {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  // Offline, rate limits, no release yet: all fine, try again next time.
  autoUpdater.on('error', (err) => log('updater', err.message));
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
}

module.exports = { initUpdater };
