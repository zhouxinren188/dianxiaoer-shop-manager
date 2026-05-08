const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const HOST = '150.158.54.108'
const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')
const REMOTE_DIR = 'C:/Users/Administrator/dianxiaoer-api/updates'

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

conn.on('ready', async () => {
  console.log('SSH connected')

  try {
    // 1. 重命名 exe
    console.log('Renaming exe 1.3.8 -> 1.3.9...')
    const r1 = await execCmd(`rename "${REMOTE_DIR}\\dianxiaoer-setup-1.3.8.exe" dianxiaoer-setup-1.3.9.exe`)
    console.log('Rename exe:', r1.stdout.trim() || r1.stderr.trim() || 'OK')

    // 2. 重命名 blockmap
    console.log('Renaming blockmap 1.3.8 -> 1.3.9...')
    const r2 = await execCmd(`if exist "${REMOTE_DIR}\\dianxiaoer-setup-1.3.8.exe.blockmap" rename "${REMOTE_DIR}\\dianxiaoer-setup-1.3.8.exe.blockmap" dianxiaoer-setup-1.3.9.exe.blockmap`)
    console.log('Rename blockmap:', r2.stdout.trim() || r2.stderr.trim() || 'OK')

    // 3. 生成新的 latest.yml
    const ymlContent = [
      'version: 1.3.9',
      'files:',
      '  - url: dianxiaoer-setup-1.3.9.exe',
      '    sha512: eIPcu3EdMWxQM0XnQORHc2J2cCKqtLJQ7f/uXkAqRTctnxtu7Tz+3huyQzjvVsP4J8xEvL3MRo3i9rOQSmkpZQ==',
      '    size: 114600421',
      'path: dianxiaoer-setup-1.3.9.exe',
      'sha512: eIPcu3EdMWxQM0XnQORHc2J2cCKqtLJQ7f/uXkAqRTctnxtu7Tz+3huyQzjvVsP4J8xEvL3MRo3i9rOQSmkpZQ==',
      "releaseDate: '2026-05-06T16:30:00.000Z'",
      ''
    ].join('\n')

    const tmpYml = path.join(__dirname, 'dist', 'latest.yml')
    fs.writeFileSync(tmpYml, ymlContent)
    console.log('Written new latest.yml')

    // 4. SFTP 上传 latest.yml
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(tmpYml)
      const ws = sftp.createWriteStream(`${REMOTE_DIR}/latest.yml`)
      ws.on('close', () => { console.log('latest.yml uploaded'); resolve() })
      ws.on('error', reject)
      rs.on('error', reject)
      rs.pipe(ws)
    })

    sftp.end()

    // 5. 验证
    console.log('\nVerifying remote files...')
    const v = await execCmd(`dir "${REMOTE_DIR}" 2>&1`)
    console.log(v.stdout.trim().substring(0, 600))

    console.log('\nDone!')
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    conn.end()
  }
})

conn.on('error', err => { console.error('SSH error:', err.message) })
conn.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000 })
