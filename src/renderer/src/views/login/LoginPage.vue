<template>
  <div class="login-page">
    <div class="login-left">
      <div class="brand-area">
        <div class="brand-icon">
          <el-icon :size="28" color="#fff"><Shop /></el-icon>
        </div>
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
              <el-checkbox v-model="loginForm.remember" size="small">记住密码</el-checkbox>
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
          <p class="login-subtitle">请填写以下信息完成注册</p>
          <el-form
            ref="registerFormRef"
            :model="registerForm"
            :rules="registerRules"
            @keyup.enter="handleRegister"
          >
            <el-form-item prop="phone">
              <el-input
                v-model="registerForm.phone"
                placeholder="请输入手机号"
                :prefix-icon="Phone"
                clearable
                maxlength="11"
              />
            </el-form-item>
            <el-form-item prop="username">
              <el-input
                v-model="registerForm.username"
                placeholder="请输入账号"
                :prefix-icon="User"
                clearable
              />
            </el-form-item>
            <el-form-item prop="password">
              <el-input
                v-model="registerForm.password"
                type="password"
                placeholder="请输入密码"
                :prefix-icon="Lock"
                show-password
                clearable
              />
            </el-form-item>
            <el-form-item prop="confirmPassword">
              <el-input
                v-model="registerForm.confirmPassword"
                type="password"
                placeholder="请再次输入密码"
                :prefix-icon="Lock"
                show-password
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
          <span class="footer-text">v1.0.0</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Shop, User, Lock, Phone, TrendCharts, Box, Connection } from '@element-plus/icons-vue'

const router = useRouter()
const loginFormRef = ref(null)
const registerFormRef = ref(null)
const loading = ref(false)
const isRegister = ref(false)

const loginForm = reactive({
  username: '',
  password: '',
  remember: false
})

const registerForm = reactive({
  username: '',
  phone: '',
  password: '',
  confirmPassword: ''
})

const loginRules = {
  username: [{ required: true, message: '请输入账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

const registerRules = {
  username: [
    { required: true, message: '请输入账号', trigger: 'blur' },
    { min: 3, max: 20, message: '账号长度为 3-20 个字符', trigger: 'blur' }
  ],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度为 6-20 个字符', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (value !== registerForm.password) {
          callback(new Error('两次输入的密码不一致'))
        } else {
          callback()
        }
      },
      trigger: 'blur'
    }
  ]
}

function getUsers() {
  try {
    return JSON.parse(localStorage.getItem('users') || '{}')
  } catch {
    return {}
  }
}

function handleLogin() {
  loginFormRef.value?.validate((valid) => {
    if (!valid) return
    loading.value = true
    setTimeout(() => {
      const users = getUsers()
      const { username, password } = loginForm
      if (users[username] && users[username].password === password) {
        localStorage.setItem('token', 'logged-in')
        localStorage.setItem('currentUser', username)
        if (loginForm.remember) {
          localStorage.setItem('rememberedUser', username)
        } else {
          localStorage.removeItem('rememberedUser')
        }
        ElMessage.success('登录成功')
        router.replace('/')
      } else {
        ElMessage.error('账号或密码错误')
      }
      loading.value = false
    }, 800)
  })
}

function handleRegister() {
  registerFormRef.value?.validate((valid) => {
    if (!valid) return
    loading.value = true
    setTimeout(() => {
      const users = getUsers()
      if (users[registerForm.username]) {
        ElMessage.error('该账号已存在')
        loading.value = false
        return
      }
      users[registerForm.username] = { password: registerForm.password, phone: registerForm.phone }
      localStorage.setItem('users', JSON.stringify(users))
      ElMessage.success('注册成功，请登录')
      isRegister.value = false
      loginForm.username = registerForm.username
      registerForm.username = ''
      registerForm.phone = ''
      registerForm.password = ''
      registerForm.confirmPassword = ''
      loading.value = false
    }, 800)
  })
}

// 初始化默认管理员账号
const users = getUsers()
if (!users['admin']) {
  users['admin'] = { password: 'admin', phone: '' }
  localStorage.setItem('users', JSON.stringify(users))
}

const rememberedUser = localStorage.getItem('rememberedUser')
if (rememberedUser) {
  loginForm.username = rememberedUser
  loginForm.remember = true
}
</script>

<style scoped>
.login-page {
  height: 100vh;
  display: flex;
  background: #f0f2f5;
}

.login-left {
  flex: 1;
  background: linear-gradient(135deg, #001529 0%, #003a70 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
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
  max-width: 320px;
}

.brand-icon {
  width: 48px;
  height: 48px;
  background: #1890ff;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  box-shadow: 0 6px 16px rgba(24, 144, 255, 0.4);
}

.brand-title {
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  letter-spacing: 1px;
}

.brand-desc {
  color: rgba(255, 255, 255, 0.65);
  font-size: 13px;
  margin-bottom: 36px;
  line-height: 1.6;
}

.brand-features {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
}

.feature-item .el-icon {
  width: 30px;
  height: 30px;
  background: rgba(24, 144, 255, 0.2);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.login-right {
  width: 380px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  flex-shrink: 0;
}

.login-form-wrapper {
  width: 100%;
  max-width: 300px;
  padding: 0 24px;
}

.login-title {
  font-size: 20px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 4px;
}

.login-subtitle {
  font-size: 13px;
  color: #909399;
  margin-bottom: 28px;
}

.login-options {
  display: flex;
  align-items: center;
  margin-bottom: 20px;
}

.login-btn {
  width: 100%;
  height: 38px;
  font-size: 14px;
  border-radius: 6px;
  letter-spacing: 4px;
}

.login-footer {
  text-align: center;
  margin-top: 24px;
}

.footer-text {
  color: #c0c4cc;
  font-size: 12px;
}

.switch-tip {
  text-align: center;
  font-size: 13px;
  color: #909399;
  margin-top: 16px;
}

.switch-link {
  color: #1890ff;
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
  font-size: 13px;
}
</style>
