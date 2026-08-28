import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

const dbSource = fs.readFileSync('server/db.js', 'utf8')
const businessSource = fs.readFileSync('server/index.js', 'utf8')
const authSource = fs.readFileSync('server-api/index.js', 'utf8')

function routeBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('桌面端与微信小程序多端登录', () => {
  it('为每个用户的客户端类型建立唯一会话槽位并兼容旧 token', () => {
    expect(dbSource).toContain('token VARCHAR(512) NOT NULL UNIQUE')
    expect(dbSource).toContain('MODIFY COLUMN token VARCHAR(512) NOT NULL')
    expect(dbSource).toContain("device VARCHAR(32) NOT NULL DEFAULT 'desktop'")
    expect(dbSource).toContain('UNIQUE KEY uk_user_device (user_id, device)')
    expect(dbSource).toContain("decoded.iss === 'dianxiaoer-server' ? 'miniprogram' : 'desktop'")
    expect(dbSource).toContain('newer.device = older.device')
    expect(authSource).toContain("ALTER TABLE user_tokens ADD COLUMN device VARCHAR(32) NOT NULL DEFAULT 'desktop'")
    expect(authSource).toContain('ALTER TABLE user_tokens ADD UNIQUE KEY uk_user_device (user_id, device)')
  })

  it('桌面登录只替换 desktop token，不再删除该用户全部 token', () => {
    const loginRoute = routeBlock(authSource, "app.post('/api/login'", "app.post('/api/logout'")
    expect(loginRoute).toContain("const device = 'desktop'")
    expect(loginRoute).toContain('INSERT INTO user_tokens (user_id, token, device)')
    expect(loginRoute).toContain('ON DUPLICATE KEY UPDATE token = VALUES(token)')
    expect(loginRoute).not.toContain('DELETE FROM user_tokens WHERE user_id = ?')
  })

  it('微信小程序登录只替换 miniprogram token', () => {
    const loginRoute = routeBlock(businessSource, "app.post('/api/auth/login'", "app.post('/api/auth/logout'")
    expect(loginRoute).toContain("const device = 'miniprogram'")
    expect(loginRoute).toContain('INSERT INTO user_tokens (user_id, token, device)')
    expect(loginRoute).toContain('ON DUPLICATE KEY UPDATE token = VALUES(token)')
    expect(loginRoute).not.toContain('DELETE FROM user_tokens WHERE user_id = ?')
  })

  it('鉴权要求 token 仍在会话表中，刷新时只轮换当前端 token', () => {
    const middleware = routeBlock(authSource, 'async function authMiddleware', '// ========== API 路由')
    const refreshRoute = routeBlock(authSource, "app.post('/api/refresh'", "app.get('/api/me'")
    expect(middleware).toContain('SELECT device FROM user_tokens WHERE token = ? LIMIT 1')
    expect(refreshRoute).toContain('WHERE token = ? AND user_id = ? AND device = ?')
    expect(refreshRoute).toContain('device: req.authDevice')
    expect(refreshRoute).not.toContain('DELETE FROM user_tokens WHERE user_id = ?')
  })

  it('禁用或删除账号仍保留全端强制下线能力', () => {
    expect(businessSource).toContain("await pool.execute('DELETE FROM user_tokens WHERE user_id = ?', [req.params.id])")
    expect(authSource).toContain("await dbPool.execute('DELETE FROM user_tokens WHERE user_id = ?', [userId])")
  })
})
