const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected')

  const script = `
const fs = require('fs')
const path = require('path')

const metaFile = 'C:/Users/Administrator/dianxiaoer-api/updates/update-meta.json'
const meta = {
  latestVersion: "1.2.11",
  hotfixVersion: "1.2.10",
  releaseDate: new Date().toISOString(),
  changelog: "全量更新 v1.2.11",
  fullUpdate: {
    version: "1.2.11",
    url: "http://150.158.54.108:3001/updates/dianxiaoer-setup-1.2.11.exe",
    sha512: "",
    size: 110585649,
    changelog: "全量更新 v1.2.11 - 修复全量更新下载失败问题（HTTP 连接重置）"
  },
  hotfix: {
    version: "1.2.10",
    url: "http://150.158.54.108:3001/updates/hot/update-1.2.10.zip",
    sha256: "6eae469807541aca02a66326bd7f7df08281d933b170dd2b267253771ce1377a",
    size: 643808,
    changelog: "热更新 v1.2.10"
  }
}

fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
console.log('update-meta.json 已更新')
console.log(JSON.stringify(meta, null, 2))
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-api/update-meta-fix.js'

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

      conn.exec('cd C:/Users/Administrator/dianxiaoer-api && node update-meta-fix.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-api\\update-meta-fix.js', () => {
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
