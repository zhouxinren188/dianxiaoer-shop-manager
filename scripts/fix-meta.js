const { Client } = require('ssh2')
const conn = new Client()

function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = '', errOut = ''
      stream.on('data', d => out += d.toString())
      stream.stderr.on('data', d => errOut += d.toString())
      stream.on('close', () => resolve({ out, errOut }))
    })
  })
}

conn.on('ready', async () => {
  try {
    // Write a script to fix the update-meta.json
    const fixScript = `
const fs = require('fs');
const metaPath = 'C:/Users/Administrator/dianxiaoer-api/updates/update-meta.json';
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
// Remove old fullUpdate, keep full (v1.3.1)
if (meta.fullUpdate) delete meta.fullUpdate;
if (meta.latestVersion) delete meta.latestVersion;
if (meta.releaseDate) delete meta.releaseDate;
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
console.log('Fixed meta:', JSON.stringify(meta, null, 2));
`
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    // Upload fix script
    const writeStream = sftp.createWriteStream('C:/Users/Administrator/dianxiaoer-api/_fix-meta.js')
    writeStream.write(fixScript)
    writeStream.end()
    await new Promise(r => writeStream.on('close', r))
    sftp.end()

    // Execute fix script
    console.log('Fixing update-meta.json...')
    const r1 = await execCmd('cd /d C:\\Users\\Administrator\\dianxiaoer-api && node _fix-meta.js 2>&1')
    console.log(r1.out.trim())

    // Clean up
    await execCmd('del C:\\Users\\Administrator\\dianxiaoer-api\\_fix-meta.js 2>nul')

    // Restart server-api
    console.log('\nRestarting dianxiaoer-api...')
    const r2 = await execCmd('C:/nssm/nssm.exe restart dianxiaoer-api 2>&1')
    console.log(r2.out.trim())

    // Wait and verify
    await new Promise(r => setTimeout(r, 5000))
    const r3 = await execCmd('curl -s "http://localhost:3001/api/update/check?version=1.3.0&appVersion=1.3.0" 2>&1')
    console.log('\nUpdate check result:', r3.out.trim().substring(0, 300))

    conn.end()
    process.exit(0)
  } catch (e) {
    console.error('Error:', e.message)
    conn.end()
    process.exit(1)
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
