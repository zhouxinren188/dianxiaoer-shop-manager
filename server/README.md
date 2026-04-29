# 店小二后端服务部署文档

## 环境要求

- Node.js >= 18
- MySQL >= 5.7

## 1. 服务器上安装依赖

```bash
cd /path/to/dianxiaoer-shop-manager/server
npm install
```

## 2. 创建 MySQL 数据库

```sql
CREATE DATABASE dianxiaoer CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

## 3. 配置数据库连接

修改 `db.js` 中的连接配置，或在启动时通过环境变量传入：

```bash
export DB_HOST=localhost
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD=你的密码
export DB_NAME=dianxiaoer
```

Windows PowerShell:
```powershell
$env:DB_HOST="localhost"
$env:DB_PORT="3306"
$env:DB_USER="root"
$env:DB_PASSWORD="你的密码"
$env:DB_NAME="dianxiaoer"
```

## 4. 启动服务

```bash
npm start
```

服务默认监听 `0.0.0.0:3002`。

## 5. 使用 PM2 持久化运行（推荐）

```bash
npm install -g pm2
pm2 start index.js --name dianxiaoer-server
pm2 save
pm2 startup
```

## 6. 防火墙放行

确保服务器防火墙放行 3002 端口：

```bash
# Ubuntu/Debian (ufw)
sudo ufw allow 3002

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=3002/tcp
sudo firewall-cmd --reload
```

## 7. 安全建议（生产环境）

1. **修改默认端口**：将 3002 改为其他端口
2. **配置 Nginx 反向代理**：添加 HTTPS、限流、访问日志
3. **数据库安全**：不要使用 root 用户，创建独立的数据库用户
4. **JWT 鉴权**：当前接口已预留 Authorization Header，后续可接入 JWT 认证
