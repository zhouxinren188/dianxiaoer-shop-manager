<template>
  <div class="store-shipment-page">
    <!-- 1. 页面标题卡片 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Van /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">供店发货</h2>
          <p class="header-desc">从京东供销后台获取供货商采购订单，进行发货管理</p>
        </div>
      </div>
    </div>

    <!-- 2. 统计概览卡片 -->
    <div class="stats-row">
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #1890ff">{{ statsData.totalOrders }}</div>
        <div class="stat-label">采购订单总数</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #e6a23c">{{ statsData.pendingShipment }}</div>
        <div class="stat-label">待出库订单</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #f56c6c">¥{{ statsData.totalAmount }}</div>
        <div class="stat-label">采购总金额</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #67c23a">{{ statsData.completedOrders }}</div>
        <div class="stat-label">已完成订单</div>
      </el-card>
    </div>

    <!-- 3. 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="searchForm" inline class="filter-form">
        <el-form-item label="选择店铺">
          <el-select
            v-model="searchForm.storeId"
            placeholder="请选择京东店铺"
            clearable
            style="width: 220px"
          >
            <el-option
              v-for="store in storeOptions"
              :key="store.id"
              :label="store.name"
              :value="store.id"
            >
              <span>{{ store.name }}</span>
              <el-tag
                :type="store.online ? 'success' : 'info'"
                size="small"
                style="margin-left: 8px"
              >{{ store.online ? '在线' : '离线' }}</el-tag>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="loading" @click="handleFetchOrders">
            <el-icon v-if="!loading"><Download /></el-icon>
            获取订单
          </el-button>
          <el-button @click="handleReset">
            <el-icon><Refresh /></el-icon>
            重置
          </el-button>
        </el-form-item>
      </el-form>
      <!-- 条件筛选 -->
      <div class="filter-grid" v-if="tableData.length">
        <div class="filter-item">
          <label class="filter-label">订单编号</label>
          <el-input v-model="searchForm.orderId" placeholder="请输入订单编号" clearable />
        </div>
        <div class="filter-item">
          <label class="filter-label">采购单编号</label>
          <el-input v-model="searchForm.bOrderId" placeholder="请输入采购单编号" clearable />
        </div>
        <div class="filter-item">
          <label class="filter-label">收件姓名</label>
          <el-input v-model="searchForm.receiverName" placeholder="请输入收件人姓名" clearable />
        </div>
        <div class="filter-item">
          <label class="filter-label">代销商名称</label>
          <el-input v-model="searchForm.dealerName" placeholder="请输入代销商名称" clearable />
        </div>
      </div>
    </el-card>

    <!-- 4. 状态Tab栏 -->
    <div class="stats-bar" v-if="tableData.length">
      <span
        v-for="item in statusTabs"
        :key="item.value"
        class="stat-item"
        :class="{ active: activeStatus === item.value }"
        @click="handleStatusClick(item.value)"
      >
        {{ item.label }}<span class="stat-count">({{ item.count }})</span>
      </span>
    </div>

    <!-- 5. 卡片式订单列表 -->
    <div class="table-card" v-loading="loading" element-loading-text="正在从京东后台获取订单数据...">
      <!-- 固定表头 -->
      <div class="order-table-header" v-if="pagedData.length">
        <div class="ot-col ot-col-index">序号</div>
        <div class="ot-col ot-col-goods">商品信息</div>
        <div class="ot-col ot-col-price">单价/数量</div>
        <div class="ot-col ot-col-amount">采购总额</div>
        <div class="ot-col ot-col-time">下单时间</div>
        <div class="ot-col ot-col-receiver">收货人</div>
        <div class="ot-col ot-col-status">订单状态</div>
        <div class="ot-col ot-col-action">操作</div>
      </div>

      <!-- 订单卡片列表 -->
      <div class="order-list" v-if="pagedData.length">
        <div
          class="order-card"
          v-for="(order, orderIdx) in pagedData"
          :key="order.orderId || orderIdx"
        >
          <!-- 订单卡片头部 -->
          <div
            class="order-card-header"
            :style="{
              borderLeftColor: statusBorderColor(order.statusText),
              backgroundColor: statusBgColor(order.statusText)
            }"
          >
            <div class="order-header-left">
              <span class="order-header-label">订单编号:</span>
              <span class="order-header-no">{{ order.orderId || '--' }}</span>
              <span class="order-header-divider">|</span>
              <span class="order-header-dealer">{{ order.dealerName || '--' }}</span>
              <span v-if="order.dealerCode" class="order-header-dealer-code">{{ order.dealerCode }}</span>
            </div>
          </div>

          <!-- 订单卡片主体 -->
          <div class="order-card-body">
            <!-- 左侧：商品行 -->
            <div class="order-body-left">
              <div class="product-row">
                <div class="ot-col ot-col-index">
                  <span class="index-num">{{ (pageInfo.page - 1) * pageInfo.pageSize + orderIdx + 1 }}</span>
                </div>
                <div class="ot-col ot-col-goods">
                  <div class="goods-cell">
                    <el-image
                      v-if="order.productImage"
                      :src="order.productImage"
                      :preview-src-list="[order.productImage]"
                      fit="cover"
                      class="goods-img-real"
                      lazy
                    />
                    <div v-else class="goods-img" :style="{ background: getGoodsAvatarColor(order.productName) }">
                      <span class="goods-img-text">{{ (order.productName || '?').charAt(0) }}</span>
                    </div>
                    <div class="goods-info">
                      <p class="goods-name">{{ order.productName || '未知商品' }}</p>
                      <p class="goods-sku" v-if="order.skuId">SKU: {{ order.skuId }}</p>
                      <p class="goods-sku" v-if="order.skuCount > 1">
                        <el-tag size="small" type="info">{{ order.skuCount }} 个SKU</el-tag>
                      </p>
                    </div>
                  </div>
                </div>
                <div class="ot-col ot-col-price">
                  <div class="price-cell">
                    <span class="price-value">{{ order.unitPrice ? '¥' + order.unitPrice.toFixed(2) : '--' }}</span>
                    <span class="price-qty" v-if="order.quantity">x {{ order.quantity }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧：订单级信息 -->
            <div class="order-body-right">
              <div class="ot-col ot-col-amount">
                <span class="amount-main">{{ order.totalAmount ? '¥' + order.totalAmount.toFixed(2) : '--' }}</span>
                <p class="amount-sub" v-if="order.freight">含运费 ¥{{ order.freight.toFixed(2) }}</p>
                <p class="amount-sub" v-if="order.goodsAmount">货款 ¥{{ order.goodsAmount.toFixed(2) }}</p>
              </div>
              <div class="ot-col ot-col-time">
                <span class="time-text">{{ order.orderDate || '--' }}</span>
              </div>
              <div class="ot-col ot-col-receiver">
                <span class="receiver-name">{{ order.receiverName || '--' }}</span>
                <span class="receiver-phone" v-if="order.receiverPhone">{{ order.receiverPhone }}</span>
              </div>
              <div class="ot-col ot-col-status">
                <el-tag :type="statusType(order.statusText)" size="small">{{ order.statusText || '未知' }}</el-tag>
                <el-tag v-if="order.paid && !isTerminalStatus(order.statusText)" type="success" size="small" effect="plain" style="margin-top: 3px">已付款</el-tag>
                <el-tag v-else-if="order.waitPay && !isTerminalStatus(order.statusText)" type="warning" size="small" effect="plain" style="margin-top: 3px">待付款</el-tag>
                <template v-if="order.shipmentCompanyName || order.shipmentNum">
                  <span class="status-logistics">{{ order.shipmentCompanyName }}</span>
                  <span class="status-logistics-num" v-if="order.shipmentNum">{{ order.shipmentNum }}</span>
                </template>
              </div>
              <div class="ot-col ot-col-action">
                <el-button type="primary" link size="small" @click="handleViewDetail(order)">查看详情</el-button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <el-empty v-if="!loading && !pagedData.length" description="暂无数据，请选择店铺后点击「获取订单」" style="padding: 60px 0;" />

      <!-- 分页 -->
      <div class="pagination-wrap" v-if="filteredData.length > 0">
        <el-pagination
          v-model:current-page="pageInfo.page"
          v-model:page-size="pageInfo.pageSize"
          :total="filteredData.length"
          background
          layout="total, sizes, prev, pager, next"
          :page-sizes="[20, 50, 100]"
        />
      </div>
    </div>

    <!-- 6. 订单详情抽屉 -->
    <el-drawer v-model="drawerVisible" title="采购订单详情" size="640px" direction="rtl">
      <template v-if="currentOrder">
        <!-- 头部 -->
        <div class="detail-header">
          <div class="detail-header-left">
            <span class="detail-order-no">{{ currentOrder.orderId }}</span>
            <el-tag :type="statusType(currentOrder.statusText)" size="small">{{ currentOrder.statusText || '未知' }}</el-tag>
          </div>
          <span class="detail-order-time">{{ currentOrder.orderDate }}</span>
        </div>

        <!-- 订单信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">订单信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">订单编号</span><span class="detail-value">{{ currentOrder.orderId || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">订单状态</span><span class="detail-value"><el-tag :type="statusType(currentOrder.statusText)" size="small">{{ currentOrder.statusText || '--' }}</el-tag></span></div>
            <div class="detail-row"><span class="detail-label">代销商</span><span class="detail-value">{{ currentOrder.dealerName || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">代销商编号</span><span class="detail-value">{{ currentOrder.dealerCode || '--' }}</span></div>
          </div>
        </div>

        <!-- 商品信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">商品信息</h4>
          <table class="detail-goods-table">
            <thead>
              <tr>
                <th>商品名称</th>
                <th>商品编码</th>
                <th>单价</th>
                <th>数量</th>
                <th>货款</th>
                <th>运费</th>
                <th>总额</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="goods-name-cell">{{ currentOrder.productName || '--' }}</td>
                <td class="num-cell">{{ currentOrder.skuId || '--' }}</td>
                <td class="num-cell">{{ currentOrder.unitPrice ? '¥' + currentOrder.unitPrice.toFixed(2) : '--' }}</td>
                <td class="num-cell">{{ currentOrder.quantity || '--' }}</td>
                <td class="num-cell">{{ currentOrder.goodsAmount ? '¥' + currentOrder.goodsAmount.toFixed(2) : '--' }}</td>
                <td class="num-cell">{{ currentOrder.freight ? '¥' + currentOrder.freight.toFixed(2) : '¥0.00' }}</td>
                <td class="num-cell highlight-num">{{ currentOrder.totalAmount ? '¥' + currentOrder.totalAmount.toFixed(2) : '--' }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="4" class="tfoot-label">合计</td>
                <td class="num-cell">{{ currentOrder.goodsAmount ? '¥' + currentOrder.goodsAmount.toFixed(2) : '--' }}</td>
                <td class="num-cell">{{ currentOrder.freight ? '¥' + currentOrder.freight.toFixed(2) : '¥0.00' }}</td>
                <td class="num-cell highlight-num">{{ currentOrder.totalAmount ? '¥' + currentOrder.totalAmount.toFixed(2) : '--' }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- 收货信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">收货信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">收货人</span><span class="detail-value">{{ currentOrder.receiverName || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">联系电话</span><span class="detail-value">{{ currentOrder.receiverPhone || '--' }}</span></div>
          </div>
          <div class="detail-row" style="margin-top: 8px;">
            <span class="detail-label">收货地址</span>
            <span class="detail-value">{{ currentOrder.receiverFullAddress || currentOrder.receiverAddress || '--' }}</span>
          </div>
        </div>

        <!-- 物流信息 -->
        <div class="detail-section" v-if="currentOrder.shipmentNum">
          <h4 class="detail-section-title">物流信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">物流公司</span><span class="detail-value">{{ currentOrder.shipmentCompanyName || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">物流单号</span><span class="detail-value">{{ currentOrder.shipmentNum || '--' }}</span></div>
          </div>
        </div>

        <!-- 时间信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">时间信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">下单时间</span><span class="detail-value">{{ currentOrder.orderDate || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">完成时间</span><span class="detail-value">{{ currentOrder.finishTime || '--' }}</span></div>
          </div>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { reactive, ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Van, Refresh } from '@element-plus/icons-vue'
import { fetchStores } from '@/api/store'
import { fetchSupplyOrders as fetchServerOrders, saveSupplyOrders } from '@/api/supplyOrder'

// ==================== 响应式状态 ====================

const searchForm = reactive({
  storeId: null,
  orderId: '',
  bOrderId: '',
  receiverName: '',
  dealerName: ''
})

const pageInfo = reactive({
  page: 1,
  pageSize: 20
})

const loading = ref(false)
const storeOptions = ref([])
const tableData = ref([])
const totalCount = ref(0)
const activeStatus = ref('')
const drawerVisible = ref(false)
const currentOrder = ref(null)

// ==================== 状态配置 ====================

const STATUS_OPTIONS = ['待出库', '已出库', '已完成', '待发货', '待审核', '待付款', '待代销商支付', '已锁定', '已取消']

const AVATAR_COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#7986cb', '#f06292', '#aed581', '#ff8a65']

// ==================== Computed ====================

const statsData = computed(() => {
  const data = tableData.value
  const total = data.reduce((sum, item) => sum + (item.totalAmount || 0), 0)
  return {
    totalOrders: data.length,
    pendingShipment: data.filter(item => item.statusText === '待出库').length,
    totalAmount: total.toFixed(2),
    completedOrders: data.filter(item => item.statusText === '已完成').length
  }
})

const ALWAYS_SHOW_STATUSES = ['待出库', '已出库']

const statusTabs = computed(() => {
  const counts = {}
  for (const o of tableData.value) {
    const s = o.statusText || '未知'
    counts[s] = (counts[s] || 0) + 1
  }
  const tabs = [{ label: '全部', value: '', count: tableData.value.length }]
  for (const s of STATUS_OPTIONS) {
    if (counts[s] || ALWAYS_SHOW_STATUSES.includes(s)) {
      tabs.push({ label: s, value: s, count: counts[s] || 0 })
    }
  }
  return tabs
})

const filteredData = computed(() => {
  let data = tableData.value
  if (activeStatus.value) {
    data = data.filter(item => item.statusText === activeStatus.value)
  }
  if (searchForm.orderId) {
    const kw = searchForm.orderId.trim()
    data = data.filter(item => (item.orderId || '').includes(kw))
  }
  if (searchForm.bOrderId) {
    const kw = searchForm.bOrderId.trim()
    data = data.filter(item => (item.bOrderId || '').includes(kw))
  }
  if (searchForm.receiverName) {
    const kw = searchForm.receiverName.trim()
    data = data.filter(item => (item.receiverName || '').includes(kw))
  }
  if (searchForm.dealerName) {
    const kw = searchForm.dealerName.trim()
    data = data.filter(item => (item.dealerName || '').includes(kw))
  }
  return data
})

const pagedData = computed(() => {
  const start = (pageInfo.page - 1) * pageInfo.pageSize
  return filteredData.value.slice(start, start + pageInfo.pageSize)
})

// ==================== 方法 ====================

function mapServerOrder(row) {
  return {
    orderId: row.order_id,
    bOrderId: row.b_order_id,
    orderDate: row.order_date,
    finishTime: row.finish_time,
    stockTime: row.stock_time,
    totalAmount: parseFloat(row.total_amount) || 0,
    goodsAmount: parseFloat(row.goods_amount) || 0,
    freightPrice: parseFloat(row.freight_price) || 0,
    orderState: row.order_state,
    statusText: row.status_text,
    jdOrderStateDesc: row.jd_order_state_desc,
    paid: !!row.paid,
    waitPay: !!row.wait_pay,
    lock: row.lock_flag,
    dealerCode: row.dealer_code,
    dealerName: row.dealer_name,
    supplierName: row.supplier_name,
    receiverName: row.receiver_name,
    receiverPhone: row.receiver_phone,
    receiverAddress: row.receiver_address,
    receiverFullAddress: row.receiver_full_address,
    shipmentNum: row.shipment_num,
    shipmentCompanyName: row.shipment_company_name,
    skuId: row.sku_id,
    productName: row.product_name,
    productImage: row.product_image,
    unitPrice: parseFloat(row.unit_price) || 0,
    jdPrice: parseFloat(row.jd_price) || 0,
    quantity: row.quantity,
    outerSkuId: row.outer_sku_id,
    skuCount: row.sku_count,
    allSkus: typeof row.all_skus === 'string' ? JSON.parse(row.all_skus || 'null') : row.all_skus,
    orderSourceDesc: row.order_source_desc,
    sourceType: row.source_type
  }
}

async function loadOrdersFromServer() {
  if (!searchForm.storeId) return
  try {
    const data = await fetchServerOrders({ store_id: searchForm.storeId, pageSize: 500 })
    const list = (data.list || []).map(mapServerOrder)
    tableData.value = list
    totalCount.value = data.total || list.length
  } catch (err) {
    console.warn('从服务器加载订单失败:', err.message)
  }
}

function statusType(status) {
  if (!status) return 'info'
  if (status.includes('待出库')) return 'warning'
  if (status.includes('已出库')) return 'primary'
  if (status.includes('已完成')) return 'success'
  if (status.includes('已取消')) return 'danger'
  if (status.includes('已锁定')) return 'danger'
  if (status.includes('待发货')) return 'warning'
  if (status.includes('待')) return 'warning'
  return 'info'
}

function isTerminalStatus(status) {
  if (!status) return false
  return status.includes('已取消') || status.includes('已完成') || status.includes('已出库')
}

function statusBorderColor(status) {
  if (!status) return '#909399'
  if (status === '待出库') return '#2b5aed'
  if (status === '已出库') return '#409eff'
  if (status === '已完成') return '#52c41a'
  if (status === '已取消') return '#909399'
  if (status === '已锁定') return '#f56c6c'
  if (status.startsWith('待')) return '#e6a23c'
  return '#909399'
}

function statusBgColor(status) {
  if (!status) return '#fafafa'
  if (status === '待出库') return '#f0f5ff'
  if (status === '已出库') return '#f0f5ff'
  if (status === '已完成') return '#f0f7f0'
  if (status === '已取消') return '#fafafa'
  if (status === '已锁定') return '#fff2f0'
  if (status.startsWith('待')) return '#fffbf0'
  return '#fafafa'
}

function getGoodsAvatarColor(name) {
  if (!name) return AVATAR_COLORS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function handleStatusClick(status) {
  activeStatus.value = status
  pageInfo.page = 1
}

function handleViewDetail(order) {
  currentOrder.value = order
  drawerVisible.value = true
}

function handleReset() {
  activeStatus.value = ''
  searchForm.orderId = ''
  searchForm.bOrderId = ''
  searchForm.receiverName = ''
  searchForm.dealerName = ''
  tableData.value = []
  totalCount.value = 0
  drawerVisible.value = false
  currentOrder.value = null
}

async function handleFetchOrders() {
  if (!searchForm.storeId) {
    ElMessage.warning('请先选择一个京东店铺')
    return
  }

  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }

  loading.value = true
  activeStatus.value = ''
  try {
    const result = await window.electronAPI.invoke('fetch-supply-orders', {
      storeId: searchForm.storeId
    })

    if (result.success) {
      const orders = result.data.list || []
      if (orders.length === 0) {
        ElMessage.info('未获取到订单数据')
      } else {
        ElMessage.success(`成功获取 ${orders.length} 条订单，正在保存...`)
        // 保存到服务器
        try {
          await saveSupplyOrders(searchForm.storeId, orders)
        } catch (saveErr) {
          console.warn('保存订单到服务器失败:', saveErr.message)
        }
        // 从服务器重新加载（确保数据一致）
        await loadOrdersFromServer()
      }
    } else {
      ElMessage.error(result.message || '获取订单失败')
    }
  } catch (err) {
    ElMessage.error('获取订单失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

async function loadStores() {
  try {
    const data = await fetchStores({ platform: 'jd', status: 'enabled', pageSize: 100 })
    applyStoreData(data)
  } catch (err) {
    console.error('加载店铺列表失败:', err.message)
    ElMessage.error('无法加载店铺列表')
  }
}

function applyStoreData(data) {
  storeOptions.value = data.list || []
  const onlineStore = storeOptions.value.find(s => s.online === 1)
  if (onlineStore) {
    searchForm.storeId = onlineStore.id
  } else if (storeOptions.value.length > 0) {
    searchForm.storeId = storeOptions.value[0].id
  }
}

// 监听店铺切换，自动加载该店铺的订单
watch(() => searchForm.storeId, (newId) => {
  if (newId) {
    activeStatus.value = ''
    pageInfo.page = 1
    loadOrdersFromServer()
  } else {
    tableData.value = []
    totalCount.value = 0
  }
})

onMounted(async () => {
  await loadStores()
})
</script>

<style scoped>
.store-shipment-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ==================== 页面标题卡片 ==================== */

.page-header-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-icon {
  width: 48px;
  height: 48px;
  background: #1890ff;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #1f2d3d;
  margin: 0 0 4px;
}

.header-desc {
  font-size: 13px;
  color: #909399;
  margin: 0;
}

/* ==================== 统计卡片 ==================== */

.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-card {
  border-radius: 12px;
  text-align: center;
  padding: 8px 0;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.4;
  font-family: 'Inter', monospace;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

/* ==================== 筛选区 ==================== */

.filter-card {
  border-radius: 12px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.filter-form :deep(.el-form-item) {
  margin-bottom: 0;
  margin-right: 0;
}

.filter-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px 16px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-label {
  font-size: 13px;
  color: #606266;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.filter-item :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

/* ==================== 状态Tab栏 ==================== */

.stats-bar {
  display: flex;
  gap: 4px;
  padding: 0 4px;
}

.stat-item {
  padding: 8px 16px;
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  white-space: nowrap;
}

.stat-item:hover {
  color: #2b5aed;
}

.stat-item.active {
  color: #2b5aed;
  font-weight: 500;
  border-bottom-color: #2b5aed;
}

.stat-count {
  font-size: 12px;
  margin-left: 2px;
}

/* ==================== 卡片式订单列表 ==================== */

.table-card {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  padding: 0;
  overflow: hidden;
}

/* 表头 */
.order-table-header {
  display: flex;
  align-items: center;
  background: #fafafa;
  border-bottom: 1px solid #ebeef5;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

/* 列宽定义 */
.ot-col-index {
  width: 50px;
  flex-shrink: 0;
  text-align: center;
}

.ot-col-goods {
  flex: 1;
  min-width: 0;
  padding: 0 8px;
}

.ot-col-price {
  width: 110px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-amount {
  width: 120px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-time {
  width: 150px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-receiver {
  width: 110px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-status {
  width: 140px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-action {
  width: 80px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

/* 订单列表 */
.order-list {
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 订单卡片 */
.order-card {
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
  transition: box-shadow 0.2s;
}

.order-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

/* 订单卡片头部 */
.order-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e8e8e8;
  padding: 7px 16px;
  font-size: 12px;
  border-left: 3px solid #52c41a;
}

.order-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.order-header-label {
  color: #8c8c8c;
  flex-shrink: 0;
}

.order-header-no {
  font-weight: 600;
  color: #1f2937;
  flex-shrink: 0;
}

.order-header-divider {
  color: #d9d9d9;
  flex-shrink: 0;
}

.order-header-dealer {
  color: #595959;
  font-weight: 500;
  flex-shrink: 0;
}

.order-header-dealer-code {
  color: #9ca3af;
  font-size: 11px;
  flex-shrink: 0;
}

.order-header-logistics {
  color: #8c8c8c;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: 12px;
}

/* 订单卡片内容 */
.order-card-body {
  display: flex;
  background: #fff;
}

.order-body-left {
  flex: 1;
  min-width: 0;
}

.product-row {
  display: flex;
  align-items: center;
  padding: 10px 0;
  min-height: 68px;
}

.index-num {
  font-size: 13px;
  color: #8c8c8c;
  font-weight: 500;
}

/* 商品信息单元格 */
.goods-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.goods-img {
  width: 52px;
  height: 52px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.goods-img-real {
  width: 52px;
  height: 52px;
  border-radius: 6px;
  flex-shrink: 0;
}

.goods-img-text {
  color: #fff;
  font-size: 18px;
  font-weight: 700;
}

.goods-info {
  min-width: 0;
}

.goods-name {
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
  margin: 0 0 3px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.goods-sku {
  font-size: 12px;
  color: #9ca3af;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 单价数量 */
.price-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.price-value {
  font-size: 13px;
  color: #1f2937;
  font-weight: 500;
}

.price-qty {
  font-size: 12px;
  color: #9ca3af;
}

/* 右侧订单级信息 */
.order-body-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-left: 1px solid #f0f0f0;
}

.order-body-right .ot-col-amount,
.order-body-right .ot-col-time,
.order-body-right .ot-col-receiver,
.order-body-right .ot-col-status,
.order-body-right .ot-col-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 4px;
}

.status-logistics {
  font-size: 11px;
  color: #8c8c8c;
  margin-top: 4px;
}

.status-logistics-num {
  font-size: 11px;
  color: #8c8c8c;
  word-break: break-all;
  text-align: center;
  line-height: 1.3;
}

.amount-main {
  font-size: 14px;
  font-weight: 700;
  color: #f5222d;
  font-family: 'Inter', monospace;
}

.amount-sub {
  font-size: 11px;
  color: #9ca3af;
  margin: 3px 0 0;
}

.time-text {
  font-size: 12px;
  color: #595959;
  text-align: center;
  line-height: 1.5;
  word-break: break-all;
}

.receiver-name {
  font-size: 12px;
  color: #1f2937;
  text-align: center;
}

.receiver-phone {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 2px;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid #f0f0f0;
}

/* ==================== 订单详情抽屉 ==================== */

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
  margin-bottom: 20px;
  border-bottom: 1px solid #f0f0f0;
}

.detail-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-order-no {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
}

.detail-order-time {
  font-size: 13px;
  color: #9ca3af;
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section:last-of-type {
  margin-bottom: 0;
}

.detail-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.detail-grid-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 24px;
}

.detail-row {
  display: flex;
  align-items: baseline;
}

.detail-label {
  width: 72px;
  flex-shrink: 0;
  font-size: 13px;
  color: #9ca3af;
}

.detail-value {
  font-size: 13px;
  color: #1f2937;
  word-break: break-all;
}

.detail-goods-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.detail-goods-table th {
  background: #fafafa;
  font-weight: 600;
  color: #303133;
  text-align: center;
  padding: 8px 10px;
  border: 1px solid #ebeef5;
}

.detail-goods-table td {
  padding: 8px 10px;
  border: 1px solid #ebeef5;
  color: #303133;
}

.goods-name-cell {
  text-align: left;
}

.num-cell {
  text-align: center;
  font-family: 'Inter', monospace;
}

.highlight-num {
  font-weight: 600;
  color: #f5222d;
}

.detail-goods-table tfoot td {
  background: #fafafa;
  font-weight: 600;
}

.tfoot-label {
  text-align: right;
  padding-right: 16px;
}
</style>
