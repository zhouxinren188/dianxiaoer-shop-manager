const { Client } = require('ssh2');
const bcrypt = require('bcryptjs');

const conn = new Client();
const defaultPassword = 'wttasd622622';
const passwordHash = bcrypt.hashSync(defaultPassword, 10);

conn.on('ready', () => {
  console.log('SSH connected');
  console.log('密码 hash:', passwordHash);
  
  const script = `
const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'jd123456',
  database: 'dianxiaoer'
});

const passwordHash = ${JSON.stringify(passwordHash)};

connection.connect((err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    process.exit(1);
  }
  
  // 检查用户是否存在
  connection.query('SELECT id FROM users WHERE username = ?', ['18851240333'], (err, results) => {
    if (err) {
      console.error('查询失败:', err.message);
      connection.end();
      process.exit(1);
    }
    
    if (results.length > 0) {
      // 用户已存在，更新密码
      connection.query('UPDATE users SET password_hash = ? WHERE username = ?', [passwordHash, '18851240333'], (err) => {
        if (err) {
          console.error('更新失败:', err.message);
        } else {
          console.log('用户 18851240333 密码已更新');
        }
        connection.end();
      });
    } else {
      // 用户不存在，创建新用户
      connection.query(
        'INSERT INTO users (username, real_name, phone, password_hash, user_type, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['18851240333', '18851240333', '18851240333', passwordHash, 'master', 'admin', 'enabled'],
        (err, result) => {
          if (err) {
            console.error('创建失败:', err.message);
          } else {
            console.log('用户 18851240333 已创建，ID:', result.insertId);
          }
          connection.end();
        }
      );
    }
  });
});
`;

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/add-user-1885.js';
  
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
      
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node add-user-1885.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\add-user-1885.js', () => {
            conn.end();
            console.log('\n完成');
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
