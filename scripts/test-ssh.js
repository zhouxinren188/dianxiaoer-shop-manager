const { Client } = require('ssh2')
const conn = new Client()
conn.on('ready', () => {
  console.log('CONNECTED')
  conn.end()
  process.exit(0)
})
conn.on('error', e => {
  console.error('ERROR:', e.message)
  process.exit(1)
})
conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 20000
})
