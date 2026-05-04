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
    // Check users in database
    console.log('=== Users in database ===')
    const r1 = await execCmd('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node -e "const {pool}=require(\'./db\');pool.execute(\'SELECT id,username,user_type,role,status,parent_id FROM users\').then(([r])=>{console.log(JSON.stringify(r,null,2));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"')
    console.log(r1.trim().substring(0, 1000))

    // Check server-api startup log (last 20 lines)
    console.log('\n=== server-api recent log ===')
    const r2 = await execCmd('type C:\\Users\\Administrator\\dianxiaoer-api\\data\\users.json 2>nul')
    console.log('users.json:', r2.trim().substring(0, 300))

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
