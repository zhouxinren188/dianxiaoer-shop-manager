const fs = require('fs')
const path = require('path')

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter(filePath => {
    if (!filePath) return false
    const normalized = path.resolve(filePath).toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function selectRuntimeLogPath(candidates, legacyPath, fsModule = fs) {
  let lastError = null
  for (const candidate of uniquePaths(candidates)) {
    try {
      fsModule.mkdirSync(path.dirname(candidate), { recursive: true })
      const existed = fsModule.existsSync(candidate)
      const descriptor = fsModule.openSync(candidate, 'a')
      fsModule.closeSync(descriptor)

      if (!existed && legacyPath && path.resolve(candidate) !== path.resolve(legacyPath) && fsModule.existsSync(legacyPath)) {
        fsModule.copyFileSync(legacyPath, candidate)
      }
      return candidate
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('没有可写的运行日志目录')
}

module.exports = {
  selectRuntimeLogPath,
  uniquePaths
}
