const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected')

  const script = `
const fs = require('fs')
const path = require('path')

const lockoutFile = 'C:/Users/Administrator/dianxiaoer-api/data/lockout.json'

try {
  const record = JSON.parse(fs.readFileSync(lockoutFile, 'utf-8'))
  console.log('当前锁定记录:')
  console.log(JSON.stringify(record, null, 2))
  
  // 清除 18851240333 的锁定
  if (record['18851240333']) {
    delete record['18851240333']
    fs.writeFileSync(lockoutFile, JSON.stringify(record, null, 2))
    console.log('\n已清除用户 18851240333 的锁定记录')
  } else {
    console.log('\n用户 18851240333 没有锁定记录')
  }
} catch (e) {
  console.error('Error:', e.message)
  // 如果文件不存在，创建一个空的
  fs.writeFileSync(lockoutFile, JSON.stringify({}))
  console.log('已创建空的 lockout.json')
}
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-api/clear-lockout.js'

  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message)
      process.exit(1)
    }

    sftp.writeFile(remotePath, script, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message)
        process.exit(1)
      }

      conn.exec('cd C:/Users/Administrator/dianxiaoer-api && node clear-lockout.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-api\\clear-lockout.js', () => {
            conn.end()
          })
        })
      })
    })
  })
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
  readyTimeout: 15000
})
