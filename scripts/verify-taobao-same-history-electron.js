'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const VERIFY_TIMEOUT_MS = 15000

function withTimeout(promise, timeoutMs = VERIFY_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`verification timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runVerification() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: `dxe-taobao-history-verification-${process.pid}`,
      contextIsolation: false,
      sandbox: false
    }
  })

  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'taobao-same-history-electron.html'))
    const modulePath = path.join(
      __dirname,
      '..',
      'src',
      'renderer',
      'src',
      'utils',
      'taobaoSameHistory.js'
    )
    const browserSource = fs.readFileSync(modulePath, 'utf8')
      .replace(/\bexport\s+/g, '') +
      '\nwindow.__dxeTaobaoHistoryVerify = { readTaobaoSameHistory, saveTaobaoSameHistory }; true;'
    await win.webContents.executeJavaScript(browserSource)

    const result = await withTimeout(win.webContents.executeJavaScript(`
      (async function() {
        if (!window.indexedDB) throw new Error('IndexedDB is unavailable');
        localStorage.clear();
        var api = window.__dxeTaobaoHistoryVerify;
        var missing = await api.readTaobaoSameHistory(localStorage, 'electron-missing', Date.now(), 1000);
        var saved = await api.saveTaobaoSameHistory(localStorage, 'electron-saved', [
          { itemId: '10001', link: 'https://item.taobao.com/item.htm?id=10001', title: 'Electron IndexedDB' }
        ], Date.now());
        var restored = await api.readTaobaoSameHistory(localStorage, 'electron-saved', Date.now(), 1000);
        var database = await new Promise(function(resolve, reject) {
          var request = indexedDB.open('dianxiaoer-taobao-same-history', 1);
          request.onsuccess = function() { resolve(request.result); };
          request.onerror = function() { reject(request.error || new Error('open failed')); };
        });
        var count = await new Promise(function(resolve, reject) {
          var request = database.transaction('entries', 'readonly').objectStore('entries').count();
          request.onsuccess = function() { resolve(request.result); };
          request.onerror = function() { reject(request.error || new Error('count failed')); };
        });
        database.close();
        return {
          missingIsNull: missing === null,
          saved: saved === true,
          restoredItemId: restored && restored.products && restored.products[0] && restored.products[0].itemId,
          countType: typeof count,
          count: count
        };
      })()
    `))

    if (!result.missingIsNull) throw new Error('missing get did not settle as cache miss')
    if (!result.saved) throw new Error('save did not succeed')
    if (result.restoredItemId !== '10001') throw new Error('saved record was not restored')
    if (result.countType !== 'number' || result.count < 1) throw new Error('count did not return a number')
    process.stdout.write(`ELECTRON_INDEXEDDB_VERIFY_OK ${JSON.stringify(result)}\n`)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

app.whenReady()
  .then(runVerification)
  .then(() => {
    process.exitCode = 0
    app.quit()
  })
  .catch(error => {
    process.stderr.write(`ELECTRON_INDEXEDDB_VERIFY_FAILED ${error.stack || error.message}\n`)
    app.exit(1)
  })
