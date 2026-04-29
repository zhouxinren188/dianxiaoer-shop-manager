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
      <el-menu-item index="add-store" @click="handleAddStore">
        <el-icon><CirclePlus /></el-icon>
        <span>新增店铺</span>
      </el-menu-item>
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

    <!-- 打开网址弹窗：选择店铺 -->
    <el-dialog
      v-model="openUrlDialogVisible"
      title="选择店铺打开平台网址"
      width="420px"
      :append-to-body="true"
    >
      <el-select
        v-model="selectedStoreId"
        placeholder="请选择店铺"
        style="width: 100%;"
        filterable
      >
        <el-option
          v-for="store in storeList"
          :key="store.id"
          :label="`${store.name} (${platformText(store.platform)})`"
          :value="store.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="openUrlDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!selectedStoreId" @click="confirmOpenUrl">打开</el-button>
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
import { ref, computed } from 'vue'
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
  CirclePlus,
  Setting
} from '@element-plus/icons-vue'
import { fetchStores, createStore } from '@/api/store'
import PacketResultDialog from '@/views/user/components/PacketResultDialog.vue'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

function navigate(path) {
  router.push(path)
}

function platformText(platform) {
  const map = { taobao: '淘宝', tmall: '天猫', jd: '京东', pdd: '拼多多', douyin: '抖音小店' }
  return map[platform] || platform
}

// --- 新增店铺功能 ---
const addStoreLoading = ref(false)

async function handleAddStore() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }

  addStoreLoading.value = true
  try {
    const now = new Date()
    const timeStr = now.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).replace(/[\/\s:]/g, '')

    // 自动创建店铺（默认京东）
    const result = await createStore({
      name: `京东店铺${timeStr}`,
      platform: 'jd'
    })
    const newStoreId = result.id

    // 直接打开 shop.jd.com
    const openResult = await window.electronAPI.invoke('open-platform-window', {
      storeId: newStoreId,
      platform: 'jd'
    })
    if (!openResult || !openResult.success) {
      throw new Error(openResult?.message || '打开平台窗口失败')
    }

    ElMessage.success('已创建店铺并打开 shop.jd.com，请在弹出的浏览器窗口中登录')

    // 跳转到店铺管理页面
    router.push('/user/store-manage')
  } catch (err) {
    ElMessage.error('操作失败: ' + err.message)
  } finally {
    addStoreLoading.value = false
  }
}

// --- 打开网址功能 ---
const openUrlDialogVisible = ref(false)
const storeList = ref([])
const selectedStoreId = ref(null)

async function handleOpenUrl() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  openUrlDialogVisible.value = true
  selectedStoreId.value = null
  try {
    const data = await fetchStores({ pageSize: 100 })
    storeList.value = data.list || []
  } catch (err) {
    ElMessage.error('加载店铺列表失败')
  }
}

function confirmOpenUrl() {
  const store = storeList.value.find(s => s.id === selectedStoreId.value)
  if (!store) return

  window.electronAPI.invoke('open-platform-window', {
    storeId: store.id,
    platform: store.platform
  }).then(() => {
    openUrlDialogVisible.value = false
    ElMessage.success(`已打开「${store.name}」的平台网页`)
  }).catch(err => {
    ElMessage.error('打开失败: ' + err.message)
  })
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
    // 开始抓包
    try {
      await window.electronAPI.invoke('packet-capture-start')
      isCapturing.value = true
      ElMessage.success('抓包已开始')
    } catch (err) {
      ElMessage.error('启动抓包失败: ' + err.message)
    }
  } else {
    // 停止抓包
    try {
      const result = await window.electronAPI.invoke('packet-capture-stop')
      isCapturing.value = false
      packetData.value = result.data || []
      packetDialogVisible.value = true
    } catch (err) {
      ElMessage.error('停止抓包失败: ' + err.message)
    }
  }
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
</style>
