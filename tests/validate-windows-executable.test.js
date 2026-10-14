import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import executableValidator from '../scripts/validate-windows-executable.js'

const { inspectWindowsExecutable, assertWindowsExecutable } = executableValidator
const temporaryRoots = []

function createExecutable({ size = 1024, machine = 0x8664, optionalMagic = 0x020b } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-pe-test-'))
  temporaryRoots.push(root)
  const filePath = path.join(root, 'app.exe')
  const content = Buffer.alloc(size)
  content.write('MZ', 0, 'ascii')
  content.writeUInt32LE(0x80, 0x3c)
  content.write('PE\0\0', 0x80, 'binary')
  content.writeUInt16LE(machine, 0x84)
  content.writeUInt16LE(optionalMagic, 0x98)
  fs.writeFileSync(filePath, content)
  return filePath
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows executable release validation', () => {
  it('accepts a structurally valid 64-bit PE executable', () => {
    const filePath = createExecutable()
    expect(inspectWindowsExecutable(filePath)).toMatchObject({
      size: 1024,
      machine: 0x8664,
      optionalHeaderMagic: 0x020b
    })
  })

  it('rejects a truncated executable even when its PE header remains intact', () => {
    const filePath = createExecutable({ size: 512 })
    expect(() => assertWindowsExecutable(filePath, { minimumSize: 900 }))
      .toThrow(/unexpectedly small/)
  })

  it('rejects files without a PE signature', () => {
    const filePath = createExecutable()
    const content = fs.readFileSync(filePath)
    content.fill(0, 0x80, 0x84)
    fs.writeFileSync(filePath, content)
    expect(() => inspectWindowsExecutable(filePath)).toThrow(/PE signature/)
  })
})
