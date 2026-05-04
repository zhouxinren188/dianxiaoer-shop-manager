const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'
const NSSM = 'C:/nssm/nssm.exe'

const conn = new Client()

function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = '', stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', code => resolve({ code, stdout, stderr }))
    })
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

conn.on('ready', async () => {
  console.log('[Deploy] SSH connected')

  try {
    // Step 1: 检查目录和服务（单条命令减少连接压力）
    console.log('\n[1] Checking directories and services...')
    const r1 = await execCmd('dir /b C:\\Users\\Administrator\\dianxiaoer-server 2>nul & echo === & dir /b C:\\Users\\Administrator\\dianxiaoer-api 2>nul & echo === & ' + NSSM + ' get dianxiaoer-server AppDirectory 2>&1 & echo === & ' + NSSM + ' get dianxiaoer-api AppDirectory 2>&1')
    console.log(r1.stdout)

    // Step 2: 上传 server/index.js 到 dianxiaoer-server
    console.log('\n[2] Uploading server/index.js...')
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    const localServerIndex = path.join(__dirname, '..', 'server', 'index.js')
    await new Promise((resolve, reject) => {
      sftp.fastPut(localServerIndex, 'C:/Users/Administrator/dianxiaoer-server/index.js', err => err ? reject(err) : resolve())
    })
    console.log('[2] server/index.js uploaded')

    // Step 3: 上传 server-api/index.js 到 dianxiaoer-api
    console.log('\n[3] Uploading server-api/index.js...')
    const localApiIndex = path.join(__dirname, '..', 'server-api', 'index.js')

    // 先尝试 dianxiaoer-api 目录
    let apiUploaded = false
    try {
      await new Promise((resolve, reject) => {
        sftp.fastPut(localApiIndex, 'C:/Users/Administrator/dianxiaoer-api/index.js', err => err ? reject(err) : resolve())
      })
      apiUploaded = true
      console.log('[3] server-api/index.js uploaded to dianxiaoer-api/')
    } catch (e) {
      console.log('[3] dianxiaoer-api directory not found, trying other locations...')
    }

    if (!apiUploaded) {
      // 查找 server-api 的实际位置
      const findResult = await execCmd('dir /s /b C:\\Users\\Administrator\\index.js 2>nul | findstr /i "api"')
      console.log('[3] Found api-related index.js files:', findResult.stdout.trim())
      // 也检查 dianxiaoer-server 下是否有 server-api 子目录
      const checkSub = await execCmd('dir /b C:\\Users\\Administrator\\dianxiaoer-server\\server-api 2>nul & dir /b C:\\Users\\Administrator\\dianxiaoer-server\\api 2>nul')
      console.log('[3] Subdirs:', checkSub.stdout.trim())
    }

    sftp.end()

    // Step 4: 重启服务
    console.log('\n[4] Restarting services...')
    await sleep(1000)
    const restartServer = await execCmd(NSSM + ' restart dianxiaoer-server 2>&1')
    console.log('[4] dianxiaoer-server restart:', restartServer.stdout.trim(), restartServer.stderr.trim())

    await sleep(1000)
    const restartApi = await execCmd(NSSM + ' restart dianxiaoer-api 2>&1')
    console.log('[4] dianxiaoer-api restart:', restartApi.stdout.trim(), restartApi.stderr.trim())

    // Step 5: 健康检查
    console.log('\n[5] Health check...')
    await sleep(5000)
    const health1 = await execCmd('curl -s http://localhost:3001/api/health 2>&1')
    console.log('[5] port 3001:', health1.stdout.trim())

    const health2 = await execCmd('curl -s http://localhost:3002/health 2>&1')
    console.log('[5] port 3002:', health2.stdout.trim())

    // Step 6: 验证 JWT_SECRET 配置
    console.log('\n[6] Verifying JWT_SECRET config...')
    const jwt1 = await execCmd('findstr "JWT_SECRET" C:\\Users\\Administrator\\dianxiaoer-server\\index.js 2>nul')
    console.log('[6] server JWT_SECRET:', jwt1.stdout.trim().substring(0, 150))

    const jwt2 = await execCmd('findstr "JWT_SECRET" C:\\Users\\Administrator\\dianxiaoer-api\\index.js 2>nul')
    console.log('[6] api JWT_SECRET:', jwt2.stdout.trim().substring(0, 150))

    console.log('\n[Deploy] Deployment complete!')
  } catch (e) {
    console.error('[Deploy] Error:', e.message)
  } finally {
    conn.end()
    process.exit(0)
  }
})

conn.on('error', err => {
  console.error('[Deploy] SSH error:', err.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 20000, keepaliveInterval: 5000 })
