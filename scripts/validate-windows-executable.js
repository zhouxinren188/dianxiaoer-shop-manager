const fs = require('fs')
const path = require('path')

const WINDOWS_PE_MACHINES = new Set([0x014c, 0x8664, 0xaa64])
const WINDOWS_OPTIONAL_HEADER_MAGICS = new Set([0x010b, 0x020b])

function inspectWindowsExecutable(filePath) {
  const resolvedPath = path.resolve(filePath)
  const stat = fs.statSync(resolvedPath)
  const descriptor = fs.openSync(resolvedPath, 'r')
  try {
    const dosHeader = Buffer.alloc(64)
    if (fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error('DOS header is incomplete')
    }
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('DOS MZ signature is missing')
    }

    const peOffset = dosHeader.readUInt32LE(0x3c)
    const peHeader = Buffer.alloc(26)
    if (fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error('PE header is incomplete')
    }
    if (!peHeader.subarray(0, 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) {
      throw new Error('PE signature is invalid')
    }

    const machine = peHeader.readUInt16LE(4)
    const optionalHeaderMagic = peHeader.readUInt16LE(24)
    if (!WINDOWS_PE_MACHINES.has(machine)) {
      throw new Error(`unsupported PE machine 0x${machine.toString(16)}`)
    }
    if (!WINDOWS_OPTIONAL_HEADER_MAGICS.has(optionalHeaderMagic)) {
      throw new Error(`invalid optional header magic 0x${optionalHeaderMagic.toString(16)}`)
    }

    return {
      filePath: resolvedPath,
      size: stat.size,
      peOffset,
      machine,
      optionalHeaderMagic
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function assertWindowsExecutable(filePath, options = {}) {
  const inspected = inspectWindowsExecutable(filePath)
  const minimumSize = Math.max(1, Number(options.minimumSize || 1))
  if (inspected.size < minimumSize) {
    throw new Error(
      `executable is unexpectedly small: ${inspected.size} bytes, expected at least ${minimumSize} bytes`
    )
  }
  return inspected
}

function minimumPackagedExecutableSize(referenceFilePath, ratio = 0.9) {
  const referenceSize = fs.statSync(referenceFilePath).size
  return Math.floor(referenceSize * ratio)
}

function validatePackagedExecutable(packagedFilePath, referenceFilePath) {
  const minimumSize = minimumPackagedExecutableSize(referenceFilePath)
  return assertWindowsExecutable(packagedFilePath, { minimumSize })
}

if (require.main === module) {
  const [packagedFilePath, referenceFilePath] = process.argv.slice(2)
  if (!packagedFilePath || !referenceFilePath) {
    console.error('Usage: node scripts/validate-windows-executable.js <packaged-exe> <reference-electron-exe>')
    process.exit(2)
  }
  try {
    const result = validatePackagedExecutable(packagedFilePath, referenceFilePath)
    console.log(
      `[exe-validate] OK path=${result.filePath} size=${result.size} machine=0x${result.machine.toString(16)}`
    )
  } catch (error) {
    console.error(`[exe-validate] FAILED: ${error.message}`)
    process.exit(1)
  }
}

module.exports = {
  inspectWindowsExecutable,
  assertWindowsExecutable,
  minimumPackagedExecutableSize,
  validatePackagedExecutable
}
