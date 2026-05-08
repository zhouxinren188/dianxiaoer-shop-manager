const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const c = new Client()

function exec(cmd) {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = '', stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', () => resolve({ stdout, stderr }))
    })
  })
}

c.on('ready', async () => {
  try {
    const nodeScript = [
      'const mysql = require("mysql2/promise");',
      '(async () => {',
      '  const db = await mysql.createConnection({host:"127.0.0.1",port:3307,user:"root",password:"jd123456",database:"dianxiaoer"});',
      '  const [stores] = await db.query("SELECT id, name, platform FROM stores WHERE name LIKE \'%豆法%\' LIMIT 5");',
      '  console.log("Stores:", JSON.stringify(stores));',
      '  if (stores.length) {',
      '    const sid = stores[0].id;',
      '    const [cnt] = await db.query("SELECT COUNT(*) as cnt FROM sales_orders WHERE store_id = ?", [sid]);',
      '    console.log("Order count:", cnt[0].cnt);',
      '    const [orders] = await db.query("SELECT id, order_no, LEFT(goods_name,30) as goods, goods_amount, status_text, order_time FROM sales_orders WHERE store_id = ? ORDER BY order_time DESC LIMIT 20", [sid]);',
      '    console.log("Orders:", JSON.stringify(orders));',
      '  }',
      '  const [recent] = await db.query("SELECT id, order_no, LEFT(goods_name,30) as goods, goods_amount, status_text, order_time, store_id FROM sales_orders ORDER BY order_time DESC LIMIT 5");',
      '  console.log("Recent5:", JSON.stringify(recent));',
      '  await db.end();',
      '})().catch(e => console.error(e.message));'
    ].join('\n')

    const remoteFile = 'C:/Users/Administrator/dianxiaoer-server/_chk.js'
    const sftp = await new Promise((resolve, reject) => {
      c.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(remoteFile)
      ws.on('close', resolve)
      ws.on('error', reject)
      ws.write(nodeScript)
      ws.end()
    })
    sftp.end()

    const result = await exec('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node _chk.js 2>&1')
    console.log(result.stdout.trim().substring(0, 5000))
    if (result.stderr.trim()) console.log('STDERR:', result.stderr.trim().substring(0, 500))

    await exec('del C:\\Users\\Administrator\\dianxiaoer-server\\_chk.js 2>nul')
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    c.end()
  }
}).on('error', err => console.error('SSH error:', err.message))

c.connect({
  host: '150.158.54.108', port: 22, username: 'administrator',
  privateKey: fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa')),
  readyTimeout: 15000
})
