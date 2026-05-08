const { Client } = require('ssh2');
const conn = new Client();
const pw = 'K9#m2' + String.fromCharCode(36) + 'vL5@zQ';

conn.on('ready', () => {
  const mysqlBin = '"C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe"';
  const sql = "SELECT order_id, warehouse_name, LEFT(raw_data, 2000) FROM sales_orders WHERE store_id=66 AND (warehouse_name IS NULL OR warehouse_name='') ORDER BY updated_at DESC LIMIT 3;";
  const cmd = mysqlBin + ' -u root -pjd123456 -P 3307 dianxiaoer -e "' + sql.replace(/"/g, '\\"') + '"';
  conn.exec(cmd, (err, stream) => {
    if (err) { console.error(err.message); conn.end(); return; }
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', () => {
      console.log(out);
      if (errOut) console.error('STDERR:', errOut);
      conn.end();
    });
  });
}).on('error', e => { console.error('SSH error:', e.message); });

conn.connect({
  host: '150.158.54.108', port: 22,
  username: 'administrator', password: pw,
  readyTimeout: 30000
});
