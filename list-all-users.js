const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  const script = `
const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'jd123456',
  database: 'dianxiaoer'
});

connection.connect((err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    process.exit(1);
  }
  
  connection.query('SELECT id, username, phone, role, status, created_at FROM users ORDER BY id', (err, results) => {
    if (err) {
      console.error('查询失败:', err.message);
    } else {
      console.log('数据库中的所有用户:');
      console.log(JSON.stringify(results, null, 2));
    }
    connection.end();
  });
});
`;

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/list-users.js';
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    sftp.writeFile(remotePath, script, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message);
        process.exit(1);
      }
      
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node list-users.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\list-users.js', () => {
            conn.end();
          });
        });
      });
    });
  });
});

conn.on('error', err => {
  console.error('SSH error:', err.message);
  process.exit(1);
});

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
});
