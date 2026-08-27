'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const phase = process.argv.find(argument => argument.startsWith('--phase='))?.split('=')[1]

function runParent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-storage-electron-'))
  const htmlPath = path.join(root, 'history.html')
  fs.writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8"><title>storage-smoke</title>`, 'utf8')
  const electronPath = require('electron')
  try {
    for (const childPhase of ['seed', 'migrate']) {
      const result = childProcess.spawnSync(electronPath, [__filename, `--phase=${childPhase}`], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DXE_STORAGE_SMOKE_ROOT: root },
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true
      })
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      assert.equal(result.error, undefined, `${childPhase} Electron process failed: ${result.error?.message}`)
      assert.equal(result.status, 0, `${childPhase} Electron process exited with ${result.status}`)
    }
    console.log('STORAGE_MIGRATION_ELECTRON PASS cookie+localStorage+indexedDB preserved, C-profile cleanup verified')
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

async function waitForIndexedDbValue(webContents, mode) {
  return webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const request = indexedDB.open('dianxiaoer-taobao-same-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('searches');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (${JSON.stringify(mode)} === 'write') {
          const tx = db.transaction('searches', 'readwrite');
          tx.objectStore('searches').put({products: [{itemId: '10001'}]}, 'history-key');
          tx.oncomplete = () => { db.close(); resolve('written'); };
          tx.onerror = () => reject(tx.error);
        } else {
          const tx = db.transaction('searches', 'readonly');
          const get = tx.objectStore('searches').get('history-key');
          get.onsuccess = () => { db.close(); resolve(get.result || null); };
          get.onerror = () => reject(get.error);
        }
      };
    })
  `, true)
}

async function runElectronPhase() {
  const root = process.env.DXE_STORAGE_SMOKE_ROOT
  assert.ok(root, 'DXE_STORAGE_SMOKE_ROOT is required')
  const { app, BrowserWindow, session } = require('electron')
  const legacyUserData = path.join(root, 'legacy-user-data')
  const localAppData = path.join(root, 'local-app-data')
  const dataRoot = path.join(root, 'install-drive', 'dianxiaoer-data')
  const htmlPath = path.join(root, 'history.html')
  fs.mkdirSync(legacyUserData, { recursive: true })
  fs.mkdirSync(localAppData, { recursive: true })
  app.setPath('userData', legacyUserData)
  app.setPath('sessionData', legacyUserData)

  let storageManager = null
  let context = null
  if (phase === 'migrate') {
    storageManager = require('../src/main/storage-manager')
    context = storageManager.initializeStorage(app, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })
    assert.equal(context.usingManagedStorage, true)
    assert.equal(app.getPath('sessionData'), context.paths.sessionDataDir)
    const updaterModule = require('../src/main/updater')
    const actualAutoUpdater = updaterModule.getAutoUpdater()
    assert.equal(
      updaterModule.configureUpdaterCacheBase(actualAutoUpdater, context.paths.updaterCacheBaseDir),
      true
    )
    assert.equal(actualAutoUpdater.app.baseCachePath, context.paths.updaterCacheBaseDir)
  }

  await app.whenReady()
  const partitionName = 'persist:platform-42'
  const platformSession = session.fromPartition(partitionName)
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    await win.loadFile(htmlPath)
    if (phase === 'seed') {
      await platformSession.cookies.set({
        url: 'https://shop.jd.com',
        name: 'dxe_storage_migration',
        value: 'cookie-preserved',
        expirationDate: Math.floor(Date.now() / 1000) + 86400
      })
      await win.webContents.executeJavaScript(`localStorage.setItem('dxe-setting', 'setting-preserved')`, true)
      const written = await waitForIndexedDbValue(win.webContents, 'write')
      assert.equal(written, 'written')
      platformSession.flushStorageData()
      await new Promise(resolve => setTimeout(resolve, 500))
      console.log('STORAGE_MIGRATION_ELECTRON seed complete')
    } else {
      assert.equal(session.defaultSession.storagePath, context.paths.sessionDataDir)
      assert.ok(platformSession.storagePath.startsWith(path.join(context.paths.sessionDataDir, 'Partitions')))
      const cookies = await platformSession.cookies.get({ name: 'dxe_storage_migration' })
      assert.equal(cookies[0]?.value, 'cookie-preserved')
      const setting = await win.webContents.executeJavaScript(`localStorage.getItem('dxe-setting')`, true)
      assert.equal(setting, 'setting-preserved')
      const history = await waitForIndexedDbValue(win.webContents, 'read')
      assert.equal(history?.products?.[0]?.itemId, '10001')
      assert.equal(fs.existsSync(path.join(legacyUserData, 'Partitions')), true)

      const finalized = await storageManager.confirmStorageAndCleanup(app, session)
      assert.deepEqual(finalized, { success: true, skipped: false, status: 'committed' })
      assert.equal(fs.existsSync(path.join(legacyUserData, 'Partitions')), false)
      assert.equal(fs.existsSync(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-42', 'Network', 'Cookies')), true)
      console.log('STORAGE_MIGRATION_ELECTRON migrate complete')
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    app.quit()
  }
}

if (!process.versions.electron) {
  runParent()
} else {
  runElectronPhase().catch(error => {
    console.error('STORAGE_MIGRATION_ELECTRON FAIL ' + String(error?.stack || error))
    require('electron').app.exit(1)
  })
}
