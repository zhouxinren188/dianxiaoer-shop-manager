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
| 任何客户端变更（不论仅 renderer 还是仅 main） | **统一热更新（main+renderer 同步）** | `node scripts/build-hot-update.js --main --upload` | ~1.5MB |
| Electron 版本升级/重大架构变更 | 全量发布 | `node scripts/publish-full.js` | ~112MB |

> **重要：热更新必须始终使用 `--main --upload`，确保 main 和 renderer 始终同步。**
> 禁止使用 `--upload`（仅 renderer）或 `--main-only --upload`（仅 main），因为：
> - 服务器只保留最新的一个热更新包，旧包会被覆盖
> - 如果连续发布 renderer-only 和 main-only，用户只会拿到最新的那个，导致 main/renderer 版本不同步
> - `--main --upload` 多出的几百 KB 可忽略，但彻底杜绝不同步问题

> **更新优先级规则v2（2026-05-16）**：服务器 check 接口按以下顺序判断：
> 1. 基础版本落后（appVersion < fullVersion）→ 优先返回全量更新，确保旧 app.asar 的 bootstrap 等底层问题被修复
> 2. 基础版本已达标（appVersion >= fullVersion）→ 检查热更新，返回最新补丁
> - 客户端传参：`version`=当前运行版本（含热更新），`appVersion`=基础版本（app.asar 的 package.json 版本）
> - 原因：热更新不修改 app.asar 内的 bootstrap，跳过全量更新会导致功能异常
> - 发布全量更新时，版本号应 >= 当前热更新版本号，确保全量包包含所有最新修复

### 热更新发布步骤
1. 确认 `package.json` 版本号已更新
2. 提交代码到 git
3. 执行对应的热更新命令
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

### 热更新参数说明
- `--upload`：自动上传到服务器（不加则只生成本地 ZIP）
- `--main`：包含主进程字节码（同时包含 renderer）
- `--main-only`：仅包含主进程字节码（不含 renderer）
- `--base=x.y.z`：指定 baseVersion（热更新仅对匹配基础版本的客户端生效）。已统一 `--main --upload` 后意义弱化，但作为安全兜底防止 .jsc 与过旧 V8 不兼容

---

## 构建流程

### 完整构建流程（全量发布自动执行）
1. `electron-vite build` → 编译 src/main/ 为 out/main/index.js（~700KB 单文件），src/preload/ 为 out/preload/index.js，src/renderer/ 为前端资源
2. `node scripts/compile-bytecode.js` → bytenode 编译 index.js → index.jsc 字节码，**index.js 替换为引导加载器**（支持主进程热更新检测/校验/降级），preload 同样编译为 .jsc + loader stub
3. `electron-builder --win` → 打包 NSIS 安装程序，包含 out/\*\*/* 和 resources/\*\*/*

### 主进程热更新 ZIP 结构（--main 模式）
```
main/index.jsc              主进程字节码
main/index.js               bytenode loader stub（3行）
main/purchase-preload.js    采购窗口 preload
preload/index.jsc           预加载字节码
preload/index.js            bytenode loader stub（3行）
renderer/                   前端资源（--main-only 时不包含）
version.json                版本元数据
```

### version.json 字段
```json
{
  "version": "1.4.2",
  "baseVersion": "1.4.2",
  "buildTime": "2026-05-13T...",
  "mainUpdate": true,
  "electronVersion": "41.3.0",
  "mainSha256": "...",
  "preloadSha256": "..."
}
```

---

## 主进程热更新安全与降级

### 三层安全校验
1. **ZIP 整体 SHA256**（下载后校验）
2. **mainSha256 / preloadSha256**（引导加载器加载前校验）
3. **electronVersion 兼容性检查**（.jsc 与 V8 版本绑定，不匹配则降级）

### 降级机制
- 引导加载器在加载热更新 .jsc 前校验 electronVersion / baseVersion / SHA256
- 校验失败：标记 `mainUpdate=false`（不删除文件，保留排查），加载内置 index.jsc
- bytenode 加载不兼容 .jsc 抛异常时：try-catch 捕获，降级到内置版本
- 降级日志写入 `userData/hot-update-bootstrap.log`

---

## 代码规范

### 禁止使用 __dirname 引用资源路径
源码中所有 `__dirname` 引用已替换为稳定路径，**新代码禁止使用 __dirname** 引用 resources/preload/renderer 路径：

| 用途 | 正确写法 |
|------|---------|
| 引用 resources 下文件 | `path.join(process.resourcesPath, 'app.asar', 'resources', 'xxx')` |
| 引用 preload 脚本 | `getHotUpdatePreloadPath() \|\| path.join(process.resourcesPath, 'app.asar', 'out', 'preload', 'index.js')` |
| 引用 renderer 页面 | `getHotUpdateRendererPath()` |
| 引用 purchase-preload | `resolveAppPath('out/main/purchase-preload.js')` |
| 引用 platform-login-preload | `path.join(process.resourcesPath, 'app.asar', 'resources', 'platform-login-preload.js')` |

原因：主进程热更新从 `userData/hot-update/main/` 加载时，`__dirname` 不再指向 `app.asar/out/main/`。

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

# 热更新发布（统一使用 --main --upload，确保 main+renderer 同步）
node scripts/build-hot-update.js --main --upload

# 全量发布
node scripts/publish-full.js

# 测试
npm run test
```
