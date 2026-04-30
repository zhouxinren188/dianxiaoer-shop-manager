<template>
  <div class="sidebar-container">
    <div class="sidebar-logo">
      <div class="logo-icon">
        <el-icon :size="20" color="#fff"><Shop /></el-icon>
      </div>
      <span class="logo-text">店小二网店管家</span>
    </div>
    <el-menu
      :default-active="activeMenu"
      background-color="#001529"
      text-color="rgba(255,255,255,0.65)"
      active-text-color="#ffffff"
      :unique-opened="true"
      class="sidebar-menu"
    >
      <!-- 首页 -->
      <el-menu-item index="/home" @click="navigate('/home')">
        <el-icon><HomeFilled /></el-icon>
        <span>首页</span>
      </el-menu-item>

      <!-- 销售管理 分组 -->
      <div class="menu-group-title">销售管理</div>
      <el-menu-item index="/sales/orders" @click="navigate('/sales/orders')">
        <el-icon><List /></el-icon>
        <span>订单列表</span>
      </el-menu-item>
      <el-sub-menu index="aftersale">
        <template #title>
          <el-icon><Service /></el-icon>
          <span>售后管理</span>
        </template>
        <el-menu-item index="/aftersale/returns" @click="navigate('/aftersale/returns')">
          <el-icon><RefreshLeft /></el-icon>
          <span>退换货管理</span>
        </el-menu-item>
      </el-sub-menu>

      <!-- 采购管理 分组 -->
      <div class="menu-group-title">采购管理</div>
      <el-menu-item index="/purchase/orders" @click="navigate('/purchase/orders')">
        <el-icon><Document /></el-icon>
        <span>采购订单</span>
      </el-menu-item>

      <!-- 仓库管理 分组 -->
      <div class="menu-group-title">仓库管理</div>
      <el-menu-item index="/warehouse/goods" @click="navigate('/warehouse/goods')">
        <el-icon><Goods /></el-icon>
        <span>商品管理</span>
      </el-menu-item>
      <el-menu-item index="/warehouse/setting" @click="navigate('/warehouse/setting')">
        <el-icon><Setting /></el-icon>
        <span>设置仓库</span>
      </el-menu-item>

      <!-- 供货商管理 分组 -->
      <div class="menu-group-title">供货商管理</div>
      <el-menu-item index="/supplier/store-shipment" @click="navigate('/supplier/store-shipment')">
        <el-icon><Van /></el-icon>
        <span>供店发货</span>
      </el-menu-item>

      <!-- 报表 分组 -->
      <div class="menu-group-title">报表</div>
      <el-menu-item index="/supplier/store-sales-stats" @click="navigate('/supplier/store-sales-stats')">
        <el-icon><TrendCharts /></el-icon>
        <span>店铺销售统计</span>
      </el-menu-item>

      <!-- 任务中心 分组 -->
      <div class="menu-group-title">任务中心</div>
      <el-menu-item index="/tasks/todo" @click="navigate('/tasks/todo')">
        <el-icon><Ticket /></el-icon>
        <span>代办任务</span>
      </el-menu-item>

      <!-- 用户中心 分组 -->
      <div class="menu-group-title">用户中心</div>
      <el-menu-item index="/user/manage" @click="navigate('/user/manage')">
        <el-icon><UserFilled /></el-icon>
        <span>用户管理</span>
      </el-menu-item>
      <el-menu-item index="/user/store-manage" @click="navigate('/user/store-manage')">
        <el-icon><OfficeBuilding /></el-icon>
        <span>店铺管理</span>
      </el-menu-item>

      <!-- 工具 分组 -->
      <div class="menu-group-title">工具</div>
      <el-menu-item index="open-url" @click="handleOpenUrl">
        <el-icon><Link /></el-icon>
        <span>打开网址</span>
      </el-menu-item>
      <el-menu-item index="packet-capture" @click="handlePacketCapture" :class="{ 'capturing': isCapturing }">
        <el-icon><Monitor /></el-icon>
        <span>{{ isCapturing ? '停止抓包' : '抓包工具' }}</span>
        <span v-if="isCapturing" class="capture-indicator"></span>
      </el-menu-item>
    </el-menu>

    <!-- 底部用户信息 + 退出登录 -->
    <div class="sidebar-footer">
      <div class="user-info">
        <el-icon :size="16"><User /></el-icon>
        <span class="user-name">{{ currentUserName }}</span>
      </div>
      <div class="logout-btn" @click="handleLogout">
        <el-icon :size="14"><SwitchButton /></el-icon>
        <span>退出登录</span>
      </div>
    </div>

    <!-- 打开网址弹窗 -->
    <el-dialog
      v-model="openUrlDialogVisible"
      title="打开网址"
      width="460px"
      :append-to-body="true"
    >
      <el-input
        v-model="inputUrl"
        placeholder="请输入网址，如 https://www.example.com"
        clearable
        @keyup.enter="confirmOpenUrl"
      >
        <template #prepend>URL</template>
      </el-input>
      <template #footer>
        <el-button @click="openUrlDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!inputUrl.trim()" @click="confirmOpenUrl">打开</el-button>
      </template>
    </el-dialog>

    <!-- 抓包结果弹窗 -->
    <PacketResultDialog
      v-model:visible="packetDialogVisible"
      :data="packetData"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Shop,
  HomeFilled,
  List,
  Service,
  RefreshLeft,
  Document,
  Goods,
  Van,
  Ticket,
  UserFilled,
  OfficeBuilding,
  Link,
  Monitor,
  Setting,
  TrendCharts,
  User,
  SwitchButton
} from '@element-plus/icons-vue'
import PacketResultDialog from '@/views/user/components/PacketResultDialog.vue'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

function navigate(path) {
  router.push(path)
}

// 挂载时同步 auth token 到主进程（覆盖已登录但未同步的场景）
onMounted(() => {
  const token = localStorage.getItem('accessToken')
  if (token && window.electronAPI) {
    window.electronAPI.invoke('set-auth-token', token).catch(() => {})
  }
})

// --- 打开网址功能 ---
const openUrlDialogVisible = ref(false)
const inputUrl = ref('')

async function handleOpenUrl() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  inputUrl.value = ''
  openUrlDialogVisible.value = true
}

async function confirmOpenUrl() {
  const url = inputUrl.value.trim()
  if (!url) return

  let finalUrl = url
  if (!/^https?:\/\//i.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl
  }

  try {
    await window.electronAPI.invoke('open-external-url', { url: finalUrl })
    openUrlDialogVisible.value = false
  } catch (err) {
    ElMessage.error('打开网址失败: ' + err.message)
  }
}

// --- 抓包工具功能 ---
const isCapturing = ref(false)
const packetDialogVisible = ref(false)
const packetData = ref([])

async function handlePacketCapture() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }

  if (!isCapturing.value) {
    try {
      await window.electronAPI.invoke('packet-capture-start')
      isCapturing.value = true
      ElMessage.success('抓包已开始')
    } catch (err) {
      ElMessage.error('启动抓包失败: ' + err.message)
    }
  } else {
    try {
      const result = await window.electronAPI.invoke('packet-capture-stop')
      isCapturing.value = false
      packetData.value = result.data || []
      if (packetData.value.length > 0) {
        packetDialogVisible.value = true
      } else {
        ElMessage.info('未捕获到任何请求')
      }
    } catch (err) {
      ElMessage.error('停止抓包失败: ' + err.message)
    }
  }
}

// --- 当前用户 + 退出登录 ---
const currentUserName = computed(() => {
  try {
    const info = JSON.parse(localStorage.getItem('userInfo') || '{}')
    return info.realName || localStorage.getItem('currentUser') || '未登录'
  } catch {
    return localStorage.getItem('currentUser') || '未登录'
  }
})

function handleLogout() {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('currentUser')
  localStorage.removeItem('userId')
  localStorage.removeItem('userInfo')
  window.electronAPI?.invoke('set-auth-token', '')
  window.electronAPI?.invoke('window-set-login-size').then(() => {
    router.replace('/login')
  }).catch(() => {
    router.replace('/login')
  })
}
</script>

<style scoped>
.sidebar-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: #001529;
}

.sidebar-logo {
  height: 64px;
  display: flex;
  align-items: center;
  padding: 0 20px;
  gap: 12px;
}

.logo-icon {
  width: 32px;
  height: 32px;
  background: #2b5aed;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.logo-text {
  color: #fff;
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  letter-spacing: 1px;
}

.sidebar-menu {
  border-right: none;
  flex: 1;
  overflow-y: auto;
  padding: 4px 12px;
}

.sidebar-menu::-webkit-scrollbar {
  width: 4px;
}

.sidebar-menu::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

.menu-group-title {
  padding: 16px 16px 8px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.35);
  text-transform: uppercase;
  letter-spacing: 2px;
}

:deep(.el-menu-item) {
  border-radius: 6px;
  margin-bottom: 2px;
  height: 44px;
  line-height: 44px;
}

:deep(.el-menu-item:hover) {
  background-color: rgba(255, 255, 255, 0.08) !important;
}

:deep(.el-menu-item.is-active) {
  background-color: #2b5aed !important;
  color: #fff !important;
}

:deep(.el-sub-menu .el-sub-menu__title) {
  border-radius: 6px;
  height: 44px;
  line-height: 44px;
}

:deep(.el-sub-menu .el-sub-menu__title:hover) {
  background-color: rgba(255, 255, 255, 0.08) !important;
}

:deep(.el-sub-menu .el-menu-item) {
  padding-left: 52px !important;
  min-width: auto;
}

/* 抓包中状态样式 */
:deep(.el-menu-item.capturing) {
  background-color: rgba(245, 108, 108, 0.15) !important;
  color: #f56c6c !important;
}

.capture-indicator {
  display: inline-block;
  width: 8px;
  height: 8px;
  background-color: #f56c6c;
  border-radius: 50%;
  margin-left: 8px;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

/* 底部用户信息 + 退出登录 */
.sidebar-footer {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding: 12px 16px;
  flex-shrink: 0;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgba(255, 255, 255, 0.65);
  font-size: 13px;
  margin-bottom: 8px;
  padding: 0 4px;
}

.user-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.logout-btn:hover {
  background: rgba(245, 108, 108, 0.15);
  color: #f56c6c;
}
</style>
