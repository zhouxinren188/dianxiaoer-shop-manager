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
      stream.on('close', (code) => resolve({ code, stdout, stderr }))
    })
  })
}

async function deploy() {
  const conn = new Client()

  conn.on('ready', async () => {
    console.log('[Deploy] SSH connected')

    try {
      // Check git availability
      const gitCheck = await execCommand(conn, 'where git')
      console.log('[Deploy] Git path:', gitCheck.stdout.trim())

      // Git pull
      console.log('[Deploy] Pulling latest code...')
      const pull = await execCommand(conn, `cd /d ${DEPLOY_DIR} && git pull origin main`)
      console.log('[Deploy] Pull stdout:', pull.stdout)
      if (pull.stderr) console.error('[Deploy] Pull stderr:', pull.stderr)

      // Install multer if needed
      console.log('[Deploy] Ensuring multer installed...')
      const install = await execCommand(conn, `cd /d ${DEPLOY_DIR} && npm install multer`)
      if (install.stdout.includes('added') || install.stdout.includes('changed')) {
        console.log('[Deploy] multer installed/updated')
      }

      // Restart service
      console.log('[Deploy] Restarting dianxiaoer-server...')
      const restart = await execCommand(conn, `${NSSM} restart dianxiaoer-server`)
      console.log('[Deploy] Restart:', restart.stdout)

      // Health check
      await new Promise(r => setTimeout(r, 4000))
      const health = await execCommand(conn, 'curl -s http://localhost:3001/health')
      console.log('[Deploy] Health:', health.stdout)

      // Check update API
      const updateCheck = await execCommand(conn, 'curl -s http://localhost:3001/api/update/check?version=0.0.0')
      console.log('[Deploy] Update API:', updateCheck.stdout)

      console.log('[Deploy] Done.')
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

  conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
}

deploy()
