module.exports = {
  apps: [{
    name: 'dianxiaoer-server',
    script: 'index.js',
    cwd: 'C:\\Users\\Administrator\\dianxiaoer-server',
    env: {
      DB_HOST: '127.0.0.1',
      DB_PORT: 3307,
      DB_USER: 'root',
      DB_PASSWORD: 'jd123456',
      DB_NAME: 'dianxiaoer',
      PORT: 3002
    },
    max_restarts: 10,
    restart_delay: 3000
  }]
}
