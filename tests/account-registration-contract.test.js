import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('账号注册归属契约', () => {
  const authSource = fs.readFileSync('server-api/index.js', 'utf8')
  const businessSource = fs.readFileSync('server/index.js', 'utf8')
  const databaseSource = fs.readFileSync('server/db.js', 'utf8')
  const loginSource = fs.readFileSync('src/renderer/src/views/login/LoginPage.vue', 'utf8')
  const userDialogSource = fs.readFileSync('src/renderer/src/views/user/components/UserEditDialog.vue', 'utf8')

  it('登录页公开注册创建独立主账号并建立自己的试用订阅', () => {
    expect(authSource).toContain("VALUES (?, ?, ?, 'master', 'admin', NULL, 'enabled', ?)")
    expect(authSource).toContain('INSERT INTO subscriptions')
    expect(authSource).toContain('[result.insertId, username]')
    expect(authSource).toContain('userType: user.user_type')
    expect(loginSource).toContain('创建一个独立主账号')
  })

  it('用户管理只能创建当前主账号名下的子账号', () => {
    expect(businessSource).toContain("const userType = 'sub'")
    expect(businessSource).toContain('const parentId = req.user.id')
    expect(businessSource).toContain('账号类型不能在编辑用户时变更')
    expect(userDialogSource).not.toContain('<el-radio label="master">主账号</el-radio>')
    expect(userDialogSource).toContain('主账号请在登录页独立注册')
    expect(databaseSource).not.toContain("UPDATE users SET parent_id = 1 WHERE user_type = 'sub' AND parent_id IS NULL")
  })

  it('历史授权关联必须再次按当前主账号归属过滤', () => {
    expect(businessSource).toContain('WHERE us.user_id = ? AND s.owner_id = ?')
    expect(businessSource).toContain('WHERE uw.user_id = ? AND w.owner_id = ?')
    expect(businessSource).toContain('WHERE upa.user_id = ? AND pa.owner_id = ?')
  })
})
