<template>
  <div class="sidebar-container">
    <div class="sidebar-logo">
      <img src="/logo.png" alt="logo" class="logo-img" />
      <span class="logo-text">店小二网店管家</span>
    </div>
    <el-menu
      :default-active="activeMenu"
      background-color="#001529"
      text-color="rgba(255,255,255,0.65)"
      active-text-color="#ffffff"
      :unique-opened="true"
      class="sidebar-menu"
      @select="onMenuSelect"
    >
      <!-- 首页 -->
      <el-menu-item index="/home">
        <el-icon><HomeFilled /></el-icon>
        <span>首页</span>
      </el-menu-item>

      <!-- 销售管理 分组 -->
      <div class="menu-group-title">销售管理</div>
      <el-menu-item index="/sales/orders">
        <el-icon><List /></el-icon>
        <span>订单列表</span>
      </el-menu-item>
      <el-sub-menu index="aftersale">
        <template #title>
          <el-icon><Service /></el-icon>
          <span>售后管理</span>
        </template>
        <el-menu-item index="/aftersale/returns">
          <el-icon><RefreshLeft /></el-icon>
          <span>退换货管理</span>
        </el-menu-item>
      </el-sub-menu>

      <!-- 采购管理 分组 -->
      <div class="menu-group-title">采购管理</div>
      <el-menu-item index="/purchase/orders">
        <el-icon><Document /></el-icon>
        <span>采购订单</span>
      </el-menu-item>

      <!-- 仓库管理 分组 -->
      <div class="menu-group-title">仓库管理</div>
      <el-menu-item index="/warehouse/goods">
        <el-icon><Goods /></el-icon>
        <span>商品管理</span>
      </el-menu-item>
      <el-menu-item index="/warehouse/setting">
        <el-icon><Setting /></el-icon>
        <span>设置仓库</span>
      </el-menu-item>

      <!-- 供货商管理 分组 -->
      <div class="menu-group-title">供货商管理</div>
      <el-menu-item index="/supplier/store-shipment">
        <el-icon><Van /></el-icon>
        <span>供店发货</span>
      </el-menu-item>

      <!-- 报表 分组 -->
      <div class="menu-group-title">报表</div>
      <el-menu-item index="/supplier/store-sales-stats">
        <el-icon><TrendCharts /></el-icon>
        <span>店铺销售统计</span>
      </el-menu-item>

      <!-- 任务中心 分组 -->
      <div class="menu-group-title">任务中心</div>
      <el-menu-item index="/tasks/todo">
        <el-icon><Ticket /></el-icon>
        <span>代办任务</span>
      </el-menu-item>

      <!-- 用户中心 分组 -->
      <div class="menu-group-title">用户中心</div>
      <el-menu-item index="/user/manage">
        <el-icon><UserFilled /></el-icon>
        <span>用户管理</span>
      </el-menu-item>
      <el-menu-item index="/user/store-manage">
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

    <!-- 抓包风险提示弹窗 -->
    <el-dialog
      v-model="riskDialogVisible"
      title="风险提示"
      width="480px"
      :show-close="false"
      :close-on-click-modal="false"
      :append-to-body="true"
    >
      <div style="color: #f56c6c; font-size: 14px; line-height: 1.8;">
        <p style="font-weight: bold; margin-bottom: 8px;">抓包工具使用须知</p>
        <p>1. 抓包功能仅用于调试分析，请勿用于非法用途。</p>
        <p>2. 京麦等电商平台风控严格，高频或异常请求可能导致账号受限。</p>
        <p>3. 抓取的接口数据请谨慎使用，避免触发平台安全机制。</p>
        <p>4. 单次抓包最长 5 分钟，超时将自动停止。</p>
      </div>
      <template #footer>
        <el-button @click="riskDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmStartCapture">我已了解风险，开始抓包</el-button>
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
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
  TrendCharts
} from '@element-plus/icons-vue'
import PacketResultDialog from '@/views/user/components/PacketResultDialog.vue'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

function onMenuSelect(index) {
  if (index === 'open-url' || index === 'packet-capture') return
  if (route.path === index) return

  router.push(index).then(failure => {
    if (failure) {
      console.warn('[Navigate] 导航未完成:', failure.type, failure.message)
    }
  }).catch(err => {
    console.error('[Navigate] 路由跳转失败:', err)
  })
}

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
const riskDialogVisible = ref(false)

async function handlePacketCapture() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }

  if (!isCapturing.value) {
    riskDialogVisible.value = true
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

async function confirmStartCapture() {
  riskDialogVisible.value = false
  try {
    await window.electronAPI.invoke('packet-capture-start')
    isCapturing.value = true
    ElMessage.success('抓包已开始，最长持续 5 分钟')
  } catch (err) {
    ElMessage.error('启动抓包失败: ' + err.message)
  }
}

// 监听主进程超时自动停止事件
let unsubPacketCapture = null
onMounted(() => {
  if (window.electronAPI?.onUpdate) {
    unsubPacketCapture = window.electronAPI.onUpdate('packet-capture-auto-stopped', () => {
      isCapturing.value = false
      ElMessage.warning('抓包已超时自动停止')
    })
  }
})

onUnmounted(() => {
  if (unsubPacketCapture) { unsubPacketCapture(); unsubPacketCapture = null }
})
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

.logo-img {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
  object-fit: cover;
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
</style>
