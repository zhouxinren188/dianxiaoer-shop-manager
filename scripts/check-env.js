const { Client } = require('ssh2')
const conn = new Client()

function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', d => out += d.toString())
      stream.stderr.on('data', d => out += d.toString())
      stream.on('close', () => resolve(out))
    })
  })
}

conn.on('ready', async () => {
  try {
    // Check .env file in dianxiaoer-api
    console.log('=== .env in dianxiaoer-api ===')
    const env1 = await execCmd('type C:\\Users\\Administrator\\dianxiaoer-api\\.env 2>nul')
    console.log(env1.trim())

    // Check .env file in dianxiaoer-server
    console.log('\n=== .env in dianxiaoer-server ===')
    const env2 = await execCmd('type C:\\Users\\Administrator\\dianxiaoer-server\\.env 2>nul')
    console.log(env2.trim().substring(0, 300))

    // Check NSSM dianxiaoer-api AppEnvironment
    console.log('\n=== NSSM dianxiaoer-api AppEnvironment ===')
    const env4 = await execCmd('C:/nssm/nssm.exe get dianxiaoer-api AppEnvironment 2>&1')
    console.log(env4.trim().substring(0, 500))

    // Check NSSM dianxiaoer-server AppEnvironment
    console.log('\n=== NSSM dianxiaoer-server AppEnvironment ===')
    const env5 = await execCmd('C:/nssm/nssm.exe get dianxiaoer-server AppEnvironment 2>&1')
    console.log(env5.trim().substring(0, 500))

  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    conn.end()
    process.exit(0)
  }
})

conn.on('error', err => {
  console.error('SSH error:', err.message)
  process.exit(1)
})

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 20000,
  keepaliveInterval: 5000
})
