const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  conn.exec('dir C:\\Users\\Administrator\\dianxiaoer-server', (err, stream) => {
    let out = ''
    stream.on('data', d => out += d)
    stream.on('close', () => {
      console.log('Directory listing:')
      console.log(out)
      conn.end()
    })
  })
})

conn.on('error', err => console.error('SSH:', err.message))
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ' })
