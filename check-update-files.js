const http = require('http')

// 检查服务器上的更新文件
const UPDATE_SERVER = 'http://150.158.54.108:3001'

console.log('检查服务器更新文件...\n')

// 1. 检查 latest.yml
http.get(`${UPDATE_SERVER}/updates/latest.yml`, (res) => {
  console.log('=== latest.yml ===')
  console.log('HTTP Status:', res.statusCode)
  
  if (res.statusCode === 200) {
    let data = ''
    res.on('data', chunk => data += chunk)
    res.on('end', () => {
      console.log(data)
      console.log('\n')
      checkBlockmap()
    })
  } else {
    console.log('文件不存在或无法访问')
    console.log('\n')
    checkBlockmap()
  }
}).on('error', (err) => {
  console.log('请求失败:', err.message)
  checkBlockmap()
})

// 2. 检查 .exe 文件
function checkBlockmap() {
  http.get(`${UPDATE_SERVER}/updates/dianxiaoer-setup-1.2.9.exe`, (res) => {
    console.log('=== dianxiaoer-setup-1.2.9.exe ===')
    console.log('HTTP Status:', res.statusCode)
    if (res.statusCode === 200) {
      const size = res.headers['content-length']
      console.log('File size:', size ? (parseInt(size) / 1024 / 1024).toFixed(1) + ' MB' : 'unknown')
    } else {
      console.log('文件不存在或无法访问')
    }
    console.log('\n')
    checkUpdateMeta()
  }).on('error', (err) => {
    console.log('请求失败:', err.message)
    checkUpdateMeta()
  })
}

// 3. 检查 update-meta.json
function checkUpdateMeta() {
  https.get(`${UPDATE_SERVER}/updates/update-meta.json`, { rejectUnauthorized: false }, (res) => {
    console.log('=== update-meta.json ===')
    console.log('HTTP Status:', res.statusCode)
    
    if (res.statusCode === 200) {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        console.log(data)
        console.log('\n')
        checkAPI()
      })
    } else {
      console.log('文件不存在或无法访问')
      checkAPI()
    }
  }).on('error', (err) => {
    console.log('请求失败:', err.message)
    checkAPI()
  })
}

// 4. 检查更新 API
function checkAPI() {
  https.get(`${UPDATE_SERVER}/api/update/check?version=1.2.9&appVersion=1.2.9`, { rejectUnauthorized: false }, (res) => {
    console.log('=== /api/update/check API ===')
    console.log('HTTP Status:', res.statusCode)
    
    let data = ''
    res.on('data', chunk => data += chunk)
    res.on('end', () => {
      console.log('Response:', data)
    })
  }).on('error', (err) => {
    console.log('请求失败:', err.message)
  })
}
