const { Client } = require('ssh2')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'
const DEPLOY_DIR = 'C:\\Users\\Administrator\\dianxiaoer-server'
const NSSM = 'C:\\nssm\\nssm.exe'

function execCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', (code) => {
        resolve({ code, stdout, stderr })
      })
    })
  })
}

async function deploy() {
  const conn = new Client()

  conn.on('ready', async () => {
    console.log('[Deploy] SSH connected')

    try {
      // 1. Git pull
      console.log('[Deploy] Pulling latest code...')
      const pull = await execCommand(conn, `cd /d ${DEPLOY_DIR} && git pull origin main`)
      console.log(pull.stdout)
      if (pull.stderr) console.error(pull.stderr)

      // 2. Install multer
      console.log('[Deploy] Installing multer...')
      const install = await execCommand(conn, `cd /d ${DEPLOY_DIR} && npm install multer`)
      console.log(install.stdout)
      if (install.stderr) console.error(install.stderr)

      // 3. Restart service
      console.log('[Deploy] Restarting service...')
      const restart = await execCommand(conn, `${NSSM} restart dianxiaoer-server`)
      console.log(restart.stdout)
      if (restart.stderr) console.error(restart.stderr)

      // 4. Wait and check
      console.log('[Deploy] Waiting 3s for service startup...')
      await new Promise(r => setTimeout(r, 3000))

      const health = await execCommand(conn, `curl -s http://localhost:3001/health`)
      console.log('[Deploy] Health check:', health.stdout)

      console.log('[Deploy] Done.')
    } catch (e) {
      console.error('[Deploy] Error:', e.message)
    } finally {
      conn.end()
    }
  })

  conn.on('error', err => {
    console.error('[Deploy] SSH error:', err.message)
    process.exit(1)
  })

  conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
}

deploy()
