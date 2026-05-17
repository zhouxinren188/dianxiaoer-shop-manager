# 店小二网店管家 - 项目开发规范

## 版本发布规范

### 版本号规则
- 格式：`MAJOR.MINOR.PATCH`（如 1.4.2）
- **必须符合 semver 规范**：PATCH 部分禁止前导零（如 `1.4.01` 不合法，`1.4.0` 不合法），electron-updater 在构造 autoUpdater 时会校验版本号，不合规直接抛异常导致应用崩溃
- **禁止使用末尾为0的版本号**（如 1.4.00），electron-builder 会规范化（1.4.00→1.4.0），导致文件名与 package.json 不一致
- 每次发布前必须在 `package.json` 中更新 version 字段

### 按变更类型选择发布方式

| 变更类型 | 发布方式 | 命令 | 包体积 |
|---------|---------|------|-------|
| renderer 前端变更 | **热更新（仅 renderer）** | `node scripts/build-hot-update.js [version] --upload` | ~1MB |
| 主进程变更 / Electron 版本升级 / 重大架构变更 | 全量发布 | `node scripts/publish-full.js` | ~112MB |

> **热更新仅支持 renderer**：主进程代码编译为 .jsc 字节码内置在 app.asar 中，无法通过热更新替换。
> 主进程变更必须发布全量更新。

> **更新优先级规则v3（2026-05-18）**：服务器 check 接口按以下顺序判断：
> 1. 基础版本落后（appVersion < fullVersion）→ 返回全量更新（必须先升级主进程）
> 2. 基础版本已达标（appVersion >= fullVersion）且 hotVersion > currentVersion → 返回热更新
> 3. 热更新之间可跳版本，但不可跳过主进程全量更新
> - 客户端传参：`version`=当前运行版本（含热更新），`appVersion`=基础版本（app.asar 的 package.json 版本）
> - 原因：热更新基于最新全量的主进程，旧主进程缺少新 IPC handler 等功能，跳过全量更新会导致功能异常
> - 发布全量更新时，版本号应 >= 当前热更新版本号，确保全量包包含所有最新修复

### 热更新发布步骤
1. 确认 `package.json` 版本号已更新
2. 提交代码到 git
3. 执行 `node scripts/build-hot-update.js [version] --upload`
4. 验证：`curl http://150.158.54.108:3001/api/update/check?version=0.0.0&appVersion=当前基础版本`

### 全量发布步骤
1. 确认 `package.json` 版本号已更新（版本号应 >= 当前热更新版本号）
2. 提交代码到 git
3. 执行 `node scripts/publish-full.js`
4. 脚本自动完成：构建 → bytenode 编译 → 打包 → SFTP 上传 → 服务端代码部署 → 重启 API 服务 → 登记全量版本
5. 验证：`curl http://150.158.54.108:3001/api/health`
6. 验证更新接口：`curl http://150.158.54.108:3001/api/update/check?version=0.0.0&appVersion=0.0.0` 应返回全量更新

> **全量发布注意事项**：
> - `publish-full.js` 的 REMOTE_DIR 必须是 `C:/dianxiaoer-api`（不是 `C:/Users/Administrator/dianxiaoer-api`）
> - `nssm restart` 会挂SSH会话，必须用 `nssm stop` + 等待 + `nssm start`，或 `taskkill /F /IM node.exe` 后 `nssm start`
> - 全量发布后必须确认 `latest.yml` 和 `update-meta.json` 的 fullUpdate 版本已同步更新，否则 electron-updater 会拒绝下载

---

## 构建流程

### 完整构建流程（全量发布自动执行）
1. `electron-vite build` → 编译 src/main/ 为 out/main/index.js（~700KB 单文件），src/preload/ 为 out/preload/index.js，src/renderer/ 为前端资源
2. `node scripts/compile-bytecode.js` → bytenode 编译 index.js → index.jsc 字节码，**index.js 替换为引导加载器**（直接加载内置 index.jsc），preload 同样编译为 .jsc + loader stub
3. `electron-builder --win` → 打包 NSIS 安装程序，包含 out/\*\*/* 和 resources/\*\*/*

### 热更新 ZIP 结构（renderer-only）
```
renderer/                   前端资源
version.json                版本元数据
```

### version.json 字段
```json
{
  "version": "1.8.5",
  "buildTime": "2026-05-18T..."
}
```

---

## 代码规范

### 资源路径引用
| 用途 | 正确写法 |
|------|---------|
| 引用 resources 下文件 | `path.join(process.resourcesPath, 'app.asar', 'resources', 'xxx')` |
| 引用 preload 脚本 | `path.join(__dirname, '..', 'preload', 'index.js')` |
| 引用 renderer 页面 | `getHotUpdateRendererPath()` |
| 引用 purchase-preload | `path.join(app.getAppPath(), 'out/main/purchase-preload.js')` |
| 引用 platform-login-preload | `path.join(app.getAppPath(), 'resources/platform-login-preload.js')` |

### Cookie 有效性校验
使用 `hasValidPlatformCookies(cookies, platform)` 代替 `cookies.length === 0` 检查：
- 仅检查 cookies 数量会遗漏已过期但非空的场景
- `hasValidPlatformCookies` 检查过期时间和平台域名匹配
- 平台域名映射：pinduoduo→pinduoduo.com/yangkeduo.com, taobao→taobao.com/tmall.com, 1688→1688.com/alibaba.com

### el-table 事件冒泡
el-table 上的 `@row-click` 会拦截子元素的点击事件。原生 HTML 元素（span、a 等）需要 `@click.stop` 阻止冒泡；el-button 等组件内部已处理，无需额外修饰。

### 远程服务器部署路径
- **dianxiaoer-server**（业务服务 port 3002）：`C:/dianxiaoer-server/`
- **dianxiaoer-api**（认证服务 port 3001）：`C:/dianxiaoer-api/`
- 两个服务路径已统一，都在 `C:\` 根目录下
- SFTP 上传目标用正斜杠：`C:/dianxiaoer-server/`、`C:/dianxiaoer-api/`
- 部署后务必用 curl 验证远程 API 返回数据是否符合预期，不能仅靠文件上传成功判断

---

## 常用命令速查

```bash
# 开发
npm run dev

# 构建测试
npm run build

# 字节码编译
npm run compile

# 打包安装程序（不发布）
npm run dist

# 热更新发布（renderer-only）
node scripts/build-hot-update.js [version] --upload

# 全量发布
node scripts/publish-full.js

# 测试
npm run test
```
