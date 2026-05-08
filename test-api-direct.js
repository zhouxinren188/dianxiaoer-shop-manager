const http = require('http')

const options = {
  hostname: '150.158.54.108',
  port: 3002,
  path: '/health',
  method: 'GET',
  timeout: 10000
}

const req = http.request(options, (res) => {
  let data = ''
  res.on('data', chunk => data += chunk)
  res.on('end', () => {
    console.log('Health:', data)
    // Now test sales orders endpoint (will fail auth but shows if server responds)
    const req2 = http.request({
      hostname: '150.158.54.108',
      port: 3002,
      path: '/api/sales-orders?page=1&pageSize=3',
      method: 'GET',
      timeout: 10000
    }, (res2) => {
      let data2 = ''
      res2.on('data', chunk => data2 += chunk)
      res2.on('end', () => console.log('Orders:', data2.substring(0, 500)))
    })
    req2.on('error', e => console.log('Orders error:', e.message))
    req2.end()
  })
})
req.on('error', e => console.log('Health error:', e.message))
req.end()
