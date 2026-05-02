const fs = require('fs')
const content = fs.readFileSync('C:/dianxiaoer/server/index.js', 'utf8')
const lines = content.split('\n')
lines.forEach((line, i) => {
  if (line.includes('api/login') || line.includes('api/register') || line.includes('api/me')) {
    console.log((i + 1) + ': ' + line.trim())
  }
})
