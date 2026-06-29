const { Client } = require('ssh2')
const c = new Client()

c.on('ready', () => {
  console.log('SSH connected')
  
  // 直接在 dianxiaoer-server 目录运行，利用其 node_modules
  const script = `node -e "process.chdir('C:\\\\dianxiaoer-server');const mysql=require('mysql2/promise');(async()=>{const p=mysql.createPool({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});const[u]=await p.execute('SELECT id,username,user_type,parent_id,status,created_at FROM users WHERE username=?',['店小二']);console.log('User:',JSON.stringify(u));if(u.length){const oid=u[0].user_type==='master'?u[0].id:u[0].parent_id;const[po]=await p.execute('SELECT COUNT(*) as cnt FROM purchase_orders WHERE owner_id=?',[oid]);console.log('PO_count:',JSON.stringify(po));const[all]=await p.execute('SELECT COUNT(*) as cnt FROM purchase_orders');console.log('Total_PO:',JSON.stringify(all));const[st]=await p.execute('SELECT COUNT(*) as cnt FROM stores WHERE owner_id=?',[oid]);console.log('Stores:',JSON.stringify(st))}process.exit(0)})().catch(e=>{console.error(e.message);process.exit(1)})"`

  c.exec(script, (err, stream) => {
    if (err) { console.error('exec error:', err); c.end(); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log(out)
      checkLogs()
    })
  })
})

function checkLogs() {
  // 检查服务器的 stdout/stderr 输出
  c.exec('powershell -Command "Get-ChildItem C:\\dianxiaoer-server\\*.txt,C:\\dianxiaoer-server\\*.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object { Write-Output \\\"=== $($_.Name) ===\\\"; Get-Content $_.FullName -Tail 20 }"', (err, stream) => {
    if (err) { c.end(); process.exit(0); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('\n=== Server Logs ===')
      console.log(out || 'No log files')
      c.end()
      process.exit(0)
    })
  })
}

c.on('error', e => { console.error('SSH error:', e.message); process.exit(1) })
c.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ', readyTimeout: 15000 })
