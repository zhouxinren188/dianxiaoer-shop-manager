import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverSource = fs.readFileSync(path.join(projectRoot, 'server-api', 'index.js'), 'utf8')
const adminHtml = fs.readFileSync(path.join(projectRoot, 'server-api', 'public', 'admin', 'index.html'), 'utf8')

describe('管理后台安全契约', () => {
  it('浏览器不再持久化或随请求发送原始管理密码', () => {
    expect(adminHtml).not.toContain("localStorage.setItem('admin_pw'")
    expect(adminHtml).not.toContain("'x-admin-password': adminPassword.value")
    expect(adminHtml).toContain("localStorage.removeItem('admin_pw')")
    expect(adminHtml).toContain("credentials: 'same-origin'")
  })

  it('使用短期 HttpOnly 会话并支持退出和修改密码', () => {
    expect(serverSource).toContain("app.post('/api/admin/session/login', adminLoginLimiter")
    expect(serverSource).toContain("app.post('/api/admin/session/logout', adminAuth")
    expect(serverSource).toContain("app.put('/api/admin/session/password', adminAuth")
    expect(serverSource).toContain('HttpOnly; SameSite=Strict')
    expect(adminHtml).toContain('修改管理员密码')
    expect(adminHtml).toContain('退出登录')
  })

  it('管理登录和接口均有限流并记录操作审计', () => {
    expect(serverSource).toContain('const adminLoginLimiter = rateLimit')
    expect(serverSource).toContain('const adminApiLimiter = rateLimit')
    expect(serverSource).toContain('CREATE TABLE IF NOT EXISTS admin_audit_logs')
    expect(serverSource).toContain("app.get('/api/admin/audit-logs', adminAuth")
    expect(adminHtml).toContain('安全日志')
  })

  it('停用主账号会同步停用子账号、店铺并删除令牌', () => {
    expect(serverSource).toContain("'UPDATE users SET status = ? WHERE id = ? OR parent_id = ?'")
    expect(serverSource).toContain("'UPDATE stores SET status = ? WHERE owner_id = ?'")
    expect(serverSource).toContain('DELETE FROM user_tokens WHERE user_id IN')
    expect(serverSource).toContain("await logAdminAudit(req, 'user.status.changed'")
  })

  it('管理页面内联脚本语法有效', () => {
    const match = adminHtml.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)
    expect(match).not.toBeNull()
    expect(() => new Function(match[1])).not.toThrow()
  })
})
