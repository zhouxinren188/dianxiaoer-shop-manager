const http = require('http')

function post(path, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve(d))
    })
    req.on('error', e => reject(e.message))
    req.write(JSON.stringify(data))
    req.end()
  })
}

post('/api/login', { username: 'admin', password: 'admin' }).then(console.log).catch(console.error)
