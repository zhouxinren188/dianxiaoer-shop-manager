const { Client } = require('ssh2')
const fs = require('fs')
const conn = new Client()
conn.on('ready', () => {
  // 1. Find mysql.exe
  conn.exec('where mysql.exe 2>nul || dir /s /b C:\\*.exe 2>nul | findstr /i mysql', (err, stream) => {
    if(err) { console.log('Find error:', err.message); conn.end(); process.exit() }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('MySQL path search:', out.trim() || 'not found via where/dir')
      // 2. Try common paths
      const paths = [
        'C:/MySQL/bin/mysql.exe',
        'C:/mysql/bin/mysql.exe',
        'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe',
        'C:/Program Files/MySQL/MySQL Server 5.7/bin/mysql.exe'
      ]
      let checked = 0
      paths.forEach(p => {
        conn.exec(`if exist "${p}" echo FOUND: ${p}`, (err2, stream2) => {
          checked++
          let o2 = ''
          stream2.on('data', d => o2 += d.toString())
          stream2.stderr.on('data', d => o2 += d.toString())
          stream2.on('close', () => {
            if (o2.trim()) console.log(o2.trim())
            if (checked === paths.length) {
              // 3. Check server files for db config
              conn.exec('type C:\\dianxiaoer-server\\db.js | findstr "port\\|host\\|password"', (err3, stream3) => {
                if(err3) { console.log('Type error:', err3.message); conn.end(); process.exit() }
                let o3 = ''
                stream3.on('data', d => o3 += d.toString())
                stream3.stderr.on('data', d => o3 += d.toString())
                stream3.on('close', () => {
                  console.log('Remote db.js config:', o3.trim())
                  conn.end()
                })
              })
            }
          })
        })
      })
    })
  })
})
conn.on('error', err => { console.log('SSH error:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: fs.readFileSync('server-key/id_rsa'), readyTimeout: 30000 })
