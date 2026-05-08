const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')
const conn = new Client()

const keyPath = path.join(__dirname, 'server-key/id_rsa')

// Write a temp script on remote, then run it
const remoteScript = `
const m = require('C:/dianxiaoer-server/node_modules/mysql2/promise');
(async () => {
  const c = await m.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});
  const [cols] = await c.execute("SHOW COLUMNS FROM sales_orders LIKE 'warehouse_name'");
  console.log('warehouse_name column:', JSON.stringify(cols));
  const [data] = await c.execute('SELECT order_id, warehouse_name FROM sales_orders WHERE warehouse_name != ? LIMIT 3', ['']);
  console.log('rows with warehouse_name:', JSON.stringify(data));
  await c.end();
  process.exit(0);
})().catch(e => { console.log(e.message); process.exit(1); });
`

conn.on('ready', () => {
  console.log('SSH connected, uploading check script...')

  conn.sftp((err, sftp) => {
    if (err) { console.log('SFTP error:', err.message); conn.end(); process.exit() }

    sftp.writeFile('C:/dianxiaoer-server/check-wh-col.js', remoteScript, 'utf8', (err) => {
      if (err) { console.log('Upload error:', err.message); conn.end(); process.exit() }

      console.log('Running check script on remote...')
      conn.exec('node C:\\dianxiaoer-server\\check-wh-col.js', (err, stream) => {
        if (err) { console.log('Exec error:', err.message); conn.end(); process.exit() }
        let out = ''
        stream.on('data', d => out += d.toString())
        stream.stderr.on('data', d => out += d.toString())
        stream.on('close', () => {
          console.log(out.trim())
          conn.end()
        })
      })
    })
  })
})
conn.on('error', err => { console.log('SSH error:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: fs.readFileSync(keyPath), readyTimeout: 30000 })
