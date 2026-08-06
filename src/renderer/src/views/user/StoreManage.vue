<template>
  <div class="store-manage-page">
    <div class="page-header">
      <h2 class="page-title">店铺管理</h2>
      <p class="page-desc">管理名下所有网店的基本信息与经营状态</p>
    </div>

    <div class="search-card">
      <el-form :model="searchForm" inline>
        <el-form-item label="店铺名称">
          <el-input v-model="searchForm.name" placeholder="请输入店铺名称" clearable />
        </el-form-item>
        <el-form-item label="标签">
          <el-select v-model="searchForm.tag" placeholder="全部标签" clearable filterable style="width: 160px">
            <el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" />
          </el-select>
        </el-form-item>
        <el-form-item label="经营状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable style="width: 120px">
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item label="在线状态">
          <el-select v-model="searchForm.online" placeholder="全部" clearable style="width: 120px">
            <el-option label="在线" :value="1" />
            <el-option label="离线" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="list-header">
      <span class="list-title">店铺列表 <span class="list-count">共 {{ pageInfo.total }} 家</span></span>
      <div class="list-actions">
        <el-button type="danger" @click="handleSubscription">
          <el-icon><Wallet /></el-icon>
          店铺充值
        </el-button>
        <el-button type="primary" @click="handleAdd">
          <el-icon><Plus /></el-icon>
          新增店铺
        </el-button>
      </div>
    </div>

    <div class="store-list" v-loading="loading">
      <div v-if="tableData.length === 0 && !loading" class="empty-state">
        <el-empty description="暂无店铺，点击上方按钮新增" />
      </div>
      <div
        v-for="row in tableData"
        :key="row.id"
        class="store-card"
        :class="{ 'is-disabled': row.status !== 'enabled' }"
      >
        <div class="card-top">
          <div class="card-title-row">
            <div class="card-name-wrap">
              <span class="online-dot" :class="row.online ? 'online' : 'offline'"></span>
              <span class="card-name">{{ row.name }}</span>
              <el-tag
                v-if="row.status !== 'enabled'"
                size="small"
                type="info"
                effect="dark"
                class="status-tag"
              >已停用</el-tag>
            </div>
           <el-tooltip
              :content="isExpired(row.subscription_end) && row.status !== 'enabled' ? '店铺订阅已过期，续费后才能启用' : ''"
              :disabled="!isExpired(row.subscription_end) || row.status === 'enabled'"
              placement="top"
            >
              <el-switch
                :model-value="row.status === 'enabled'"
                @change="(val) => handleToggleStatus(row, val)"
                :disabled="isExpired(row.subscription_end) && row.status !== 'enabled'"
                inline-prompt
                active-text="启用"
                inactive-text="停用"
              />
            </el-tooltip>
          </div>
        </div>

        <div class="card-info">
          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">店铺类型</span>
              <span class="info-value">{{ storeTypeLabel(row.store_type) }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">登录账号</span>
              <span class="info-value">{{ row.account || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">商家ID</span>
              <span class="info-value">{{ row.merchant_id || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">店铺ID</span>
              <span class="info-value">{{ row.shop_id || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">到期时间</span>
              <span class="info-value expiry-date" :class="{ 'expired': isExpired(row.subscription_end) }">{{ formatDate(row.subscription_end) }}</span>
            </div>
          </div>
          <div class="info-row" v-if="row.tags && row.tags.length">
            <span class="info-label">标签</span>
            <span class="info-value tags-value">
              <el-tag
                v-for="tag in row.tags"
                :key="tag"
                size="small"
                type="info"
              >{{ tag }}</el-tag>
            </span>
          </div>
        </div>

        <div class="card-actions">
          <el-button size="small" type="primary" @click="handleOpenBackend(row)">
            <el-icon><Monitor /></el-icon>
            店铺后台
          </el-button>
          <el-button size="small" type="danger" @click="handleLogin(row)">
            <el-icon><Connection /></el-icon>
            重新登录
          </el-button>
          <el-button size="small" class="action-edit" @click="handleEdit(row)">
            <el-icon><Edit /></el-icon>
            编辑
          </el-button>
          <el-button size="small" type="danger" plain @click="handleDelete(row)">
            <el-icon><Delete /></el-icon>
            删除
          </el-button>
        </div>
      </div>
    </div>

    <div class="pagination-wrap" v-if="pageInfo.total > 0">
      <el-pagination
        v-model:current-page="pageInfo.page"
        v-model:page-size="pageInfo.pageSize"
        :total="pageInfo.total"
        layout="total, sizes, prev, pager, next, jumper"
        :page-sizes="[10, 20, 50]"
        @size-change="handleSizeChange"
        @current-change="handlePageChange"
      />
    </div>

    <!-- 登录确认提示条 -->
    <el-alert
      v-if="loginPending.storeId"
      :title="`正在登录「${loginPending.storeName}」，请在弹出的浏览器窗口中完成登录`"
      type="info"
      show-icon
      :closable="false"
      class="login-alert"
    >
      <el-button type="primary" size="small" @click="handleConfirmLogin">确认已登录</el-button>
      <el-button size="small" @click="handleCancelLogin">取消</el-button>
    </el-alert>

    <!-- 新增/编辑弹窗 -->
    <StoreEditDialog
      v-model:visible="editDialogVisible"
      :store-data="editStoreData"
      :tag-options="tagOptions"
      @saved="onStoreSaved"
    />

        <!-- 充值订阅弹窗 -->
    <SubscriptionDialog
      v-model:visible="subDialogVisible"
      @success="onSubSuccess"
    />

    <!-- 店铺类型选择弹窗 -->
    <el-dialog
      v-model="typeSelectVisible"
      title="选择店铺类型"
      width="560px"
      :close-on-click-modal="false"
      class="type-select-dialog"
    >
      <div class="type-cards">
        <div
          v-for="t in storeTypeOptions"
          :key="t.value"
          class="type-card"
          @click="confirmAddStore(t.value)"
        >
          <div class="type-card-icon" :style="{ background: t.color }">
            <el-icon :size="28"><component :is="t.icon" /></el-icon>
          </div>
          <div class="type-card-info">
            <div class="type-card-name">{{ t.label }}</div>
            <div class="type-card-desc">{{ t.desc }}</div>
          </div>
          <el-icon class="type-card-arrow"><ArrowRight /></el-icon>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted, onUnmounted } from 'vue'
import { Search, Plus, Connection, Edit, Delete, Monitor, Wallet, ArrowRight, Shop, Goods, Van } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchStores, createStore, deleteStore, toggleStoreStatus, fetchStoreTags } from '@/api/store'
import StoreEditDialog from './components/StoreEditDialog.vue'
import SubscriptionDialog from './components/SubscriptionDialog.vue'

const STORE_TYPE_MAP = {
  pop: 'POP店铺',
  supplier: '供应商店铺',
  consignment: '代销店铺'
}

// 店铺类型选择卡片
const storeTypeOptions = [
  { value: 'pop', label: 'POP店铺', desc: '包含旗舰店、专营店、专卖店、企业店、个人小店', icon: Shop, color: '#409eff' },
  { value: 'consignment', label: '代销店铺', desc: '代销模式，由供应商发货', icon: Goods, color: '#e6a23c' },
  { value: 'supplier', label: '供货店铺', desc: '供货模式，为代销商提供货源', icon: Van, color: '#67c23a' }
]

// 类型选择弹窗
const typeSelectVisible = ref(false)

function storeTypeLabel(type) {
  return STORE_TYPE_MAP[type] || '-'
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 判断是否过期
function isExpired(dateStr) {
  if (!dateStr) return false
  return new Date(dateStr) < new Date()
}

const searchForm = reactive({
  name: '',
  tag: '',
  status: '',
  online: ''
})

const allTagOptions = ref([])
const tagOptions = computed(() => allTagOptions.value)

const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 0
})

const tableData = ref([])
const loading = ref(false)

// 编辑弹窗
const editDialogVisible = ref(false)
const editStoreData = ref(null)

// 订阅弹窗
const subDialogVisible = ref(false)

function handleSubscription() {
  subDialogVisible.value = true
}

function onSubSuccess() {
  ElMessage.success('订阅充值成功')
  // 延迟1秒刷新店铺列表，确保支付回调已处理完成
  setTimeout(() => {
    loadStores()
  }, 1000)
}

// 登录状态
const loginPending = reactive({
  storeId: null,
  storeName: '',
  platform: ''
})

// IPC 监听取消函数
const removeListeners = []

async function loadStores() {
  loading.value = true
  try {
    const params = {
      page: pageInfo.page,
      pageSize: pageInfo.pageSize,
      ...searchForm
    }
    const data = await fetchStores(params)
    tableData.value = data.list || []
    pageInfo.total = data.total || 0
  } catch (err) {
    ElMessage.error('加载店铺列表失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

async function loadAllTagOptions() {
  try {
    const data = await fetchStoreTags()
    allTagOptions.value = Array.isArray(data) ? data : (data?.data || [])
  } catch (err) {
    // 非关键功能，静默失败
  }
}

function handleSearch() {
  pageInfo.page = 1
  loadStores()
}

function handleReset() {
  searchForm.name = ''
  searchForm.tag = ''
  searchForm.status = ''
  searchForm.online = ''
  handleSearch()
}

function onStoreSaved() {
  loadStores()
  loadAllTagOptions()
}

function handleAdd() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  // 弹出店铺类型选择
  typeSelectVisible.value = true
}

async function confirmAddStore(storeType) {
  typeSelectVisible.value = false
  const typeLabel = STORE_TYPE_MAP[storeType] || '店铺'

  try {
    const now = new Date()
    const timeStr = now.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).replace(/[\/\s:]/g, '')

    // 创建店铺（带店铺类型）
    const result = await createStore({
      name: `京东${typeLabel}${timeStr}`,
      platform: 'jd',
      store_type: storeType
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

    ElMessage.success(`已创建${typeLabel}并打开 shop.jd.com，请在弹出的浏览器窗口中登录`)
    loadStores()
  } catch (err) {
    ElMessage.error('操作失败: ' + err.message)
  }
}

function handleEdit(row) {
  editStoreData.value = { ...row }
  editDialogVisible.value = true
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除店铺「${row.name}」吗？删除后不可恢复。`,
      '删除确认',
      { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning' }
    )
    await deleteStore(row.id)
    ElMessage.success('删除成功')
    loadStores()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '删除失败')
    }
  }
}

async function handleToggleStatus(row, val) {
  const newStatus = val ? 'enabled' : 'disabled'
  try {
    await toggleStoreStatus(row.id, newStatus)
    row.status = newStatus
    ElMessage.success(val ? '已启用' : '已停用')
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  }
}

const PLATFORM_BACKEND_URLS = {
  taobao: 'https://myseller.taobao.com/',
  tmall: 'https://myseller.taobao.com/',
  jd: 'https://shop.jd.com/',
  pdd: 'https://mms.pinduoduo.com/',
  douyin: 'https://fxg.jinritemai.com/'
}

function handleOpenBackend(row) {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  const url = PLATFORM_BACKEND_URLS[row.platform]
  if (!url) {
    ElMessage.warning('不支持的平台: ' + (row.platform || '未知'))
    return
  }
  // ★ 离线状态提醒：Cookie可能已失效
  if (!row.online) {
    ElMessageBox.confirm(
      `店铺「${row.name}」当前状态为离线，Cookie可能已失效。\n点击"继续打开"将尝试访问后台，如无法访问请点击"重新登录"。`,
      '店铺离线提醒',
      {
        confirmButtonText: '继续打开',
        cancelButtonText: '重新登录',
        type: 'warning'
      }
    ).then(() => {
      doOpenBackend(row, url)
    }).catch(() => {
      handleLogin(row)
    })
    return
  }
  doOpenBackend(row, url)
}

function doOpenBackend(row, url) {
  window.electronAPI.invoke('open-store-backend-url', {
    storeId: row.id,
    url,
    title: `店铺后台 - ${row.name}`
  }).catch(err => {
    ElMessage.error('打开店铺后台失败: ' + err.message)
  })
}

function handleLogin(row) {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  loginPending.storeId = row.id
  loginPending.storeName = row.name
  loginPending.platform = row.platform
  // 登录按钮保留已有 cookie，并传递账号密码供自动填充
  window.electronAPI.invoke('open-platform-window', {
    storeId: row.id,
    platform: row.platform,
    keepCookie: true,
    account: row.account || '',
    password: row.password || ''
  }).catch(err => {
    ElMessage.error('打开平台窗口失败: ' + err.message)
    loginPending.storeId = null
  })
}

function handleConfirmLogin() {
  if (!loginPending.storeId) return
  window.electronAPI.invoke('confirm-platform-login', {
    storeId: loginPending.storeId,
    platform: loginPending.platform
  }).then(() => {
    ElMessage.success('登录成功，Cookie 已保存')
    loginPending.storeId = null
    loginPending.storeName = ''
    loginPending.platform = ''
    loadStores()
  }).catch(err => {
    ElMessage.error('确认登录失败: ' + err.message)
  })
}

function handleCancelLogin() {
  if (loginPending.storeId) {
    window.electronAPI.invoke('close-platform-window', {
      storeId: loginPending.storeId
    }).catch(() => {})
  }
  loginPending.storeId = null
  loginPending.storeName = ''
  loginPending.platform = ''
}

function handleSizeChange() {
  pageInfo.page = 1
  loadStores()
}

function handlePageChange() {
  loadStores()
}

onMounted(() => {
  loadStores()
  // 单独加载全量标签选项（不受分页限制）
  loadAllTagOptions()

  // 监听平台登录成功事件
  if (window.electronAPI?.onUpdate) {
    removeListeners.push(
      window.electronAPI.onUpdate('platform-login-success', ({ storeId }) => {
        loginPending.storeId = null
        loginPending.storeName = ''
        loginPending.platform = ''
        loadStores()
      })
    )
    // 监听心跳状态变化
    removeListeners.push(
      window.electronAPI.onUpdate('store-status-changed', ({ storeId, storeName, online, wasOnline }) => {
        const row = tableData.value.find(item => item.id === storeId)
        if (row) row.online = online ? 1 : 0
        if (online === false && wasOnline === true) {
          const msg = `${storeName || '店铺'}cookie已失效，请到店铺管理界面重新登录！`
          ElMessage.warning({ message: msg, duration: 8000 })
          try {
            const utterance = new SpeechSynthesisUtterance(msg)
            utterance.lang = 'zh-CN'
            utterance.rate = 1
            speechSynthesis.speak(utterance)
          } catch (e) { /* 语音不可用时静默 */ }
        }
      })
    )
  }
})

onUnmounted(() => {
  removeListeners.forEach(fn => fn && fn())
})
</script>

<style scoped>
.store-manage-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  margin-bottom: 4px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 4px;
}

.page-desc {
  font-size: 13px;
  color: #9ca3af;
  margin: 0;
}

/* 搜索区域 */
.search-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.search-card :deep(.el-form-item) {
  margin-bottom: 0;
}

/* 列表头部 */
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.list-actions {
  display: flex;
  gap: 8px;
}

.list-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

.list-count {
  font-size: 13px;
  font-weight: 400;
  color: #9ca3af;
  margin-left: 8px;
}

/* 卡片列表 */
.store-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
}

.empty-state {
  background: #fff;
  border-radius: 12px;
  padding: 48px 24px;
  border: 1px solid #f0f0f0;
}

/* 单个店铺卡片 */
.store-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: box-shadow 0.25s, border-color 0.25s;
}

.store-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  border-color: #e0e0e0;
}

.store-card.is-disabled {
  background: #fafafa;
}

/* 卡片顶部 */
.card-top {
  margin-bottom: 16px;
}

.card-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-name-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-name {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.status-tag {
  font-size: 11px;
}

/* 信息区域 */
.card-info {
  margin-bottom: 16px;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px 20px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 12px;
  color: #9ca3af;
  line-height: 1;
}

.info-value {
  font-size: 14px;
  color: #1f2937;
  font-weight: 500;
  word-break: break-all;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 12px;
}

.info-row .info-label {
  flex-shrink: 0;
  padding-top: 4px;
}

.tags-value {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 操作按钮 */
.card-actions {
  display: flex;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid #f5f5f5;
}

/* 编辑按钮推到最右侧 */
.action-edit {
  margin-left: auto;
}

/* 在线状态点 */
.online-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.online-dot.online {
  background-color: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}

.online-dot.offline {
  background-color: #d1d5db;
}

/* 到期时间样式 */
.expiry-date {
  color: #e67e22;
  font-weight: 600;
}
.expiry-date.expired {
  color: #e74c3c;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

/* 登录提示 */
.login-alert {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  width: auto;
  max-width: 600px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  border-radius: 8px;
}

.login-alert .el-button {
  margin-left: 12px;
}

/* 店铺类型选择弹窗 */
.type-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.type-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border: 2px solid #f0f0f0;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.25s;
}

.type-card:hover {
  border-color: #409eff;
  background: #f5f9ff;
  transform: translateX(4px);
}

.type-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 12px;
  color: #fff;
  flex-shrink: 0;
}

.type-card-info {
  flex: 1;
}

.type-card-name {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 4px;
}

.type-card-desc {
  font-size: 13px;
  color: #9ca3af;
}

.type-card-arrow {
  color: #c0c4cc;
  font-size: 16px;
  transition: color 0.25s;
}

.type-card:hover .type-card-arrow {
  color: #409eff;
}
</style>
