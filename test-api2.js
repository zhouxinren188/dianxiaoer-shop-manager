const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')
const conn = new Client()

const keyPath = path.join(__dirname, 'server-key/id_rsa')

const remoteScript = `
const m = require('C:/dianxiaoer-server/node_modules/mysql2/promise');
(async () => {
  const c = await m.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});
  const [data] = await c.execute('SELECT order_id, warehouse_name, total_amount, goods_amount FROM sales_orders WHERE warehouse_name != ? LIMIT 5', ['']);
  console.log(JSON.stringify(data, null, 2));
  await c.end();
  process.exit(0);
})().catch(e => { console.log(e.message); process.exit(1); });
`

conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.log('SFTP error:', err.message); conn.end(); process.exit() }
    sftp.writeFile('C:/dianxiaoer-server/check-api.js', remoteScript, 'utf8', (err) => {
      if (err) { console.log('Upload error:', err.message); conn.end(); process.exit() }
      conn.exec('node C:\\dianxiaoer-server\\check-api.js', (err, stream) => {
        if (err) { console.log('Exec error:', err.message); conn.end(); process.exit() }
        let out = ''
        stream.on('data', d => out += d.toString())
        stream.stderr.on('data', d => out += d.toString())
        stream.on('close', () => { console.log(out.trim()); conn.end() })
      })
    })
  })
})
conn.on('error', err => { console.log('SSH error:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: fs.readFileSync(keyPath), readyTimeout: 30000 })
