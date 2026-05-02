const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('[SSH] Connected')
  
  // 查找MySQL可执行文件
  const findCmd = 'where mysql.exe'
  
  conn.exec(findCmd, (err, stream) => {
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('MySQL location search result:')
      console.log(out)
      conn.end()
    })
  })
}).on('error', err => {
  console.error('SSH error:', err.message)
})

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
})
