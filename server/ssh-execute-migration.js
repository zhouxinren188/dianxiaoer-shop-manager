const { Client } = require('ssh2')
const conn = new Client()

conn.on('ready', () => {
  console.log('[SSH] Connected to remote server')
  
  // 通过SSH在远程服务器上执行Node.js脚本
  const scriptPath = 'C:\\dianxiaoer-shop-manager\\server\\add-last-sync-at.js'
  const cmd = `node "${scriptPath}"`
  
  console.log(`[SSH] Executing: ${cmd}`)
  
  conn.exec(cmd, (err, stream) => {
    if (err) { 
      console.error('Exec error:', err)
      conn.end()
      return 
    }
    
    let out = ''
    let errOut = ''
    
    stream.on('data', data => {
      out += data.toString()
      console.log('[STDOUT]', data.toString())
    })
    
    stream.stderr.on('data', data => {
      errOut += data.toString()
      console.error('[STDERR]', data.toString())
    })
    
    stream.on('close', code => {
      console.log(`[SSH] Process exited with code: ${code}`)
      console.log('=== Output ===')
      console.log(out)
      if (errOut) {
        console.error('=== Errors ===')
        console.error(errOut)
      }
      conn.end()
    })
  })
}).on('error', err => {
  console.error('[SSH] Connection error:', err.message)
})

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
})
