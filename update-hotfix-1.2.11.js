const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  const script = `
const fs = require('fs')

const metaFile = 'C:/Users/Administrator/dianxiaoer-api/updates/update-meta.json'
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))

meta.hotfixVersion = "1.2.11"
meta.hotfix = {
  version: "1.2.11",
  url: "http://150.158.54.108:3001/updates/hot/update-1.2.11.zip",
  sha256: "6b112862f275fa80c9dac182fea52d504944c8618ed11a11c2b5288dffdc1b63",
  size: 643808,
  changelog: "修复同步订单锁未释放问题，修复自动同步跳过问题"
}

fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
console.log('OK: update-meta.json updated for v1.2.11')
`

  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP:', err.message); process.exit(1) }
    sftp.writeFile('C:/Users/Administrator/dianxiaoer-api/update-meta.js', script, 'utf8', (err) => {
      if (err) { console.error('Write:', err.message); process.exit(1) }
      conn.exec('cd C:/Users/Administrator/dianxiaoer-api && node update-meta.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', () => {
          console.log(out)
          if (errOut) console.error(errOut)
          conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-api\\update-meta.js"', () => conn.end())
        })
      })
    })
  })
})

conn.on('error', err => { console.error('SSH:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ' })
