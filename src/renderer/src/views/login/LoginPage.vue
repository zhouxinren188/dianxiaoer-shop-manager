<template>
  <div class="login-page">
    <!-- 顶部拖拽区域 + 窗口控制按钮（按钮必须在 drag 区域内部，no-drag 才生效） -->
    <div class="drag-region-top">
      <div class="win-controls">
        <button class="ctrl-btn" @click="handleMinimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="ctrl-btn close-btn" @click="handleClose">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
        </button>
      </div>
    </div>
    <div class="login-body">
      <div class="login-left">
        <div class="brand-area">
          <img src="/logo-large.png" alt="logo" class="brand-logo-img" />
          <h1 class="brand-title">店小二网店管家</h1>
          <p class="brand-desc">高效、智能的多店铺综合管理平台</p>
          <div class="brand-features">
            <div class="feature-item">
              <el-icon :size="16"><TrendCharts /></el-icon>
              <span>销售数据实时分析</span>
            </div>
            <div class="feature-item">
              <el-icon :size="16"><Box /></el-icon>
              <span>多仓库库存管理</span>
            </div>
            <div class="feature-item">
              <el-icon :size="16"><Connection /></el-icon>
              <span>供应链一站式协同</span>
            </div>
          </div>
        </div>
      </div>
      <div class="login-right">
        <div class="login-form-wrapper">
          <!-- 登录表单 -->
          <template v-if="!isRegister">
            <h2 class="login-title">欢迎登录</h2>
            <p class="login-subtitle">请输入您的账号和密码</p>
            <el-form
              ref="loginFormRef"
              :model="loginForm"
              :rules="loginRules"
              @keyup.enter="handleLogin"
            >
              <el-form-item prop="username">
                <el-input
                  v-model="loginForm.username"
                  placeholder="请输入账号"
                  :prefix-icon="User"
                  clearable
                />
              </el-form-item>
              <el-form-item prop="password">
                <el-input
                  v-model="loginForm.password"
                  type="password"
                  placeholder="请输入密码"
                  :prefix-icon="Lock"
                  show-password
                  clearable
                />
              </el-form-item>
              <div class="login-options">
                <el-checkbox v-model="rememberMe" size="small">记住密码</el-checkbox>
              </div>
              <el-form-item>
                <el-button
                  type="primary"
                  class="login-btn"
                  :loading="loading"
                  @click="handleLogin"
                >
                  {{ loading ? '登录中...' : '登 录' }}
                </el-button>
              </el-form-item>
            </el-form>
            <div class="switch-tip">
              还没有账号？<span class="switch-link" @click="isRegister = true">立即注册</span>
            </div>
          </template>

          <!-- 注册表单 -->
          <template v-else>
            <h2 class="login-title">注册账号</h2>
            <p class="login-subtitle">创建一个新的子账号</p>
            <el-form
              ref="registerFormRef"
              :model="registerForm"
              :rules="registerRules"
              @keyup.enter="handleRegister"
            >
              <el-form-item prop="username">
                <el-input
                  v-model="registerForm.username"
                  placeholder="请输入账号（2-20个字符）"
                  :prefix-icon="User"
                  clearable
                />
              </el-form-item>
              <el-form-item prop="password">
                <el-input
                  v-model="registerForm.password"
                  type="password"
                  placeholder="请输入密码（6-20个字符）"
                  :prefix-icon="Lock"
                  show-password
                  clearable
                />
              </el-form-item>
              <el-form-item prop="phone">
                <el-input
                  v-model="registerForm.phone"
                  placeholder="请输入手机号"
                  :prefix-icon="Phone"
                  clearable
                />
              </el-form-item>
              <el-form-item>
                <el-button
                  type="primary"
                  class="login-btn"
                  :loading="loading"
                  @click="handleRegister"
                >
                  {{ loading ? '注册中...' : '注 册' }}
                </el-button>
              </el-form-item>
            </el-form>
            <div class="switch-tip">
              已有账号？<span class="switch-link" @click="isRegister = false">返回登录</span>
            </div>
          </template>

          <div class="login-footer">
            <span class="footer-text">v{{ appVersion }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock, Phone, TrendCharts, Box, Connection } from '@element-plus/icons-vue'
import { checkStatus } from '@/api/subscription'

const router = useRouter()
const loginFormRef = ref(null)
const registerFormRef = ref(null)
const loading = ref(false)
const appVersion = ref('...')
const isRegister = ref(false)

const rememberMe = ref(false)

const loginForm = reactive({
  username: '',
  password: ''
})

const loginRules = {
  username: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

const registerForm = reactive({
  username: '',
  password: '',
  phone: ''
})

const registerRules = {
  username: [
    { required: true, message: '请输入账号', trigger: 'blur' },
    { min: 2, max: 20, message: '账号长度为2-20个字符', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度为6-20个字符', trigger: 'blur' }
  ],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }
  ]
}

// 窗口控制
function handleMinimize() {
  window.electronAPI?.invoke('window-minimize')
}
function handleClose() {
  window.electronAPI?.invoke('window-close')
}

// 进入登录页时确保窗口为登录尺寸
onMounted(async () => {
  window.electronAPI?.invoke('window-set-login-size')
  try {
    const ver = await window.electronAPI?.invoke('get-app-version')
    if (ver) appVersion.value = ver
  } catch {}
})

const API_BASE = 'http://150.158.54.108:3001'
// const API_BASE = 'http://localhost:3001'  // 本地开发

async function handleRegister() {
  registerFormRef.value?.validate(async (valid) => {
    if (!valid) return
    loading.value = true
    try {
      let res = null
      // 优先通过主进程代理请求
      try {
        const proxyResult = await window.electronAPI?.invoke('proxy-fetch', {
          url: `${API_BASE}/api/register`,
          method: 'POST',
          body: JSON.stringify({
            username: registerForm.username,
            password: registerForm.password,
            phone: registerForm.phone
          })
        })
        if (proxyResult) res = JSON.parse(proxyResult.data)
      } catch {
        // fallback 到直接 fetch
        const response = await fetch(`${API_BASE}/api/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: registerForm.username,
            password: registerForm.password,
            phone: registerForm.phone
          })
        })
        res = await response.json()
      }
      if (res.success) {
        ElMessage.success('注册成功，请登录')
        isRegister.value = false
        loginForm.username = registerForm.username
        loginForm.password = ''
      } else {
        ElMessage.error(res.message || '注册失败')
      }
    } catch (e) {
      ElMessage.error('注册失败：' + (e.message || '网络错误'))
    }
    loading.value = false
  })
}

async function handleLogin() {
  loginFormRef.value?.validate(async (valid) => {
    if (!valid) return
    loading.value = true

    const apiUrl = `${API_BASE}/api/login`
    const reqBody = { username: loginForm.username, password: loginForm.password }
    console.log('[Login] 开始请求:', apiUrl)

    try {
      let res = null

      // ★ 优先通过主进程代理请求（绕过 Electron file:// 协议的 CORS 限制）
      // 生产模式下页面从 file:// 加载，fetch 的 Origin 为 "null"，
      // 服务器 CORS 可能拒绝，导致 TypeError: Failed to fetch
      try {
        const proxyResult = await window.electronAPI?.invoke('proxy-fetch', {
          url: apiUrl,
          method: 'POST',
          body: JSON.stringify(reqBody)
        })
        if (proxyResult) {
          try {
            res = JSON.parse(proxyResult.data)
          } catch {
            if (proxyResult.status >= 400) {
              throw new Error(`服务器返回异常 (HTTP ${proxyResult.status})`)
            }
            throw new Error('服务器返回格式错误')
          }
          console.log('[Login] 主进程代理响应:', proxyResult.status, JSON.stringify(res).substring(0, 200))
        }
      } catch (proxyErr) {
        // 主进程代理失败（非 Electron 环境等），fallback 到直接 fetch
        console.warn('[Login] 主进程代理失败，fallback 到 fetch:', proxyErr.message)
      }

      // 主进程代理未返回结果时，使用直接 fetch
      if (!res) {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody)
        })

        const responseText = await response.text()
        try {
          res = JSON.parse(responseText)
        } catch (e) {
          if (!response.ok) {
            throw new Error(`服务器返回异常 (HTTP ${response.status})`)
          }
          throw new Error('服务器返回格式错误')
        }
        console.log('[Login] fetch 响应:', response.status, JSON.stringify(res).substring(0, 200))
      }

      // 如果响应包含业务错误信息，优先使用
      if (res && res.success === false && res.message) {
        throw new Error(res.message)
      }

      const isOldFormat = res && res.code === 0 && res.data && res.data.accessToken
      const isNewFormat = res && res.success === true && res.accessToken
      if (isOldFormat || isNewFormat) {
        const token = isOldFormat ? res.data.accessToken : res.accessToken
        const user = isOldFormat ? res.data.user : res.user
        localStorage.setItem('accessToken', token)
        localStorage.setItem('currentUser', user.username)
        localStorage.setItem('userInfo', JSON.stringify({
          userType: user.userType || '',
          role: user.role || '',
          createdAt: user.createdAt || ''
        }))
        if (rememberMe.value) {
          localStorage.setItem('rememberedUser', loginForm.username)
          localStorage.setItem('rememberedPassword', btoa(encodeURIComponent(loginForm.password)))
        } else {
          localStorage.removeItem('rememberedUser')
          localStorage.removeItem('rememberedPassword')
        }
        // 同步 auth token 到主进程（供 platform-window / cookie-heartbeat 等使用）
        try { await window.electronAPI?.invoke('set-auth-token', token) } catch {}
        try { await window.electronAPI?.invoke('window-set-main-size') } catch {}
        ElMessage.success('登录成功')

        // 检查订阅状态，过期则跳转订阅页
        let shouldRedirectToSub = false
        try {
          const subRes = await checkStatus()
          if (subRes.success && subRes.status === 'expired') {
            shouldRedirectToSub = true
          }
        } catch {
          // 订阅状态查询失败，不阻断登录流程
        }
        if (shouldRedirectToSub) {
          router.replace('/subscription')
        } else {
          router.replace('/')
        }
      } else {
        ElMessage.error(res?.message || '账号或密码错误')
      }
    } catch (e) {
      console.error('[Login] 登录异常:', e)
      let errorMsg = '登录失败'
      if (e.name === 'TypeError' && e.message.includes('fetch')) {
        errorMsg = '无法连接服务器，请检查网络或服务器状态'
      } else if (e.message.includes('Failed to fetch')) {
        errorMsg = '网络连接失败，请检查：1) 服务器是否运行 2) 防火墙设置 3) HTTPS 证书'
      } else {
        errorMsg = `${e.message || '未知错误'}`
      }
      ElMessage.error(errorMsg)
    }
    loading.value = false
  })
}

// 读取记住的账号和密码
const rememberedUser = localStorage.getItem('rememberedUser')
const rememberedPassword = localStorage.getItem('rememberedPassword')
if (rememberedUser) {
  loginForm.username = rememberedUser
  rememberMe.value = true
}
if (rememberedPassword) {
  try {
    loginForm.password = decodeURIComponent(atob(rememberedPassword))
  } catch {
    localStorage.removeItem('rememberedPassword')
  }
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f0f2f5;
  position: relative;
}

/* 顶部全局拖拽区域 */
.drag-region-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 30px;
  -webkit-app-region: drag;
  z-index: 100;
}

/* 窗口控制按钮（必须在 drag 区域内部，no-drag 才生效） */
.win-controls {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  -webkit-app-region: no-drag;
}

/* 主体 */
.login-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.login-left {
  flex: 1;
  background: linear-gradient(135deg, #001529 0%, #003a70 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  position: relative;
  overflow: hidden;
}

.login-left::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(ellipse at center, rgba(24, 144, 255, 0.15) 0%, transparent 70%);
  animation: pulse 8s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.5; }
  50% { transform: scale(1.1); opacity: 1; }
}

.brand-area {
  position: relative;
  z-index: 1;
  max-width: 220px;
}

.brand-logo-img {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  margin-bottom: 16px;
  object-fit: cover;
  box-shadow: 0 6px 16px rgba(24, 144, 255, 0.4);
}

.brand-title {
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 6px;
  letter-spacing: 1px;
}

.brand-desc {
  color: rgba(255, 255, 255, 0.65);
  font-size: 12px;
  margin-bottom: 24px;
  line-height: 1.6;
}

.brand-features {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
}

.feature-item .el-icon {
  width: 26px;
  height: 26px;
  background: rgba(24, 144, 255, 0.2);
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 右侧表单区 */
.login-right {
  width: 300px;
  display: flex;
  flex-direction: column;
  background: #fff;
  flex-shrink: 0;
  position: relative;
}

.ctrl-btn {
  width: 36px;
  height: 28px;
  border: none;
  background: transparent;
  color: #909399;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.ctrl-btn:hover {
  background: #f0f0f0;
  color: #303133;
}
.close-btn:hover {
  background: #e81123;
  color: #fff;
}

.login-form-wrapper {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  max-width: 250px;
  margin: 0 auto;
  padding: 0 16px;
}

.login-title {
  font-size: 18px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 2px;
}

.login-subtitle {
  font-size: 12px;
  color: #909399;
  margin-bottom: 20px;
}

.login-options {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
}

.login-btn {
  width: 100%;
  height: 36px;
  font-size: 14px;
  border-radius: 6px;
  letter-spacing: 4px;
}

.login-footer {
  text-align: center;
  margin-top: 16px;
}

.footer-text {
  color: #c0c4cc;
  font-size: 11px;
}

.switch-tip {
  text-align: center;
  font-size: 12px;
  color: #909399;
  margin-top: 12px;
}

.switch-link {
  color: #2b5aed;
  cursor: pointer;
}

.switch-link:hover {
  text-decoration: underline;
}

:deep(.el-input__wrapper) {
  border-radius: 6px;
}

:deep(.el-checkbox__label) {
  color: #909399;
  font-size: 12px;
}

:deep(.el-form-item) {
  margin-bottom: 14px;
}
</style>
