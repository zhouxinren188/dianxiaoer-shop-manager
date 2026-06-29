<template>
  <el-dialog
    :model-value="visible"
    title="店铺充值"
    width="620px"
    @close="handleClose"
    :close-on-click-modal="false"
    class="sub-dialog"
  >
    <!-- 选择阶段 -->
    <div v-show="!paying" class="sub-content">
      <!-- 店铺选择 -->
      <div class="section-block">
        <div class="section-title">
          <span>店铺充值</span>
          <el-checkbox v-model="selectAll" @change="handleSelectAll">全选</el-checkbox>
        </div>
        <el-input
          v-model="searchKeyword"
          placeholder="搜索店铺名称快速定位"
          clearable
          :prefix-icon="Search"
          class="store-search"
        />
        <div class="store-list" v-loading="storeLoading">
          <el-checkbox-group v-model="selectedStoreIds">
            <div
              v-for="store in filteredStoreList"
              :key="store.id"
              class="store-item"
              :class="{ 'is-selected': selectedStoreIds.includes(store.id) }"
            >
              <el-checkbox :value="store.id" :label="store.id">
                <span class="store-name">{{ store.name }}</span>
                <el-tag size="small" type="info" effect="plain">{{ storeTypeLabel(store.store_type) }}</el-tag>
              </el-checkbox>
            </div>
          </el-checkbox-group>
          <div v-if="!storeLoading && filteredStoreList.length === 0" class="empty-tip">
            {{ storeList.length === 0 ? '暂无店铺，请先新增店铺' : '未找到匹配的店铺' }}
          </div>
        </div>
        <div class="selected-count" v-if="selectedStoreIds.length > 0">
          已选 <span class="count-num">{{ selectedStoreIds.length }}</span> 家店铺
        </div>
      </div>

      <!-- 套餐选择 -->
      <div class="section-block">
        <div class="section-title"><span>选择套餐</span></div>
        <div class="plan-selector">
          <div
            v-for="p in plans"
            :key="p.key"
            class="plan-card"
            :class="{ selected: selectedPlan === p.key }"
            @click="selectedPlan = p.key"
          >
            <div v-if="p.badge" class="plan-badge">{{ p.badge }}</div>
            <div class="plan-name">{{ p.name }}</div>
            <div class="plan-price">{{ p.price }}<span class="unit">元/店</span></div>
            <div class="plan-period">{{ p.period }}</div>
            <div class="plan-daily">≈ {{ (p.price / parseInt(p.period)).toFixed(2) }} 元/天</div>
          </div>
        </div>
      </div>

      <!-- 合计 -->
      <div class="total-bar">
        <span class="total-label">合计：</span>
        <span class="total-amount">{{ totalAmount }}<span class="total-unit">元</span></span>
        <span class="total-detail" v-if="selectedStoreIds.length > 0">
          （{{ selectedStoreIds.length }}店 × {{ currentPlanPrice }}元）
        </span>
      </div>
    </div>

    <!-- 支付阶段 -->
    <div v-show="paying" class="pay-content">
      <div class="qr-title">请使用微信扫描下方二维码完成支付</div>
      <div class="qr-amount">{{ payAmountYuan }}<span class="unit">元</span></div>
      <div class="qr-box">
        <img v-if="qrDataUrl" :src="qrDataUrl" class="qr-img" alt="支付二维码" />
        <div v-else class="qr-loading">
          <el-icon class="is-loading" :size="32"><Loading /></el-icon>
        </div>
      </div>
      <div class="qr-hint">支付完成后将自动确认，请勿关闭页面</div>
      <div class="qr-status" :class="qrStatusClass">{{ qrStatusText }}</div>
      <el-button class="cancel-btn" @click="cancelPay">取消支付</el-button>
    </div>

    <!-- 成功提示 -->
    <div v-show="showSuccess" class="success-overlay">
      <div class="success-box">
        <div class="success-icon">✓</div>
        <div class="success-title">支付成功</div>
        <div class="success-desc">{{ successDesc }}</div>
        <el-button type="warning" class="success-btn" @click="handleSuccessClose">确定</el-button>
      </div>
    </div>

    <template #footer v-if="!paying && !showSuccess">
      <el-button size="large" class="cancel-footer-btn" @click="handleClose">取消</el-button>
      <el-button
        type="success"
        size="large"
        class="wechat-pay-btn"
        :disabled="selectedStoreIds.length === 0"
        :loading="creatingOrder"
        @click="handlePay"
      >
        <svg v-if="!creatingOrder" class="wechat-icon" viewBox="0 0 1024 1024" width="20" height="20">
          <path d="M664.250054 368.541681c10.015098 0 19.892049 0.732687 29.673061 1.795902-26.647517-129.794314-159.338146-226.389273-314.105461-226.389273-171.289436 0-310.632244 121.216862-310.632244 275.045989 0 88.885121 47.675802 161.891122 127.244268 218.926114l-31.741892 97.472663 111.132418-57.401683c39.816194 7.823629 71.805454 15.856622 111.712084 15.856622 9.993466 0 19.882837-0.487214 29.670408-1.283791-6.235168-21.247089-9.835047-43.645478-9.835047-66.864073C377.489809 484.552249 504.379881 368.541681 664.250054 368.541681zM554.508952 243.434608c23.966405 0 39.816194 16.327257 39.816194 36.643794 0 20.315514-15.849789 36.643794-39.816194 36.643794-23.808072 0-47.675802-16.32828-47.675802-36.643794C506.83315 259.761864 530.70088 243.434608 554.508952 243.434608zM338.418549 316.719373c-23.808072 0-47.813599-16.327257-47.813599-36.643794 0-20.316537 24.005527-36.643794 47.813599-36.643794 23.808072 0 39.816194 16.327257 39.816194 36.643794C378.234743 300.392116 362.226621 316.719373 338.418549 316.719373zM945.448458 604.008146c0-129.813478-127.232815-235.648165-270.299246-235.648165-151.453507 0-270.678682 105.834687-270.678682 235.648165 0 130.230024 119.225175 235.897499 270.678682 235.897499 31.698215 0 63.582905-8.12852 95.422244-16.231458l87.174355 48.426859-23.918682-81.046382C897.83943 749.398482 945.448458 681.59815 945.448458 604.008146zM602.220547 567.342766c-15.846719 0-31.838375-16.231458-31.838375-32.67333 0-16.186687 15.991656-32.465489 31.838375-32.465489 24.004504 0 39.816194 16.278802 39.816194 32.465489C642.036741 551.111308 626.225051 567.342766 602.220547 567.342766zM745.494229 567.342766c-15.846719 0-31.752981-16.231458-31.752981-32.67333 0-16.186687 15.90524-32.465489 31.752981-32.465489 23.809095 0 39.816194 16.278802 39.816194 32.465489C785.310423 551.111308 769.303324 567.342766 745.494229 567.342766z" fill="currentColor"/>
        </svg>
        {{ creatingOrder ? '正在创建订单...' : '微信扫码支付' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Loading, Wallet, Search } from '@element-plus/icons-vue'
import { fetchStores } from '@/api/store'
import { createStoreOrder, queryOrder, generateQRCode } from '@/api/subscription'

const props = defineProps({
  visible: { type: Boolean, default: false }
})

const emit = defineEmits(['update:visible', 'success'])

// ========== 店铺数据 ==========
const storeList = ref([])
const storeLoading = ref(false)
const selectedStoreIds = ref([])
const selectAll = ref(false)
const searchKeyword = ref('')

const filteredStoreList = computed(() => {
  if (!searchKeyword.value.trim()) return storeList.value
  const kw = searchKeyword.value.trim().toLowerCase()
  return storeList.value.filter(s => s.name.toLowerCase().includes(kw))
})

const STORE_TYPE_MAP = {
  pop: 'POP',
  supplier: '供应商',
  consignment: '代销'
}
function storeTypeLabel(type) {
  return STORE_TYPE_MAP[type] || '-'
}

async function loadStores() {
  storeLoading.value = true
  try {
    const data = await fetchStores({ page: 1, pageSize: 9999 })
    storeList.value = data.list || []
  } catch (err) {
    ElMessage.error('加载店铺列表失败: ' + err.message)
  } finally {
    storeLoading.value = false
  }
}

function handleSelectAll(val) {
  selectedStoreIds.value = val ? storeList.value.map(s => s.id) : []
}

// ========== 套餐数据 ==========
const plans = [
  { key: 'monthly', name: '月度', price: 15, period: '30天', badge: '' },
  { key: 'quarterly', name: '季度', price: 45, period: '90天', badge: '' },
  { key: 'half_yearly', name: '半年', price: 68, period: '180天', badge: '最划算' }
]
const selectedPlan = ref('monthly')

const currentPlanPrice = computed(() => {
  const plan = plans.find(p => p.key === selectedPlan.value)
  return plan ? plan.price : 0
})

const totalAmount = computed(() => {
  return selectedStoreIds.value.length * currentPlanPrice.value
})

// ========== 支付流程 ==========
const paying = ref(false)
const creatingOrder = ref(false)
const qrDataUrl = ref('')
const qrStatusText = ref('等待扫码支付...')
const qrStatusClass = ref('')
const currentOrderNo = ref(null)
const showSuccess = ref(false)
const successDesc = ref('')
const payAmountYuan = ref(0)

let pollTimer = null

async function handlePay() {
  if (selectedStoreIds.value.length === 0) {
    ElMessage.warning('请至少选择一个店铺')
    return
  }

  creatingOrder.value = true
  try {
    const res = await createStoreOrder(selectedStoreIds.value, selectedPlan.value)
    if (!res.success) {
      ElMessage.error(res.message || '创建订单失败')
      return
    }

    currentOrderNo.value = res.order_no
    payAmountYuan.value = Math.floor(res.amount / 100)

    // 生成二维码
    paying.value = true
    qrStatusText.value = '等待扫码支付...'
    qrStatusClass.value = ''

    const dataUrl = await generateQRCode(res.code_url)
    qrDataUrl.value = dataUrl

    // 开始轮询
    startPolling(res.order_no)
  } catch (e) {
    ElMessage.error('创建订单失败: ' + (e.message || '网络错误'))
  } finally {
    creatingOrder.value = false
  }
}

function startPolling(orderNo) {
  stopPolling()
  let count = 0
  pollTimer = setInterval(async () => {
    count++
    if (count > 180) {
      stopPolling()
      qrStatusText.value = '支付超时，请重试'
      qrStatusClass.value = 'error'
      return
    }
    try {
      const res = await queryOrder(orderNo)
      if (res.success && res.status === 'paid') {
        stopPolling()
        onPaymentSuccess()
      }
    } catch {
      // 忽略网络错误，继续轮询
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function onPaymentSuccess() {
  qrStatusText.value = '支付成功！'
  qrStatusClass.value = 'success'

  const planName = plans.find(p => p.key === selectedPlan.value)?.name || ''
  successDesc.value = `已为 ${selectedStoreIds.value.length} 家店铺充值${planName}套餐，感谢您的支持！`
  showSuccess.value = true
}

function cancelPay() {
  stopPolling()
  currentOrderNo.value = null
  paying.value = false
  qrDataUrl.value = ''
  qrStatusText.value = '等待扫码支付...'
  qrStatusClass.value = ''
}

function handleSuccessClose() {
  showSuccess.value = false
  emit('success')
  handleClose()
}

function handleClose() {
  stopPolling()
  paying.value = false
  showSuccess.value = false
  qrDataUrl.value = ''
  currentOrderNo.value = null
  emit('update:visible', false)
}

// ========== 生命周期 ==========
watch(() => props.visible, (val) => {
  if (val) {
    selectedStoreIds.value = []
    selectAll.value = false
    searchKeyword.value = ''
    selectedPlan.value = 'monthly'
    paying.value = false
    showSuccess.value = false
    qrDataUrl.value = ''
    loadStores()
  }
})

onUnmounted(() => {
  stopPolling()
})
</script>

<style scoped>
.sub-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 区块 */
.section-block {
  background: #f9fafb;
  border-radius: 8px;
  padding: 14px 16px;
}

.section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 600;
  color: #333;
  margin-bottom: 10px;
}

/* 搜索框 */
.store-search {
  margin-bottom: 10px;
}
.store-search :deep(.el-input__wrapper) {
  height: 38px;
}
.store-search :deep(.el-input__inner) {
  font-size: 14px;
}

/* 店铺列表 */
.store-list {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid #eee;
  border-radius: 6px;
  background: #fff;
  padding: 4px 0;
}

.store-list::-webkit-scrollbar {
  width: 4px;
}
.store-list::-webkit-scrollbar-thumb {
  background: #ddd;
  border-radius: 2px;
}

.store-item {
  padding: 6px 12px;
  transition: background 0.15s;
}
.store-item:hover {
  background: #f5f7fa;
}
.store-item.is-selected {
  background: #ecf5ff;
}

.store-item :deep(.el-checkbox__label) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.store-name {
  font-size: 13px;
  color: #333;
}

.empty-tip {
  text-align: center;
  padding: 24px;
  color: #999;
  font-size: 13px;
}

.selected-count {
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}
.count-num {
  color: #e67e22;
  font-weight: bold;
}

/* 套餐选择 */
.plan-selector {
  display: flex;
  gap: 10px;
}

.plan-card {
  flex: 1;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  padding: 14px 8px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: #fff;
  position: relative;
}
.plan-card:hover {
  border-color: #f39c12;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.plan-card.selected {
  border-color: #e67e22;
  background: #fff8f0;
  box-shadow: 0 4px 12px rgba(230, 126, 34, 0.15);
}

.plan-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #e74c3c;
  color: #fff;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  font-weight: bold;
}

.plan-name {
  font-size: 14px;
  font-weight: bold;
  color: #333;
  margin-bottom: 6px;
}

.plan-price {
  font-size: 22px;
  font-weight: bold;
  color: #e67e22;
}
.plan-price .unit {
  font-size: 11px;
  font-weight: normal;
  color: #999;
}

.plan-period {
  font-size: 11px;
  color: #999;
  margin-top: 2px;
}

.plan-daily {
  font-size: 11px;
  color: #27ae60;
  margin-top: 4px;
  font-weight: 500;
}

/* 合计 */
.total-bar {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: #fff8f0;
  border-radius: 8px;
  border: 1px solid #ffe0b2;
}
.total-label {
  font-size: 14px;
  color: #666;
}
.total-amount {
  font-size: 24px;
  font-weight: bold;
  color: #e67e22;
  margin: 0 4px;
}
.total-unit {
  font-size: 13px;
  font-weight: normal;
}
.total-detail {
  font-size: 12px;
  color: #999;
}

/* 支付阶段 */
.pay-content {
  text-align: center;
  padding: 12px 0;
}

.qr-title {
  font-size: 14px;
  color: #333;
  margin-bottom: 12px;
}

.qr-amount {
  font-size: 24px;
  font-weight: bold;
  color: #e67e22;
  margin-bottom: 12px;
}
.qr-amount .unit {
  font-size: 13px;
  font-weight: normal;
}

.qr-box {
  display: inline-block;
  padding: 12px;
  background: #fff;
  border: 1px solid #eee;
  border-radius: 8px;
  margin-bottom: 12px;
}

.qr-img {
  width: 220px;
  height: 220px;
}

.qr-loading {
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c0c4cc;
}

.qr-hint {
  font-size: 12px;
  color: #999;
}

.qr-status {
  margin-top: 10px;
  font-size: 13px;
  color: #3498db;
}
.qr-status.success {
  color: #27ae60;
  font-weight: bold;
}
.qr-status.error {
  color: #e74c3c;
}

.cancel-btn {
  margin-top: 12px;
}

/* 成功遮罩 */
.success-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  border-radius: 8px;
}

.success-box {
  text-align: center;
}

.success-icon {
  font-size: 48px;
  color: #27ae60;
  margin-bottom: 12px;
}

.success-title {
  font-size: 18px;
  font-weight: bold;
  color: #27ae60;
  margin-bottom: 8px;
}

.success-desc {
  font-size: 13px;
  color: #666;
  margin-bottom: 16px;
}

.success-btn {
  background: #e67e22;
  border-color: #e67e22;
}
.success-btn:hover {
  opacity: 0.9;
}

/* 微信支付按钮 */
.wechat-pay-btn {
  background: #07c160 !important;
  border-color: #07c160 !important;
  font-size: 16px;
  font-weight: bold;
  padding: 12px 32px;
  height: auto;
}
.wechat-pay-btn:hover {
  background: #06ad56 !important;
  border-color: #06ad56 !important;
}
.wechat-pay-btn:disabled {
  background: #a8e6c5 !important;
  border-color: #a8e6c5 !important;
}

/* 取消按钮与支付按钮等高 */
.cancel-footer-btn {
  padding: 12px 32px;
  height: auto;
  font-size: 16px;
}

/* 微信图标 */
.wechat-icon {
  margin-right: 6px;
  flex-shrink: 0;
}
</style>
