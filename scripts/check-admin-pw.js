const { Client } = require('ssh2')
const conn = new Client()

function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = '', errOut = ''
      stream.on('data', d => out += d.toString())
      stream.stderr.on('data', d => errOut += d.toString())
      stream.on('close', () => resolve({ out, err: errOut }))
    })
  })
}

conn.on('ready', async () => {
  try {
    // Write a temp script to check passwords
    const checkScript = `
const m = require('mysql2/promise');
(async () => {
  const pool = m.createPool({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});
  const [rows] = await pool.execute('SELECT id,username,LEFT(password_hash,25) as pw FROM users');
  rows.forEach(r => console.log(r.id, r.username, JSON.stringify(r.pw)));
  await pool.end();
})().catch(e => console.error(e.message));
`
    // Upload script via SFTP
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    const writeStream = sftp.createWriteStream('C:/Users/Administrator/dianxiaoer-server/_check-pw.js')
    writeStream.write(checkScript)
    writeStream.end()
    await new Promise(r => writeStream.on('close', r))
    sftp.end()

    // Execute the script
    console.log('=== Password hashes in DB ===')
    const r1 = await execCmd('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node _check-pw.js 2>&1')
    console.log(r1.out.trim())
    if (r1.err.trim()) console.log('stderr:', r1.err.trim())

    // Clean up
    await execCmd('del C:\\Users\\Administrator\\dianxiaoer-server\\_check-pw.js 2>nul')

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
