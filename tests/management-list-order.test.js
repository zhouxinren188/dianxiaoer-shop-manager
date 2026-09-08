import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const server = fs.readFileSync(path.join(process.cwd(), 'server/index.js'), 'utf8')

describe('管理列表默认排序', () => {
  it('用户列表在分页前将启用用户排在停用用户前面', () => {
    expect(server).toContain("ORDER BY (status = 'enabled') DESC, id DESC LIMIT")
  })

  it('店铺列表在分页前将启用店铺排在停用店铺前面', () => {
    expect(server).toContain("ORDER BY (status = 'enabled') DESC, id ASC LIMIT")
  })
})
