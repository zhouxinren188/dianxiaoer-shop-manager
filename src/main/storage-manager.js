const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const STORAGE_SCHEMA_VERSION = 1
const STORAGE_ROOT_NAME = 'storage-v1'
const STORAGE_STAGING_NAME = 'storage-v1.migrating'
const DATA_ROOT_NAME = 'dianxiaoer-data'
const MIGRATION_STATE_FILE = 'migration-state.json'
const LOCATION_POINTER_FILE = 'storage-location.json'
const MAINTENANCE_STATE_FILE = 'cache-maintenance.json'

const CACHE_DIRECTORY_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'ShaderCache',
  'GrShaderCache',
  'CacheStorage',
  'ScriptCache',
  'Shared Dictionary',
  'Dictionaries'
])

// Only Chromium-owned entries are migrated from userData. Application settings,
// runtime logs, device identity and hot-update metadata intentionally remain in
// the small roaming profile on C:.
const ROOT_SESSION_DIRECTORY_NAMES = new Set([
  'Partitions',
  'Network',
  'Local Storage',
  'IndexedDB',
  'Session Storage',
  'WebStorage',
  'Service Worker',
  'File System',
  'Local Extension Settings',
  'Extension State',
  'Platform Notifications',
  'shared_proto_db',
  'databases',
  'blob_storage'
])

const ROOT_SESSION_FILE_PATTERNS = [
  /^Local State$/i,
  /^Preferences$/i,
  /^Secure Preferences$/i,
  /^DIPS(?:-wal|-shm)?$/i,
  /^SharedStorage(?:-wal|-shm)?$/i,
  /^QuotaManager(?:-journal)?$/i,
  /^Trust Tokens(?:-journal)?$/i,
  /^Network Persistent State$/i,
  /^TransportSecurity$/i,
  /^OriginTrials$/i
]

const CRITICAL_PATH_PARTS = [
  'network/cookies',
  'local storage/',
  'indexeddb/',
  'webstorage/',
  'local extension settings/',
  '/local state',
  '/preferences'
]

const CACHE_MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const CACHE_LOW_DISK_BYTES = 5 * 1024 * 1024 * 1024
const CACHE_TOTAL_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
const CACHE_TARGET_BYTES = 1024 * 1024 * 1024
const CACHE_PER_DIRECTORY_LIMIT_BYTES = 256 * 1024 * 1024
const MIGRATION_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024

let activeContext = null

function normalizeForComparison(value) {
  const resolved = path.resolve(String(value || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isSamePath(left, right) {
  return normalizeForComparison(left) === normalizeForComparison(right)
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertSafeChild(parent, child, label) {
  if (!isPathInside(parent, child)) {
    throw new Error(`${label || 'path'} is outside the managed storage root: ${child}`)
  }
}

function assertNotFilesystemRoot(target, label) {
  const resolved = path.resolve(String(target || ''))
  if (!target || isSamePath(resolved, path.parse(resolved).root)) {
    throw new Error(`${label || 'path'} must not be a filesystem root: ${target}`)
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tempPath, filePath)
}

function appendBootstrapLog(dataRoot, message) {
  try {
    fs.mkdirSync(dataRoot, { recursive: true })
    const logPath = path.join(dataRoot, 'storage-bootstrap.log')
    const line = `[${new Date().toISOString()}] ${message}\n`
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      const previous = fs.readFileSync(logPath, 'utf8')
      fs.writeFileSync(logPath, previous.slice(-512 * 1024), 'utf8')
    }
    fs.appendFileSync(logPath, line, 'utf8')
  } catch {
    // Storage diagnostics must never prevent the application from starting.
  }
}

function ensureWritableDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const probe = path.join(directory, `.write-probe-${process.pid}-${Date.now()}`)
  fs.writeFileSync(probe, 'ok', 'utf8')
  fs.unlinkSync(probe)
}

function resolveInstallDataRoot(execPath) {
  const installDirectory = path.dirname(path.resolve(execPath))
  const parentDirectory = path.dirname(installDirectory)
  return path.join(parentDirectory, DATA_ROOT_NAME)
}

function resolveDataRoot({ userDataPath, execPath, explicitDataRoot, env = process.env }) {
  const explicit = explicitDataRoot || env.DXE_DATA_ROOT
  if (explicit) return path.resolve(explicit)

  const pointer = readJson(path.join(userDataPath, LOCATION_POINTER_FILE))
  if (pointer?.schemaVersion === STORAGE_SCHEMA_VERSION && path.isAbsolute(pointer.dataRoot || '')) {
    const pointedState = readJson(path.join(pointer.dataRoot, MIGRATION_STATE_FILE))
    if (pointedState?.schemaVersion === STORAGE_SCHEMA_VERSION) return path.resolve(pointer.dataRoot)
  }

  return resolveInstallDataRoot(execPath)
}

function buildManagedPaths(dataRoot) {
  const storageRoot = path.join(dataRoot, STORAGE_ROOT_NAME)
  return {
    dataRoot,
    storageRoot,
    stagingRoot: path.join(dataRoot, STORAGE_STAGING_NAME),
    sessionDataDir: path.join(storageRoot, 'session'),
    chromeDataDir: path.join(storageRoot, 'browser', 'chrome-embed'),
    cefDataDir: path.join(storageRoot, 'browser', 'cef-embed'),
    chromePurchaseProfilesDir: path.join(storageRoot, 'browser', 'purchase'),
    hotUpdateDir: path.join(storageRoot, 'hot-update'),
    tempDir: path.join(storageRoot, 'temp'),
    updaterCacheBaseDir: path.join(storageRoot, 'update-cache'),
    stateFile: path.join(dataRoot, MIGRATION_STATE_FILE),
    maintenanceFile: path.join(dataRoot, MAINTENANCE_STATE_FILE)
  }
}

function ensureManagedDirectories(paths) {
  for (const directory of [
    paths.sessionDataDir,
    paths.chromeDataDir,
    paths.cefDataDir,
    paths.chromePurchaseProfilesDir,
    paths.hotUpdateDir,
    paths.tempDir,
    paths.updaterCacheBaseDir
  ]) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function buildLegacyPaths(userDataPath, localAppDataPath) {
  return {
    dataRoot: userDataPath,
    storageRoot: userDataPath,
    stagingRoot: null,
    sessionDataDir: userDataPath,
    chromeDataDir: path.join(userDataPath, 'ChromeData'),
    cefDataDir: path.join(userDataPath, 'CEFData'),
    chromePurchaseProfilesDir: path.join(localAppDataPath, 'dxe-chrome-profiles'),
    hotUpdateDir: path.join(userDataPath, 'hot-update'),
    tempDir: null,
    updaterCacheBaseDir: localAppDataPath,
    stateFile: null,
    maintenanceFile: null
  }
}

function shouldSkipDirectory(name) {
  return CACHE_DIRECTORY_NAMES.has(name) || /^Singleton(?:Lock|Cookie|Socket)$/i.test(name)
}

function shouldIncludeRootSessionFile(name) {
  return ROOT_SESSION_FILE_PATTERNS.some(pattern => pattern.test(name))
}

function collectFiles(sourceRoot, mode) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return []

  const files = []
  const walk = (currentDirectory, relativeDirectory) => {
    let entries
    try {
      entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
    } catch (error) {
      throw new Error(`Unable to read migration source ${currentDirectory}: ${error.message}`)
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      const absolutePath = path.join(currentDirectory, entry.name)

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) continue
        if (mode === 'session-root' && !relativeDirectory && !ROOT_SESSION_DIRECTORY_NAMES.has(entry.name)) continue
        walk(absolutePath, relativePath)
        continue
      }

      if (!entry.isFile()) continue
      if (mode === 'session-root' && !relativeDirectory && !shouldIncludeRootSessionFile(entry.name)) continue
      const stat = fs.statSync(absolutePath)
      files.push({ absolutePath, relativePath, size: stat.size })
    }
  }

  walk(sourceRoot, '')
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function isCriticalRelativePath(relativePath) {
  const normalized = `/${String(relativePath).replace(/\\/g, '/').toLowerCase()}`
  return CRITICAL_PATH_PARTS.some(part => normalized.includes(part))
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function buildManifest(sourceRoot, mode) {
  const files = collectFiles(sourceRoot, mode)
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.map(file => ({
      path: file.relativePath,
      size: file.size,
      ...(isCriticalRelativePath(file.relativePath) ? { sha256: hashFile(file.absolutePath) } : {})
    }))
  }
}

function copyWithRetry(source, destination) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(source, destination)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function copyManifestFiles(sourceRoot, destinationRoot, manifest) {
  fs.mkdirSync(destinationRoot, { recursive: true })
  for (const file of manifest.files) {
    copyWithRetry(path.join(sourceRoot, file.path), path.join(destinationRoot, file.path))
  }
}

function validateManifest(destinationRoot, manifest, { verifyHashes = true } = {}) {
  if (!fs.existsSync(destinationRoot)) return { valid: false, reason: 'destination_missing' }
  for (const expected of manifest.files || []) {
    const destination = path.join(destinationRoot, expected.path)
    if (!fs.existsSync(destination)) return { valid: false, reason: `missing:${expected.path}` }
    const actualSize = fs.statSync(destination).size
    if (actualSize !== expected.size) return { valid: false, reason: `size:${expected.path}` }
    if (verifyHashes && expected.sha256 && hashFile(destination) !== expected.sha256) {
      return { valid: false, reason: `hash:${expected.path}` }
    }
  }
  return { valid: true }
}

function validateRequiredFiles(destinationRoot, manifest) {
  if (!fs.existsSync(destinationRoot)) return { valid: false, reason: 'destination_missing' }
  for (const expected of (manifest.files || []).filter(file => file.sha256)) {
    if (!fs.existsSync(path.join(destinationRoot, expected.path))) {
      return { valid: false, reason: `critical_missing:${expected.path}` }
    }
  }
  return { valid: true }
}

function getFreeBytes(directory) {
  try {
    const stat = fs.statfsSync(directory)
    return Number(stat.bavail) * Number(stat.bsize)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function removeManagedDirectory(parent, target) {
  if (!target || !fs.existsSync(target)) return
  assertSafeChild(parent, target, 'delete target')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
}

function componentDefinitions({ oldSessionDataPath, userDataPath, localAppDataPath, root }) {
  return [
    {
      name: 'electron-session',
      mode: 'session-root',
      source: oldSessionDataPath,
      relativeTarget: 'session'
    },
    {
      name: 'chrome-embed',
      mode: 'profile-root',
      source: path.join(userDataPath, 'ChromeData'),
      relativeTarget: path.join('browser', 'chrome-embed')
    },
    {
      name: 'cef-embed',
      mode: 'profile-root',
      source: path.join(userDataPath, 'CEFData'),
      relativeTarget: path.join('browser', 'cef-embed')
    },
    {
      name: 'chrome-purchase',
      mode: 'profile-root',
      source: path.join(localAppDataPath, 'dxe-chrome-profiles'),
      relativeTarget: path.join('browser', 'purchase')
    }
  ].map(component => ({
    ...component,
    target: path.join(root, component.relativeTarget)
  }))
}

function stateCanUseTarget(state, paths) {
  if (!state || state.schemaVersion !== STORAGE_SCHEMA_VERSION) return false
  if (!isSamePath(state.storageRoot, paths.storageRoot)) return false
  if (!['validated', 'prepared', 'activated', 'cleanup_pending', 'committed'].includes(state.status)) return false
  if (!fs.existsSync(paths.storageRoot)) return false

  // Once the managed profile has been selected, Chromium is allowed to mutate
  // or legitimately remove Cookie/LevelDB files. A committed target is the only
  // canonical copy, so it must never fall back to the already-cleaned C profile.
  if (state.status !== 'validated') {
    return fs.existsSync(paths.sessionDataDir)
  }

  return (state.components || []).every(component => {
    const target = path.join(paths.storageRoot, component.relativeTarget)
    return validateRequiredFiles(target, component.manifest || { files: [] }).valid
  })
}

function recoverValidatedStaging(state, paths) {
  if (state?.status !== 'validated' || !fs.existsSync(paths.stagingRoot) || fs.existsSync(paths.storageRoot)) return false
  const stagingValid = (state.components || []).every(component => {
    const target = path.join(paths.stagingRoot, component.relativeTarget)
    return validateManifest(target, component.manifest || { files: [] }).valid
  })
  if (!stagingValid) return false
  fs.renameSync(paths.stagingRoot, paths.storageRoot)
  return true
}

function writeLocationPointer(userDataPath, dataRoot) {
  try {
    writeJsonAtomic(path.join(userDataPath, LOCATION_POINTER_FILE), {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      dataRoot,
      updatedAt: new Date().toISOString()
    })
  } catch {
    // The pointer is only a convenience. The install-relative path is deterministic.
  }
}

function prepareMigration({ paths, oldSessionDataPath, userDataPath, localAppDataPath, now = Date.now() }) {
  let state = readJson(paths.stateFile)

  if (state?.status === 'validated' && recoverValidatedStaging(state, paths)) {
    state = { ...state, status: 'prepared', preparedAt: new Date(now).toISOString() }
    writeJsonAtomic(paths.stateFile, state)
  }

  if (stateCanUseTarget(state, paths)) {
    writeLocationPointer(userDataPath, paths.dataRoot)
    return { state, reused: true }
  }

  if (fs.existsSync(paths.storageRoot)) {
    throw new Error('Managed storage exists without a valid migration state; preserving legacy storage')
  }

  removeManagedDirectory(paths.dataRoot, paths.stagingRoot)
  fs.mkdirSync(paths.stagingRoot, { recursive: true })

  const definitions = componentDefinitions({
    oldSessionDataPath,
    userDataPath,
    localAppDataPath,
    root: paths.stagingRoot
  })
  const components = definitions.map(component => ({
    name: component.name,
    mode: component.mode,
    source: component.source,
    relativeTarget: component.relativeTarget,
    manifest: buildManifest(component.source, component.mode)
  }))
  const requiredBytes = components.reduce((sum, component) => sum + component.manifest.totalBytes, 0)
  const freeBytes = getFreeBytes(paths.dataRoot)
  if (freeBytes < requiredBytes + MIGRATION_FREE_SPACE_RESERVE_BYTES) {
    removeManagedDirectory(paths.dataRoot, paths.stagingRoot)
    throw new Error(`Insufficient target disk space: required=${requiredBytes}, free=${freeBytes}`)
  }

  state = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    status: 'copying',
    dataRoot: paths.dataRoot,
    storageRoot: paths.storageRoot,
    legacySessionData: oldSessionDataPath,
    createdAt: new Date(now).toISOString(),
    components
  }
  writeJsonAtomic(paths.stateFile, state)

  for (const component of components) {
    const destination = path.join(paths.stagingRoot, component.relativeTarget)
    copyManifestFiles(component.source, destination, component.manifest)
    const validation = validateManifest(destination, component.manifest)
    if (!validation.valid) throw new Error(`Migration validation failed for ${component.name}: ${validation.reason}`)
  }

  state = { ...state, status: 'validated', validatedAt: new Date(now).toISOString() }
  writeJsonAtomic(paths.stateFile, state)
  fs.renameSync(paths.stagingRoot, paths.storageRoot)
    state = { ...state, status: 'prepared', preparedAt: new Date(now).toISOString() }
  writeJsonAtomic(paths.stateFile, state)
  writeLocationPointer(userDataPath, paths.dataRoot)
  return { state, reused: false }
}

function discoverCacheDirectories(sourceRoot, mode) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return []
  const found = []
  const walk = (current, relativeDirectory) => {
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const absolute = path.join(current, entry.name)
      if (CACHE_DIRECTORY_NAMES.has(entry.name)) {
        found.push(absolute)
        continue
      }
      if (mode === 'session-root' && !relativeDirectory && !ROOT_SESSION_DIRECTORY_NAMES.has(entry.name)) continue
      walk(absolute, relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name)
    }
  }
  walk(sourceRoot, '')
  return found
}

function directoryStats(directory) {
  let size = 0
  let latestMtimeMs = 0
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      try {
        const stat = fs.statSync(absolute)
        latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs || 0)
        if (entry.isDirectory()) stack.push(absolute)
        else if (entry.isFile()) size += stat.size
      } catch {
        // Ignore entries that disappear while calculating cache usage.
      }
    }
  }
  return { size, latestMtimeMs }
}

function runCacheMaintenanceBeforeReady(context, now = Date.now(), limits = {}) {
  if (!context?.usingManagedStorage || !context.paths?.maintenanceFile) return { skipped: true, reason: 'legacy_storage' }
  const intervalMs = limits.intervalMs ?? CACHE_MAINTENANCE_INTERVAL_MS
  const lowDiskBytes = limits.lowDiskBytes ?? CACHE_LOW_DISK_BYTES
  const totalLimitBytes = limits.totalLimitBytes ?? CACHE_TOTAL_LIMIT_BYTES
  const targetBytes = limits.targetBytes ?? CACHE_TARGET_BYTES
  const perDirectoryLimitBytes = limits.perDirectoryLimitBytes ?? CACHE_PER_DIRECTORY_LIMIT_BYTES
  const previous = readJson(context.paths.maintenanceFile)
  const freeBytes = getFreeBytes(context.paths.dataRoot)
  if (
    previous?.lastRunAt &&
    now - Number(previous.lastRunAt) < intervalMs &&
    freeBytes >= lowDiskBytes
  ) {
    return { skipped: true, reason: 'interval' }
  }

  const cacheDirectories = discoverCacheDirectories(context.paths.storageRoot, 'profile-root')
  const candidates = cacheDirectories.map(directory => ({ directory, ...directoryStats(directory) }))
  let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.size, 0)
  const lowDisk = freeBytes < lowDiskBytes
  const selected = new Set(
    candidates
      .filter(candidate => lowDisk || candidate.size > perDirectoryLimitBytes)
      .map(candidate => candidate.directory)
  )

  if (totalBytes > totalLimitBytes) {
    for (const candidate of [...candidates].sort((left, right) => left.latestMtimeMs - right.latestMtimeMs)) {
      if (totalBytes <= targetBytes) break
      selected.add(candidate.directory)
      totalBytes -= candidate.size
    }
  }

  let freedBytes = 0
  let removedDirectories = 0
  for (const candidate of candidates) {
    if (!selected.has(candidate.directory)) continue
    assertSafeChild(context.paths.storageRoot, candidate.directory, 'cache directory')
    fs.rmSync(candidate.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    freedBytes += candidate.size
    removedDirectories += 1
  }

  writeJsonAtomic(context.paths.maintenanceFile, {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    lastRunAt: now,
    lowDisk,
    scannedBytes: candidates.reduce((sum, candidate) => sum + candidate.size, 0),
    freedBytes,
    removedDirectories
  })
  return { skipped: false, lowDisk, freedBytes, removedDirectories }
}

function initializeStorage(app, options = {}) {
  const userDataPath = app.getPath('userData')
  const oldSessionDataPath = app.getPath('sessionData')
  const localAppDataPath = options.localAppDataPath || process.env.LOCALAPPDATA || path.join(path.dirname(userDataPath), '..', 'Local')
  const packaged = options.isPackaged ?? app.isPackaged

  if (!packaged) {
    const paths = buildLegacyPaths(userDataPath, localAppDataPath)
    activeContext = {
      usingManagedStorage: false,
      migrationPending: false,
      fallback: false,
      paths,
      legacySessionData: oldSessionDataPath
    }
    return activeContext
  }

  let paths = null
  try {
    const dataRoot = resolveDataRoot({
      userDataPath,
      execPath: options.execPath || process.execPath,
      explicitDataRoot: options.dataRoot,
      env: options.env || process.env
    })
    paths = buildManagedPaths(dataRoot)
    if (
      isSamePath(userDataPath, paths.storageRoot) ||
      isPathInside(userDataPath, paths.storageRoot) ||
      isPathInside(paths.storageRoot, userDataPath)
    ) {
      throw new Error('Managed storage must be outside the legacy userData directory')
    }
    ensureWritableDirectory(paths.dataRoot)
    appendBootstrapLog(paths.dataRoot, `prepare source=${oldSessionDataPath} target=${paths.sessionDataDir}`)
    const prepared = prepareMigration({
      paths,
      oldSessionDataPath,
      userDataPath,
      localAppDataPath,
      now: options.now || Date.now()
    })
    ensureManagedDirectories(paths)
    app.setPath('sessionData', paths.sessionDataDir)

    activeContext = {
      usingManagedStorage: true,
      migrationPending: prepared.state.status !== 'committed',
      fallback: false,
      reused: prepared.reused,
      state: prepared.state,
      paths,
      legacySessionData: oldSessionDataPath,
      userDataPath,
      localAppDataPath
    }

    const maintenanceResult = options.skipMaintenance
      ? { skipped: true, reason: 'disabled' }
      : runCacheMaintenanceBeforeReady(activeContext, options.now || Date.now())
    appendBootstrapLog(
      paths.dataRoot,
      `selected status=${prepared.state.status} reused=${prepared.reused} maintenanceFreed=${maintenanceResult.freedBytes || 0}`
    )
    return activeContext
  } catch (error) {
    if (paths?.dataRoot) appendBootstrapLog(paths.dataRoot, `fallback error=${error.message}`)
    const legacyPaths = buildLegacyPaths(userDataPath, localAppDataPath)
    activeContext = {
      usingManagedStorage: false,
      migrationPending: false,
      fallback: true,
      error: error.message,
      paths: legacyPaths,
      legacySessionData: oldSessionDataPath,
      userDataPath,
      localAppDataPath
    }
    return activeContext
  }
}

function deleteLegacySessionEntries(sourceRoot) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return
  assertNotFilesystemRoot(sourceRoot, 'legacy sessionData')
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const absolute = path.join(sourceRoot, entry.name)
    if (entry.isDirectory() && (ROOT_SESSION_DIRECTORY_NAMES.has(entry.name) || CACHE_DIRECTORY_NAMES.has(entry.name))) {
      fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    } else if (entry.isFile() && shouldIncludeRootSessionFile(entry.name)) {
      fs.rmSync(absolute, { force: true })
    }
  }
}

function cleanupLegacyComponents(context) {
  if (
    isSamePath(context.legacySessionData, context.paths.sessionDataDir) ||
    isPathInside(context.legacySessionData, context.paths.sessionDataDir) ||
    isPathInside(context.paths.sessionDataDir, context.legacySessionData)
  ) {
    throw new Error(`Refusing to delete active sessionData: ${context.legacySessionData}`)
  }

  deleteLegacySessionEntries(context.legacySessionData)

  const legacyProfileRoots = [
    { parent: context.userDataPath, target: path.join(context.userDataPath, 'ChromeData'), label: 'legacy Chrome profile' },
    { parent: context.userDataPath, target: path.join(context.userDataPath, 'CEFData'), label: 'legacy CEF profile' },
    { parent: context.localAppDataPath, target: path.join(context.localAppDataPath, 'dxe-chrome-profiles'), label: 'legacy purchase profile' }
  ]
  for (const profile of legacyProfileRoots) {
    if (!fs.existsSync(profile.target)) continue
    assertSafeChild(profile.parent, profile.target, profile.label)
    if (
      isSamePath(profile.target, context.paths.storageRoot) ||
      isPathInside(profile.target, context.paths.storageRoot) ||
      isPathInside(context.paths.storageRoot, profile.target)
    ) {
      throw new Error(`Refusing to delete active storage source: ${profile.target}`)
    }
    fs.rmSync(profile.target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }

  const legacyHotUpdate = path.join(context.userDataPath, 'hot-update')
  if (
    fs.existsSync(legacyHotUpdate) &&
    !isSamePath(legacyHotUpdate, context.paths.hotUpdateDir) &&
    !isPathInside(legacyHotUpdate, context.paths.hotUpdateDir) &&
    !isPathInside(context.paths.hotUpdateDir, legacyHotUpdate)
  ) {
    assertSafeChild(context.userDataPath, legacyHotUpdate, 'legacy hot-update')
    fs.rmSync(legacyHotUpdate, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }

  // electron-updater historically stores installers under LOCALAPPDATA. The
  // managed updater now uses the install drive, so the old cache is disposable.
  const legacyUpdaterCache = path.join(context.localAppDataPath, 'dianxiaoer-shop-manager-updater')
  if (
    fs.existsSync(legacyUpdaterCache) &&
    !isSamePath(legacyUpdaterCache, context.paths.updaterCacheBaseDir) &&
    !isPathInside(legacyUpdaterCache, context.paths.storageRoot) &&
    !isPathInside(context.paths.storageRoot, legacyUpdaterCache)
  ) {
    assertSafeChild(context.localAppDataPath, legacyUpdaterCache, 'legacy updater cache')
    fs.rmSync(legacyUpdaterCache, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
}

async function confirmStorageAndCleanup(app, electronSession, options = {}) {
  const context = activeContext
  if (!context?.usingManagedStorage) return { success: false, skipped: true, reason: 'legacy_storage' }
  if (!context.migrationPending) return { success: true, skipped: true, reason: 'already_committed' }

  const storagePath = electronSession?.defaultSession?.storagePath
  if (!storagePath || !isSamePath(storagePath, context.paths.sessionDataDir)) {
    appendBootstrapLog(context.paths.dataRoot, `activation rejected storagePath=${storagePath || 'missing'}`)
    return { success: false, skipped: true, reason: 'session_path_mismatch' }
  }

  // Snapshot validation is meaningful only before the first activation. Once
  // Chromium has used the new profile it may legitimately rotate LevelDB and
  // Cookie files. cleanup_pending/activated states must therefore retry only
  // the idempotent legacy cleanup instead of comparing with a stale manifest.
  if (['validated', 'prepared'].includes(context.state.status)) {
    for (const component of context.state.components || []) {
      const target = path.join(context.paths.storageRoot, component.relativeTarget)
      const validation = validateRequiredFiles(target, component.manifest || { files: [] })
      if (!validation.valid) {
        appendBootstrapLog(context.paths.dataRoot, `activation rejected component=${component.name} reason=${validation.reason}`)
        return { success: false, skipped: true, reason: validation.reason }
      }
    }
  }

  let state = {
    ...context.state,
    status: 'activated',
    activatedAt: new Date(options.now || Date.now()).toISOString(),
    activeSessionPath: storagePath
  }
  writeJsonAtomic(context.paths.stateFile, state)

  try {
    cleanupLegacyComponents({ ...context, state })
    state = {
      ...state,
      status: 'committed',
      committedAt: new Date(options.now || Date.now()).toISOString()
    }
    writeJsonAtomic(context.paths.stateFile, state)
    writeLocationPointer(context.userDataPath, context.paths.dataRoot)
    context.state = state
    context.migrationPending = false
    appendBootstrapLog(context.paths.dataRoot, 'migration committed and legacy session data removed')
    return { success: true, skipped: false, status: state.status }
  } catch (error) {
    state = {
      ...state,
      status: 'cleanup_pending',
      cleanupError: error.message,
      cleanupAttemptAt: new Date(options.now || Date.now()).toISOString()
    }
    writeJsonAtomic(context.paths.stateFile, state)
    context.state = state
    appendBootstrapLog(context.paths.dataRoot, `cleanup pending error=${error.message}`)
    return { success: false, skipped: false, reason: 'cleanup_pending', error: error.message }
  }
}

function getStoragePaths() {
  if (activeContext?.paths) return activeContext.paths
  try {
    const { app } = require('electron')
    const userDataPath = app.getPath('userData')
    const localAppDataPath = process.env.LOCALAPPDATA || path.join(path.dirname(userDataPath), '..', 'Local')
    return buildLegacyPaths(userDataPath, localAppDataPath)
  } catch {
    const fallback = path.resolve(process.cwd(), '.dianxiaoer-data')
    return buildLegacyPaths(fallback, fallback)
  }
}

function getStorageContext() {
  return activeContext
}

function resetStorageContextForTests() {
  activeContext = null
}

module.exports = {
  CACHE_DIRECTORY_NAMES,
  CACHE_MAINTENANCE_INTERVAL_MS,
  STORAGE_SCHEMA_VERSION,
  buildLegacyPaths,
  buildManagedPaths,
  buildManifest,
  collectFiles,
  confirmStorageAndCleanup,
  discoverCacheDirectories,
  getStorageContext,
  getStoragePaths,
  initializeStorage,
  isPathInside,
  resolveDataRoot,
  resolveInstallDataRoot,
  runCacheMaintenanceBeforeReady,
  validateManifest,
  validateRequiredFiles,
  resetStorageContextForTests
}
