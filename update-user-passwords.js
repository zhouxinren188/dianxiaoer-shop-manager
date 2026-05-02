const { Client } = require('ssh2');
const bcrypt = require('bcryptjs');

const conn = new Client();
const defaultPassword = 'jd123456';

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 生成密码 hash（在本地生成）
  const passwordHash = bcrypt.hashSync(defaultPassword, 10);
  console.log('生成的密码 hash:', passwordHash);
  
  // 更新脚本（使用参数化查询）
  const updateScript = `
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
  
  const sql = 'UPDATE users SET password_hash = ? WHERE password_hash NOT LIKE ? OR password_hash = ? OR password_hash IS NULL';
  const params = [passwordHash, '$2%', ''];
  
  connection.query(sql, params, (err, result) => {
    if (err) {
      console.error('更新失败:', err.message);
    } else {
      console.log('成功更新 ' + result.affectedRows + ' 个用户的密码');
    }
    connection.end();
  });
});
`;
  
  const updatePath = 'C:/Users/Administrator/dianxiaoer-server/update-pw.js';
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    sftp.writeFile(updatePath, updateScript, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message);
        process.exit(1);
      }
      
      console.log('执行密码更新...');
      
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node update-pw.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          console.log('\n=== 更新结果 ===');
          console.log(out);
          if (errOut) console.error('错误:', errOut);
          
          // 清理临时文件
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\update-pw.js', () => {
            conn.end();
            console.log('完成');
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
