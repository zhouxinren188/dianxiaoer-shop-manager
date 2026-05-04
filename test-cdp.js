const WebSocket = require('ws')
const targetId = '5818BEECDF2C72449A5317B5F8E96BE2'
const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${targetId}`)
let id = 1

function sendCommand(method, params = {}) {
  return new Promise((resolve) => {
    const msgId = id++
    ws.send(JSON.stringify({ id: msgId, method, params }))
    const handler = (data) => {
      const msg = JSON.parse(data)
      if (msg.id === msgId) {
        ws.removeListener('message', handler)
        resolve(msg.result)
      }
    }
    ws.on('message', handler)
  })
}

ws.on('open', async () => {
  // 先看登录页面结构
  const result = await sendCommand('Runtime.evaluate', {
    expression: 'document.body.innerHTML.substring(0, 3000)'
  })
  console.log('PAGE HTML:', result.result?.value?.substring(0, 2000))

  ws.close()
  process.exit(0)
})

setTimeout(() => { process.exit(0) }, 8000)
