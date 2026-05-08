const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected')

  // Query DB for purchase orders with sales_order_id
  conn.exec('cd C:\\dianxiaoer-server && node -e "const mysql=require(\'mysql2/promise\');(async()=>{const p=mysql.createPool({host:\'localhost\',user:\'root\',password:\'\',database:\'dianxiaoer\'});const [rows]=await p.execute(\'SELECT id,purchase_no,sales_order_id,sales_order_no FROM purchase_orders WHERE sales_order_id IS NOT NULL AND sales_order_id!=\\\"\\\" LIMIT 3\');console.log(JSON.stringify(rows));await p.end()})()"', (err, stream) => {
    if (err) { console.error(err); process.exit(1) }
    let out = ''
    stream.on('data', d => out += d)
    stream.stderr.on('data', d => process.stderr.write(d))
    stream.on('close', () => {
      console.log('Purchase orders with sales_order_id:')
      console.log(out)
      conn.end()
    })
  })
})

conn.on('error', err => { console.error('SSH error:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa')), readyTimeout: 15000 })
