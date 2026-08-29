import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import runtimeLogPath from '../src/main/runtime-log-path.js'

const { selectRuntimeLogPath } = runtimeLogPath
const temporaryRoots = []

function makeTemporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-runtime-log-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('运行日志路径', () => {
  it('优先使用安装目录并复制旧日志历史', () => {
    const root = makeTemporaryRoot()
    const legacyPath = path.join(root, 'appdata', '店小二运行日志.txt')
    const installPath = path.join(root, 'install', '店小二运行日志.txt')
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, '旧日志内容\n', 'utf8')

    expect(selectRuntimeLogPath([installPath, legacyPath], legacyPath)).toBe(installPath)
    expect(fs.readFileSync(installPath, 'utf8')).toBe('旧日志内容\n')
  })

  it('安装目录不可写时回退到受管数据目录', () => {
    const root = makeTemporaryRoot()
    const blockedParent = path.join(root, 'blocked')
    const managedPath = path.join(root, 'dianxiaoer-data', '店小二运行日志.txt')
    fs.writeFileSync(blockedParent, 'not-a-directory', 'utf8')

    expect(selectRuntimeLogPath([
      path.join(blockedParent, '店小二运行日志.txt'),
      managedPath
    ], null)).toBe(managedPath)
    expect(fs.existsSync(managedPath)).toBe(true)
  })
})
