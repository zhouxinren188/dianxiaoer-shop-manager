const { spawn } = require('child_process')
const s = spawn('node', ['server.js'], {
  detached: true,
  stdio: 'ignore',
  cwd: 'C:/dianxiaoer-server'
})
s.unref()
console.log('spawned pid: ' + s.pid)
process.exit(0)
