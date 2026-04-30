const { Client } = require('ssh2')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'

const conn = new Client()

conn.on('ready', () => {
  const nssm = 'C:\\nssm\\nssm.exe'
  const params = ['Application', 'AppDirectory', 'AppParameters', 'AppStdout', 'AppStderr']
  let i = 0

  function next() {
    if (i >= params.length) {
      conn.exec('dir /s /b C:\\dianxiaoer-server 2>nul & dir /s /b C:\\Users\\Administrator\\dianxiaoer-server 2>nul', (err, stream) => {
        let out = ''
        stream.on('data', d => out += d.toString())
        stream.stderr.on('data', d => out += d.toString())
        stream.on('close', () => {
          console.log('\n[Dirs]\n' + out.trim())
          conn.end()
          process.exit(0)
        })
      })
      return
    }
    const p = params[i++]
    conn.exec(`${nssm} get dianxiaoer-server ${p}`, (err, stream) => {
      let out = ''
      stream.on('data', d => out += d.toString())
      stream.on('close', () => {
        console.log(`${p}: ${out.trim()}`)
        next()
      })
    })
  }

  next()
}).on('error', err => {
  console.error('Error:', err.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
