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
    // Check update-meta.json
    console.log('=== update-meta.json ===')
    const r1 = await execCmd('type C:\\Users\\Administrator\\dianxiaoer-api\\updates\\update-meta.json 2>nul')
    console.log(r1.trim())

    // Also check data dir (fallback location)
    console.log('\n=== data/update-meta.json ===')
    const r2 = await execCmd('type C:\\Users\\Administrator\\dianxiaoer-api\\data\\update-meta.json 2>nul')
    console.log(r2.trim())
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
