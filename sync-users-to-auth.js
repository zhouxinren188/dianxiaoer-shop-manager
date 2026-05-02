const { Client } = require('ssh2');
const bcrypt = require('bcryptjs');

const conn = new Client();

// 默认密码
const defaultPassword = 'jd123456';

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 先查询数据库用户
  const queryScript = `
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
  
  connection.query('SELECT id, username, phone, role FROM users ORDER BY id', (err, dbUsers) => {
    if (err) {
      console.error('查询失败:', err.message);
      connection.end();
      process.exit(1);
    }
    
    console.log(JSON.stringify(dbUsers));
    connection.end();
  });
});
`;

  const queryPath = 'C:/Users/Administrator/dianxiaoer-server/query-db.js';
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    sftp.writeFile(queryPath, queryScript, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message);
        process.exit(1);
      }
      
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node query-db.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          if (errOut) {
            console.error('查询错误:', errOut);
            process.exit(1);
          }
          
          try {
            const dbUsers = JSON.parse(out.trim());
            console.log('数据库用户:', dbUsers.map(u => u.username).join(', '));
            
            // 生成用户数据
            const usersJson = {};
            dbUsers.forEach(dbUser => {
              const passwordHash = bcrypt.hashSync(defaultPassword, 10);
              usersJson[dbUser.username] = {
                password: passwordHash,
                phone: dbUser.phone || '',
                role: dbUser.role || 'staff',
                createdAt: new Date().toISOString()
              };
            });
            
            console.log('生成的用户列表:', Object.keys(usersJson).join(', '));
            
            // 写入 users.json
            const writeScript = `
const fs = require('fs');
const users = ${JSON.stringify(usersJson, null, 2)};
fs.writeFileSync('C:/Users/Administrator/dianxiaoer-api/data/users.json', JSON.stringify(users, null, 2), 'utf8');
console.log('已写入 ' + Object.keys(users).length + ' 个用户');
`;
            
            const writePath = 'C:/Users/Administrator/dianxiaoer-api/write-users.js';
            
            conn.sftp((err2, sftp2) => {
              sftp2.writeFile(writePath, writeScript, 'utf8', (err) => {
                if (err) {
                  console.error('Write error:', err.message);
                  process.exit(1);
                }
                
                conn.exec('node C:/Users/Administrator/dianxiaoer-api/write-users.js', (err, stream2) => {
                  let out2 = '', errOut2 = '';
                  stream2.on('data', d => out2 += d);
                  stream2.stderr.on('data', d => errOut2 += d);
                  stream2.on('close', (code2) => {
                    console.log('');
                    console.log('=== 同步结果 ===');
                    console.log(out2);
                    if (errOut2) console.error('写入错误:', errOut2);
                    
                    // 清理临时文件
                    conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\query-db.js && del C:\\Users\\Administrator\\dianxiaoer-api\\write-users.js', () => {
                      conn.end();
                      console.log('完成');
                    });
                  });
                });
              });
            });
            
          } catch (e) {
            console.error('解析错误:', e.message);
            console.error('输出内容:', out);
            process.exit(1);
          }
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
