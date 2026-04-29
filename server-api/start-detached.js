const { spawn } = require('child_process')
const path = require('path')

const child = spawn('node', ['index.js'], {
  cwd: 'C:\\dianxiaoer-api',
  detached: true,
  stdio: 'ignore'
})

child.unref()
console.log('Server started with PID:', child.pid)
