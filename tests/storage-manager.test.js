import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import storageManager from '../src/main/storage-manager.js'
import updaterModule from '../src/main/updater.js'

const {
  confirmStorageAndCleanup,
  initializeStorage,
  resetStorageContextForTests,
  resolveInstallDataRoot,
  runCacheMaintenanceBeforeReady
} = storageManager
const { configureUpdaterCacheBase } = updaterModule

const temporaryRoots = []

function makeTemporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-storage-manager-'))
  temporaryRoots.push(root)
  return root
}

function writeFile(filePath, value = 'data') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

function createFakeApp(userDataPath) {
  const paths = {
    userData: userDataPath,
    sessionData: userDataPath,
    temp: path.join(userDataPath, 'Temp')
  }
  const setCalls = []
  return {
    isPackaged: true,
    getPath(name) {
      return paths[name]
    },
    setPath(name, value) {
      paths[name] = value
      setCalls.push({ name, value })
    },
    paths,
    setCalls
  }
}

function seedLegacyData(root) {
  const userData = path.join(root, 'roaming', 'dianxiaoer-shop-manager')
  const localAppData = path.join(root, 'local')
  writeFile(path.join(userData, 'Partitions', 'platform-12', 'Network', 'Cookies'), 'platform-cookie')
  writeFile(path.join(userData, 'Partitions', 'platform-12', 'Local Storage', 'leveldb', '000001.log'), 'shop-setting')
  writeFile(path.join(userData, 'IndexedDB', 'file__0.indexeddb.leveldb', '000003.log'), 'taobao-same-history')
  writeFile(path.join(userData, 'blob_storage', 'indexed-db-blob'), 'business-blob')
  writeFile(path.join(userData, 'Local Storage', 'leveldb', '000004.log'), 'renderer-setting')
  writeFile(path.join(userData, 'Local State'), '{"os_crypt":{"encrypted_key":"preserved"}}')
  writeFile(path.join(userData, 'Partitions', 'platform-12', 'Cache', 'Cache_Data', 'data_3'), 'large-cache')
  writeFile(path.join(userData, 'Partitions', 'platform-12', 'Code Cache', 'js', 'compiled'), 'code-cache')
  writeFile(path.join(userData, 'device-id.json'), '{"device":"keep-on-c"}')
  writeFile(path.join(userData, 'aftersale-auto-sync-settings.json'), '{"enabled":true}')
  writeFile(path.join(userData, 'ChromeData', 'platform-12', 'Network', 'Cookies'), 'chrome-cookie')
  writeFile(path.join(userData, 'ChromeData', 'platform-12', 'GPUCache', 'data_0'), 'gpu-cache')
  writeFile(path.join(userData, 'CEFData', 'platform-12', 'Network', 'Cookies'), 'cef-cookie')
  writeFile(path.join(localAppData, 'dxe-chrome-profiles', 'purchase-7', 'Network', 'Cookies'), 'purchase-cookie')
  writeFile(path.join(localAppData, 'dxe-chrome-profiles', 'purchase-7', 'Cache', 'data'), 'purchase-cache')
  writeFile(path.join(localAppData, 'dianxiaoer-shop-manager-updater', 'installer.exe'), 'old-installer')
  writeFile(path.join(userData, 'hot-update', 'renderer', 'index.html'), 'old-hot-update')
  return { userData, localAppData }
}

afterEach(() => {
  resetStorageContextForTests()
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('安装盘会话数据迁移', () => {
  it('数据根目录位于安装目录旁边而不是用户 C 盘资料目录', () => {
    const execPath = path.join('F:\\应用', '店小二', 'dianxiaoer.exe')
    expect(resolveInstallDataRoot(execPath)).toBe(path.resolve('F:\\应用', 'dianxiaoer-data'))
  })

  it('先复制并校验登录与业务数据，只提前释放可再生缓存', () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const dataRoot = path.join(root, 'install-parent', 'dianxiaoer-data')
    const app = createFakeApp(userData)

    const context = initializeStorage(app, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true,
      now: 1000
    })

    expect(context.usingManagedStorage).toBe(true)
    expect(context.migrationPending).toBe(true)
    expect(app.paths.sessionData).toBe(context.paths.sessionDataDir)
    expect(fs.readFileSync(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-12', 'Network', 'Cookies'), 'utf8'))
      .toBe('platform-cookie')
    expect(fs.readFileSync(path.join(context.paths.sessionDataDir, 'IndexedDB', 'file__0.indexeddb.leveldb', '000003.log'), 'utf8'))
      .toBe('taobao-same-history')
    expect(fs.readFileSync(path.join(context.paths.sessionDataDir, 'blob_storage', 'indexed-db-blob'), 'utf8'))
      .toBe('business-blob')
    expect(fs.readFileSync(path.join(context.paths.sessionDataDir, 'Local State'), 'utf8')).toContain('encrypted_key')
    expect(fs.readFileSync(path.join(context.paths.chromeDataDir, 'platform-12', 'Network', 'Cookies'), 'utf8'))
      .toBe('chrome-cookie')
    expect(fs.readFileSync(path.join(context.paths.chromePurchaseProfilesDir, 'purchase-7', 'Network', 'Cookies'), 'utf8'))
      .toBe('purchase-cookie')

    expect(fs.existsSync(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-12', 'Cache'))).toBe(false)
    // No legacy-profile entry is removed before Electron confirms that the
    // managed sessionData path is truly active.
    expect(fs.existsSync(path.join(userData, 'Partitions', 'platform-12', 'Cache'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'Partitions', 'platform-12', 'Network', 'Cookies'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'device-id.json'))).toBe(true)
  })

  it('确认 Electron 实际使用新 sessionData 后自动删除旧会话并保留必要配置', async () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const app = createFakeApp(userData)
    const context = initializeStorage(app, {
      isPackaged: true,
      dataRoot: path.join(root, 'install-parent', 'dianxiaoer-data'),
      localAppDataPath: localAppData,
      skipMaintenance: true,
      now: 2000
    })

    const result = await confirmStorageAndCleanup(app, {
      defaultSession: { storagePath: context.paths.sessionDataDir }
    }, { now: 3000 })

    expect(result).toMatchObject({ success: true, status: 'committed' })
    expect(fs.existsSync(path.join(userData, 'Partitions'))).toBe(false)
    expect(fs.existsSync(path.join(userData, 'IndexedDB'))).toBe(false)
    expect(fs.existsSync(path.join(userData, 'ChromeData'))).toBe(false)
    expect(fs.existsSync(path.join(localAppData, 'dxe-chrome-profiles'))).toBe(false)
    expect(fs.existsSync(path.join(localAppData, 'dianxiaoer-shop-manager-updater'))).toBe(false)
    expect(fs.existsSync(path.join(userData, 'hot-update'))).toBe(false)
    expect(fs.readFileSync(path.join(userData, 'device-id.json'), 'utf8')).toContain('keep-on-c')
    expect(fs.readFileSync(path.join(userData, 'aftersale-auto-sync-settings.json'), 'utf8')).toContain('enabled')
    expect(fs.readFileSync(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-12', 'Network', 'Cookies'), 'utf8'))
      .toBe('platform-cookie')
  })

  it('新 Session 路径未生效时绝不删除旧登录数据', async () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const app = createFakeApp(userData)
    initializeStorage(app, {
      isPackaged: true,
      dataRoot: path.join(root, 'install-parent', 'dianxiaoer-data'),
      localAppDataPath: localAppData,
      skipMaintenance: true
    })

    const result = await confirmStorageAndCleanup(app, {
      defaultSession: { storagePath: path.join(root, 'wrong-session') }
    })

    expect(result).toMatchObject({ success: false, reason: 'session_path_mismatch' })
    expect(fs.existsSync(path.join(userData, 'Partitions', 'platform-12', 'Network', 'Cookies'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'device-id.json'))).toBe(true)
  })

  it('目标目录状态不可信时自动回退且不触碰旧数据', () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const dataRoot = path.join(root, 'install-parent', 'dianxiaoer-data')
    writeFile(path.join(dataRoot, 'storage-v1', 'unexpected.bin'), 'unknown-data')
    const app = createFakeApp(userData)

    const context = initializeStorage(app, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })

    expect(context.fallback).toBe(true)
    expect(app.paths.sessionData).toBe(userData)
    expect(fs.existsSync(path.join(userData, 'Partitions', 'platform-12', 'Cache'))).toBe(true)
    expect(fs.existsSync(path.join(userData, 'Partitions', 'platform-12', 'Network', 'Cookies'))).toBe(true)
  })

  it('拒绝把受管存储放进旧 userData 内，避免清理时递归覆盖自身', () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const app = createFakeApp(userData)

    const context = initializeStorage(app, {
      isPackaged: true,
      dataRoot: path.join(userData, 'nested-managed-data'),
      localAppDataPath: localAppData,
      skipMaintenance: true
    })

    expect(context.fallback).toBe(true)
    expect(app.paths.sessionData).toBe(userData)
    expect(fs.existsSync(path.join(userData, 'Partitions', 'platform-12', 'Network', 'Cookies'))).toBe(true)
  })

  it('七天维护只清可再生缓存，不清 IndexedDB、Local Storage 或 Cookie', () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const app = createFakeApp(userData)
    const context = initializeStorage(app, {
      isPackaged: true,
      dataRoot: path.join(root, 'install-parent', 'dianxiaoer-data'),
      localAppDataPath: localAppData,
      skipMaintenance: true,
      now: 1000
    })
    writeFile(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-12', 'Cache', 'large.bin'), 'x'.repeat(200))

    const result = runCacheMaintenanceBeforeReady(context, 1000 + 8 * 24 * 60 * 60 * 1000, {
      intervalMs: 1,
      lowDiskBytes: 0,
      totalLimitBytes: 10000,
      targetBytes: 5000,
      perDirectoryLimitBytes: 100
    })

    expect(result.removedDirectories).toBe(1)
    expect(fs.existsSync(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-12', 'Cache'))).toBe(false)
    expect(fs.readFileSync(path.join(context.paths.sessionDataDir, 'IndexedDB', 'file__0.indexeddb.leveldb', '000003.log'), 'utf8'))
      .toBe('taobao-same-history')
    expect(fs.existsSync(path.join(context.paths.sessionDataDir, 'Local Storage', 'leveldb', '000004.log'))).toBe(true)
    expect(fs.existsSync(path.join(context.paths.sessionDataDir, 'blob_storage', 'indexed-db-blob'))).toBe(true)
    expect(fs.existsSync(path.join(context.paths.sessionDataDir, 'Partitions', 'platform-12', 'Network', 'Cookies'))).toBe(true)
  })

  it('提交后再次启动直接复用安装盘数据，不重复迁移', async () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const dataRoot = path.join(root, 'install-parent', 'dianxiaoer-data')
    const firstApp = createFakeApp(userData)
    const firstContext = initializeStorage(firstApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })
    await confirmStorageAndCleanup(firstApp, {
      defaultSession: { storagePath: firstContext.paths.sessionDataDir }
    })
    resetStorageContextForTests()

    const secondApp = createFakeApp(userData)
    const secondContext = initializeStorage(secondApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })

    expect(secondContext.usingManagedStorage).toBe(true)
    expect(secondContext.reused).toBe(true)
    expect(secondContext.migrationPending).toBe(false)
    expect(secondApp.paths.sessionData).toBe(firstContext.paths.sessionDataDir)
  })

  it('recovers a validated staging profile after an interrupted rename', () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const dataRoot = path.join(root, 'install-parent', 'dianxiaoer-data')
    const firstApp = createFakeApp(userData)
    const firstContext = initializeStorage(firstApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })
    const state = JSON.parse(fs.readFileSync(firstContext.paths.stateFile, 'utf8'))
    fs.renameSync(firstContext.paths.storageRoot, firstContext.paths.stagingRoot)
    fs.writeFileSync(firstContext.paths.stateFile, JSON.stringify({ ...state, status: 'validated' }, null, 2))
    resetStorageContextForTests()

    const secondApp = createFakeApp(userData)
    const secondContext = initializeStorage(secondApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })

    expect(secondContext.usingManagedStorage).toBe(true)
    expect(secondContext.state.status).toBe('prepared')
    expect(fs.existsSync(secondContext.paths.stagingRoot)).toBe(false)
    expect(fs.readFileSync(path.join(secondContext.paths.sessionDataDir, 'IndexedDB', 'file__0.indexeddb.leveldb', '000003.log'), 'utf8'))
      .toBe('taobao-same-history')
  })

  it('keeps a committed profile canonical after Chromium rotates a critical file', async () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const dataRoot = path.join(root, 'install-parent', 'dianxiaoer-data')
    const firstApp = createFakeApp(userData)
    const firstContext = initializeStorage(firstApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })
    await confirmStorageAndCleanup(firstApp, {
      defaultSession: { storagePath: firstContext.paths.sessionDataDir }
    })
    fs.rmSync(path.join(firstContext.paths.sessionDataDir, 'Partitions', 'platform-12', 'Network', 'Cookies'))
    resetStorageContextForTests()

    const secondApp = createFakeApp(userData)
    const secondContext = initializeStorage(secondApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })

    expect(secondContext.usingManagedStorage).toBe(true)
    expect(secondContext.fallback).toBe(false)
    expect(secondContext.migrationPending).toBe(false)
    expect(secondApp.paths.sessionData).toBe(firstContext.paths.sessionDataDir)
  })

  it('retries cleanup_pending without comparing a stale Chromium manifest', async () => {
    const root = makeTemporaryRoot()
    const { userData, localAppData } = seedLegacyData(root)
    const dataRoot = path.join(root, 'install-parent', 'dianxiaoer-data')
    const firstApp = createFakeApp(userData)
    const firstContext = initializeStorage(firstApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })
    const state = JSON.parse(fs.readFileSync(firstContext.paths.stateFile, 'utf8'))
    fs.writeFileSync(firstContext.paths.stateFile, JSON.stringify({ ...state, status: 'cleanup_pending' }, null, 2))
    fs.rmSync(path.join(firstContext.paths.sessionDataDir, 'Partitions', 'platform-12', 'Network', 'Cookies'))
    resetStorageContextForTests()

    const secondApp = createFakeApp(userData)
    const secondContext = initializeStorage(secondApp, {
      isPackaged: true,
      dataRoot,
      localAppDataPath: localAppData,
      skipMaintenance: true
    })
    const result = await confirmStorageAndCleanup(secondApp, {
      defaultSession: { storagePath: secondContext.paths.sessionDataDir }
    })

    expect(result).toMatchObject({ success: true, status: 'committed' })
    expect(fs.existsSync(path.join(userData, 'Partitions'))).toBe(false)
  })
})

describe('缓存规范防回归', () => {
  it('将 electron-updater 安装包缓存基目录切换到受管安装盘目录', () => {
    const root = makeTemporaryRoot()
    const cacheBase = path.join(root, 'install-parent', 'dianxiaoer-data', 'storage-v1', 'update-cache')
    const fakeUpdater = { app: { baseCachePath: path.join(root, 'legacy-local-app-data') } }

    expect(configureUpdaterCacheBase(fakeUpdater, cacheBase)).toBe(true)
    expect(fakeUpdater.app.baseCachePath).toBe(cacheBase)
    expect(fs.existsSync(cacheBase)).toBe(true)
  })

  it('明确保护淘宝同款的 30 天、10000 条 IndexedDB 业务历史', () => {
    const historySource = fs.readFileSync(path.resolve('src/renderer/src/utils/taobaoSameHistory.js'), 'utf8')
    const agentsSource = fs.readFileSync(path.resolve('AGENTS.md'), 'utf8')
    expect(historySource).toContain('TAOBAO_SAME_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000')
    expect(historySource).toContain('TAOBAO_SAME_HISTORY_MAX_ENTRIES = 10000')
    expect(agentsSource).toContain('淘宝同款历史由业务自身按 30 天、最多 10000 条规则管理')
    expect(agentsSource).toContain('Cookie、Local Storage、IndexedDB、WebStorage')
  })
})
