const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const deadline = setTimeout(() => { console.error('FAIL: Electron timed out'); app.exit(1); }, 30000);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const painted = new Promise(resolve => window.webContents.once('paint', resolve));
  await window.loadURL('about:blank');
  await painted;
  assert.equal(window.webContents.getURL(), 'about:blank');
  const image = await window.webContents.capturePage();
  assert(!image.isEmpty(), 'Screenshot is empty');
  const png = image.toPNG();
  assert(png.length > 100, 'Screenshot PNG is too small');
  writeFileSync('screenshot.png', png);
  console.log(JSON.stringify({ result: 'PASS', electron: process.versions.electron, uid: process.getuid(), sandbox: true, screenshot: image.getSize(), bytes: png.length }));
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
