const { Client } = require('ssh2');
const bcrypt = require('bcryptjs');

const conn = new Client();

// 生成密码 hash
const password = 'jd123456';
const passwordHash = bcrypt.hashSync(password, 10);

const newUserData = {
  "店小二": {
    password: passwordHash,
    phone: "",
    createdAt: new Date().toISOString()
  }
};

console.log('生成的密码 hash:', passwordHash);

const updateScript = `
const fs = require('fs');
const path = require('path');

const usersPath = 'C:/Users/Administrator/dianxiaoer-api/data/users.json';
let users = {};

try {
  if (fs.existsSync(usersPath)) {
    users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  }
} catch (e) {
  console.error('读取失败:', e.message);
}

// 添加店小二用户
users['店小二'] = ${JSON.stringify(newUserData['店小二'])};

fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8');
console.log('用户已添加/更新');
console.log('当前用户列表:', Object.keys(users).join(', '));
`;

conn.on('ready', () => {
  console.log('SSH connected');
  const remotePath = 'C:/Users/Administrator/dianxiaoer-api/add-user.js';
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    sftp.writeFile(remotePath, updateScript, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message);
        process.exit(1);
      }
      
      conn.exec('node C:/Users/Administrator/dianxiaoer-api/add-user.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          // 清理临时文件
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-api\\add-user.js', () => {
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
