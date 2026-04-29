const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')

// 读取配置
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy-config.json'), 'utf8'))

const conn = new Client()
conn.on('ready', () => {
  console.log('[SSH] 连接成功\n')

  const commands = [
    { name: '系统信息', cmd: 'echo "OS: $(cat /etc/os-release | grep PRETTY_NAME | cut -d\\" -f2)" && echo "IP: $(hostname -I | awk \'{print $1}\')"' },
    { name: 'Node.js 状态', cmd: 'node -v 2>/dev/null || echo "Node.js 未安装"' },
    { name: 'MySQL 状态', cmd: 'systemctl status mysql --no-pager 2>/dev/null | head -5 || echo "MySQL 服务未找到"' },
    { name: 'MySQL 版本', cmd: 'mysql --version 2>/dev/null || echo "MySQL 未安装"' },
    { name: 'MySQL root 密码检查', cmd: 'mysql -uroot -e "SELECT 1" 2>/dev/null && echo "[OK] root 可以无密码登录" || echo "[NEED PASSWORD] root 需要密码"' },
    { name: '3002 端口占用', cmd: 'ss -tlnp | grep 3002 || echo "3002 端口空闲"' },
    { name: 'PM2 状态', cmd: 'pm2 status 2>/dev/null || echo "PM2 未安装"' }
  ]

  async function runChecks() {
    for (const item of commands) {
      console.log(`--- ${item.name} ---`)
      await new Promise((resolve, reject) => {
        conn.exec(item.cmd, (err, stream) => {
          if (err) return reject(err)
          stream.on('data', data => process.stdout.write(data.toString()))
          stream.stderr.on('data', data => process.stderr.write(data.toString()))
          stream.on('close', () => {
            console.log('')
            resolve()
          })
        })
      })
    }
    conn.end()
    console.log('检查完成')
  }

  runChecks().catch(err => {
    console.error(err)
    conn.end()
  })
})

conn.on('error', err => {
  console.error('[SSH] 连接失败:', err.message)
})

const connectConfig = {
  host: config.host,
  port: config.port || 22,
  username: config.username,
  readyTimeout: 30000
}

if (config.privateKey) {
  connectConfig.privateKey = fs.readFileSync(path.join(__dirname, config.privateKey))
} else if (config.password) {
  connectConfig.password = config.password
}

conn.connect(connectConfig)
