<template>
  <div class="page-container">
    <!-- 1. 筛选栏 + 功能区 -->
    <div class="filter-panel">
      <div class="filter-main">
        <div class="filter-grid">
          <div class="filter-item">
            <label class="filter-label">选择店铺</label>
            <el-select v-model="searchForm.storeId" filterable placeholder="请选择京东店铺">
              <el-option v-for="s in storeOptions" :key="s.id" :label="s.name" :value="s.id">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span>{{ s.name }}</span>
                  <el-tag v-if="s.online" type="success" size="small">在线</el-tag>
                </div>
              </el-option>
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">订单编号</label>
            <el-input v-model="searchForm.orderNo" placeholder="请输入站外订单编号" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">商品名称</label>
            <el-input v-model="searchForm.goodsName" placeholder="请输入关键词" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">发货单号</label>
            <el-input v-model="searchForm.outboundNo" placeholder="" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户姓名</label>
            <el-input v-model="searchForm.customerName" placeholder="请输入关键词" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户电话</label>
            <el-input v-model="searchForm.customerPhone" placeholder="请输入关键词" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">订单状态</label>
            <el-select v-model="searchForm.orderStatus" placeholder="请选择" clearable>
              <el-option v-for="s in orderStatusOptions" :key="s" :label="s" :value="s" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">问题事件</label>
            <el-select v-model="searchForm.issueEvent" placeholder="无筛选" clearable>
              <el-option v-for="e in issueEventOptions" :key="e" :label="e" :value="e" />
            </el-select>
          </div>
        </div>
      </div>

      <!-- 功能区（横向3列） -->
      <div class="func-panel">
        <div class="func-group">
          <div class="func-group-title">出库设置</div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">自动出库</span>
              <el-switch v-model="funcSettings.autoOutbound" @change="onFuncChange('autoOutbound', $event)" />
            </div>
            <p class="func-item-desc">(同步到物流的订单自动轨迹单出库)</p>
          </div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">大件物流</span>
              <el-switch v-model="funcSettings.largeLogistics" @change="onFuncChange('largeLogistics', $event)" />
            </div>
            <p class="func-item-desc">(不支持的物流将自动使用大件出库)</p>
          </div>
        </div>
        <div class="func-group">
          <div class="func-group-title">同步订单</div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">京东订单</span>
              <el-switch v-model="funcSettings.syncJdOrder" @change="onFuncChange('syncJdOrder', $event)" />
            </div>
            <p class="func-item-desc">(每10分钟，同步1次店铺订单信息及状态)</p>
          </div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">采购订单</span>
              <el-switch v-model="funcSettings.syncPurchaseOrder" @change="onFuncChange('syncPurchaseOrder', $event)" />
            </div>
            <p class="func-item-desc">(每60分钟，同步1次采购订单状态及物流)</p>
          </div>
        </div>
        <div class="func-group">
          <div class="func-group-title">拍单账号</div>
          <div class="func-btn-group">
            <el-button type="danger" size="small" @click="onFuncBtnClick('accountManage')">账号管理</el-button>
            <el-button size="small" @click="onFuncBtnClick('importAccount')">导入账号</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 操作栏 -->
    <div class="action-bar">
      <div class="action-left">
        <el-button class="action-btn action-btn-orange" @click="handleQueryOrders">
          <el-icon><Search /></el-icon>
          <span>查询订单</span>
        </el-button>
        <el-button class="action-btn action-btn-blue" @click="handleSyncOrders">
          <el-icon><Refresh /></el-icon>
          <span>同步订单</span>
        </el-button>
      </div>
      <div class="action-center">
        <span class="action-stat">出库即将超时订单数：<em class="stat-num">{{ nearTimeoutCount }}</em></span>
        <span class="action-stat">超时未出库订单数：<em class="stat-num">{{ timeoutCount }}</em></span>
      </div>
      <div class="action-right">
        <span class="action-right-label">拍单账号</span>
        <el-select v-model="selectedAccount" placeholder="请选择" size="small" style="width: 140px;">
          <el-option label="默认账号" value="default" />
          <el-option label="账号1" value="account1" />
          <el-option label="账号2" value="account2" />
        </el-select>
        <el-button class="action-btn action-btn-green" @click="handleTrackShip">
          <el-icon><Van /></el-icon>
          <span>轨迹发货</span>
        </el-button>
      </div>
    </div>

    <!-- 3. 状态统计栏 -->
    <div class="stats-bar">
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

    <!-- 4. 卡片式订单列表 -->
    <div class="table-card" v-loading="loading" element-loading-text="正在从京麦后台获取订单数据...">
      <!-- 表头 -->
      <div class="order-table-header">
        <div class="ot-col ot-col-check">
          <el-checkbox v-model="selectAll" @change="handleSelectAll" />
        </div>
        <div class="ot-col ot-col-index">序号</div>
        <div class="ot-col ot-col-goods">商品信息</div>
        <div class="ot-col ot-col-price">单价/数量</div>
        <div class="ot-col ot-col-amount">订单金额</div>
        <div class="ot-col ot-col-time">下单时间</div>
        <div class="ot-col ot-col-logistics">物流信息</div>
        <div class="ot-col ot-col-aftersale">售后信息</div>
        <div class="ot-col ot-col-action">操作</div>
      </div>

      <!-- 订单卡片列表 -->
      <div class="order-list" v-if="pagedOrders.length">
        <div
          class="order-card"
          v-for="(order, orderIdx) in pagedOrders"
          :key="order.id"
        >
          <!-- 订单卡片头部条 -->
          <div class="order-card-header">
            <div class="order-header-left">
              <el-checkbox v-model="order.selected" @change="handleOrderSelect" />
              <span class="order-header-label">订单编号:</span>
              <span class="order-header-no">{{ order.orderNo }}</span>
              <span class="order-header-divider">|</span>
              <span class="order-header-shop">{{ order.shopName }}</span>
              <el-tag size="small" :type="shopTagColorType(order.shopTag)" effect="plain" class="order-header-platform">{{ order.shopTag }}</el-tag>
              <span class="order-header-divider">|</span>
              <span v-if="order.buyerAccount" class="order-header-account">{{ order.buyerAccount }}</span>
              <el-icon v-if="order.buyerAccount" class="order-header-chat-icon" title="打开京麦咚咚聊天" @click.stop="handleOpenChat(order)"><ChatDotRound /></el-icon>
              <span class="order-header-buyer">{{ order.customerName }}</span>
              <span v-if="order.customerPhone" class="order-header-phone">{{ order.customerPhone }}</span>
              <span class="order-header-address">{{ order.address }}</span>
            </div>
            <div class="order-header-right">
              <el-tag :type="orderStatusTagType(order.orderStatus)" size="small">{{ order.orderStatus }}</el-tag>
              <el-tag v-if="order.purchaseStatus" :type="purchaseStatusTagType(order.purchaseStatus)" size="small" effect="plain">{{ order.purchaseStatus }}</el-tag>
            </div>
          </div>

          <!-- 订单卡片内容（商品行 + 订单信息） -->
          <div class="order-card-body">
            <!-- 左侧：商品行 -->
            <div class="order-body-left">
              <div
                class="product-row"
                v-for="(item, itemIdx) in order.items"
                :key="itemIdx"
                :class="{ 'product-row-border': itemIdx < order.items.length - 1 }"
              >
                <div class="ot-col ot-col-check"></div>
                <div class="ot-col ot-col-index">
                  <span v-if="itemIdx === 0" class="index-num">{{ (currentPage - 1) * pageSize + orderIdx + 1 }}</span>
                </div>
                <div class="ot-col ot-col-goods">
                  <div class="goods-cell">
                    <el-image
                      v-if="item.image"
                      class="goods-img"
                      :src="item.image"
                      :preview-src-list="[getOriginalImg(item.image)]"
                      fit="cover"
                      preview-teleported
                      hide-on-click-modal
                    />
                    <div v-else class="goods-img goods-img-placeholder" :style="{ background: item.imageColor }">
                      <span class="goods-img-text">{{ item.name.charAt(0) }}</span>
                    </div>
                    <div class="goods-info">
                      <p class="goods-name">{{ item.name }}</p>
                      <p class="goods-sku" v-if="item.sku">{{ item.sku }}</p>
                    </div>
                  </div>
                </div>
                <div class="ot-col ot-col-price">
                  <div class="price-cell">
                    <span class="price-value">¥{{ item.price.toFixed(2) }}</span>
                    <span class="price-qty">x {{ item.quantity }}</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧：订单级信息（纵向居中） -->
            <div class="order-body-right">
              <div class="ot-col ot-col-amount">
                <span class="amount-main">¥{{ order.actualAmount.toFixed(2) }}</span>
                <p class="amount-sub">含运费 ¥{{ order.shippingFee.toFixed(2) }}</p>
              </div>
              <div class="ot-col ot-col-time">
                <span class="time-text">{{ order.orderTime }}</span>
              </div>
              <div class="ot-col ot-col-logistics">
                <template v-if="order.logisticsCompany">
                  <p class="logistics-company">{{ order.logisticsCompany }}</p>
                  <p class="logistics-no">{{ order.logisticsNo }}</p>
                </template>
                <span v-else class="text-muted">--</span>
              </div>
              <div class="ot-col ot-col-aftersale">
                <el-tag v-if="order.issueEvent" type="warning" size="small">{{ order.issueEvent }}</el-tag>
                <span v-else class="text-muted">--</span>
              </div>
              <div class="ot-col ot-col-action">
                <el-button type="primary" link size="small" @click="handleView(order)">查看详情</el-button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <el-empty v-else description="暂无订单数据" style="padding: 60px 0;" />

      <!-- 分页 -->
      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </div>

    <!-- 5. 订单详情抽屉 -->
    <el-drawer v-model="drawerVisible" title="订单详情" size="640px" direction="rtl">
      <template v-if="currentOrder">
        <div class="detail-header">
          <div class="detail-header-left">
            <span class="detail-order-no">{{ currentOrder.orderNo }}</span>
            <el-tag :type="orderStatusTagType(currentOrder.orderStatus)" size="small">{{ currentOrder.orderStatus }}</el-tag>
            <el-tag v-if="currentOrder.purchaseStatus" :type="purchaseStatusTagType(currentOrder.purchaseStatus)" size="small" effect="plain">{{ currentOrder.purchaseStatus }}</el-tag>
          </div>
          <span class="detail-order-time">{{ currentOrder.orderTime }}</span>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">订单信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">出库单号</span><span class="detail-value">{{ currentOrder.outboundNo || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">店铺名称</span><span class="detail-value">{{ currentOrder.shopName }}</span></div>
            <div class="detail-row"><span class="detail-label">支付方式</span><span class="detail-value">{{ currentOrder.paymentMethod }}</span></div>
            <div class="detail-row"><span class="detail-label">客户名称</span><span class="detail-value">{{ currentOrder.customerName }}</span></div>
            <div class="detail-row"><span class="detail-label">买家账号</span><span class="detail-value">{{ currentOrder.buyerAccount || '--' }}</span></div>
          </div>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">商品信息</h4>
          <table class="detail-goods-table">
            <thead>
              <tr>
                <th>商品名称</th>
                <th>单价</th>
                <th>数量</th>
                <th>金额</th>
                <th>运费</th>
                <th>实付金额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, idx) in currentOrder.items" :key="idx">
                <td class="goods-name-cell">{{ item.name }}</td>
                <td class="num-cell">¥{{ item.price.toFixed(2) }}</td>
                <td class="num-cell">{{ item.quantity }}</td>
                <td class="num-cell">¥{{ (item.price * item.quantity).toFixed(2) }}</td>
                <td class="num-cell">¥{{ idx === 0 ? currentOrder.shippingFee.toFixed(2) : '0.00' }}</td>
                <td class="num-cell highlight-num">¥{{ idx === 0 ? currentOrder.actualAmount.toFixed(2) : '0.00' }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" class="tfoot-label">合计</td>
                <td class="num-cell">¥{{ currentOrder.amount.toFixed(2) }}</td>
                <td class="num-cell">¥{{ currentOrder.shippingFee.toFixed(2) }}</td>
                <td class="num-cell highlight-num">¥{{ currentOrder.actualAmount.toFixed(2) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">物流信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">物流公司</span><span class="detail-value">{{ currentOrder.logisticsCompany || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">物流单号</span><span class="detail-value">{{ currentOrder.logisticsNo || '--' }}</span></div>
          </div>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">收货信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">收货人</span><span class="detail-value">{{ currentOrder.receiver }}</span></div>
            <div class="detail-row"><span class="detail-label">联系电话</span><span class="detail-value">{{ currentOrder.customerPhone }}</span></div>
          </div>
          <div class="detail-row" style="margin-top: 8px;"><span class="detail-label">收货地址</span><span class="detail-value">{{ currentOrder.address }}</span></div>
        </div>

        <div v-if="currentOrder.issueEvent" class="detail-section">
          <h4 class="detail-section-title">问题事件</h4>
          <el-tag type="warning">{{ currentOrder.issueEvent }}</el-tag>
        </div>

        <div class="detail-footer">
          <el-button size="small" @click="onDetailAction('viewOriginal')">查看原单</el-button>
          <el-button size="small" @click="onDetailAction('contactBuyer')">联系买家</el-button>
          <el-button size="small" @click="onDetailAction('printInvoice')">打印发票</el-button>
          <el-button type="primary" size="small" @click="onDetailAction('confirmShip')">确认发货</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Search, Refresh, Goods, Van, ChatDotRound } from '@element-plus/icons-vue'
import { fetchStores } from '@/api/store'
import { fetchSalesOrders, saveSalesOrders } from '@/api/salesOrder'

// ==================== 筛选项配置 ====================

const orderStatusOptions = ['待付款', '待发货', '已发货', '已完成', '已取消']
const issueEventOptions = ['超时未发货', '库存不足', '物流异常', '客户拒收']

const AVATAR_COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#7986cb', '#f06292', '#aed581', '#ff8a65']

// ==================== 状态 ====================

const storeOptions = ref([])
const tableData = ref([])
const loading = ref(false)

const searchForm = reactive({
  storeId: '',
  orderNo: '',
  goodsName: '',
  outboundNo: '',
  customerName: '',
  customerPhone: '',
  orderStatus: '',
  issueEvent: ''
})

const activeStatus = ref('')
const currentPage = ref(1)
const pageSize = ref(20)
const selectAll = ref(false)
const selectedAccount = ref('default')

// ==================== 功能区 ====================

const funcSettings = reactive({
  autoOutbound: true,
  largeLogistics: true,
  syncJdOrder: true,
  syncPurchaseOrder: true
})

function onFuncChange(key, value) {
  console.log(`[功能区开关] ${key}: ${value}`)
}

function onFuncBtnClick(action) {
  console.log(`[功能区按钮] ${action}`)
}

// ==================== 数据加载 ====================

async function loadStores() {
  try {
    const data = await fetchStores({ platform: 'jd', status: 'enabled', pageSize: 100 })
    storeOptions.value = data.list || []
    const onlineStore = storeOptions.value.find(s => s.online === 1)
    if (onlineStore) {
      searchForm.storeId = onlineStore.id
    } else if (storeOptions.value.length > 0) {
      searchForm.storeId = storeOptions.value[0].id
    }
  } catch (err) {
    console.error('加载店铺列表失败:', err.message)
  }
}

function getSelectedStoreName() {
  const store = storeOptions.value.find(s => s.id === searchForm.storeId)
  return store ? store.name : ''
}

function getItemColor(name) {
  if (!name) return AVATAR_COLORS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getOriginalImg(url) {
  if (!url) return ''
  return url.replace(/\/n\d\//, '/n0/')
}

function mapServerOrder(row) {
  let items = []
  try {
    const parsed = typeof row.all_items === 'string' ? JSON.parse(row.all_items || 'null') : row.all_items
    if (Array.isArray(parsed)) {
      items = parsed.map(item => ({
        name: item.name || '',
        sku: item.skuId ? `SKU: ${item.skuId}` : '',
        price: parseFloat(item.price) || 0,
        quantity: item.quantity || 0,
        image: item.image || '',
        imageColor: getItemColor(item.name)
      }))
    }
  } catch {}

  if (items.length === 0 && row.product_name) {
    items = [{
      name: row.product_name,
      sku: row.sku_id ? `SKU: ${row.sku_id}` : '',
      price: parseFloat(row.unit_price) || 0,
      quantity: row.quantity || 0,
      image: row.product_image || '',
      imageColor: getItemColor(row.product_name)
    }]
  }

  let buyerAccount = ''
  try {
    const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data || 'null') : row.raw_data
    if (raw) buyerAccount = raw.buyerAccount || ''
  } catch {}

  return {
    id: row.id,
    selected: false,
    orderNo: row.order_id,
    orderStatus: row.status_text || '',
    purchaseStatus: '',
    orderTime: row.order_time || '',
    amount: parseFloat(row.goods_amount) || 0,
    shippingFee: parseFloat(row.shipping_fee) || 0,
    actualAmount: parseFloat(row.total_amount) || 0,
    paymentMethod: row.payment_method || '',
    customerName: row.buyer_name || '',
    receiver: row.buyer_name || '',
    customerPhone: row.buyer_phone || '',
    buyerAccount,
    address: row.buyer_address || '',
    logisticsCompany: row.logistics_company || '',
    logisticsNo: row.logistics_no || '',
    outboundNo: row.logistics_no || '',
    shopName: getSelectedStoreName(),
    shopTag: '京东',
    items,
    issueEvent: null,
    timeoutStatus: 'normal'
  }
}

async function loadOrdersFromServer() {
  if (!searchForm.storeId) return
  try {
    const data = await fetchSalesOrders({ store_id: searchForm.storeId, pageSize: 500 })
    const list = (data.list || []).map(mapServerOrder)
    tableData.value = list
  } catch (err) {
    console.warn('从服务器加载订单失败:', err.message)
  }
}

// ==================== 操作栏 ====================

function handleQueryOrders() {
  currentPage.value = 1
  loadOrdersFromServer()
}

async function handleSyncOrders() {
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
    const result = await window.electronAPI.invoke('fetch-sales-orders', {
      storeId: searchForm.storeId
    })

    if (result.success) {
      const orders = result.data.list || []
      if (orders.length === 0) {
        ElMessage.info('未获取到订单数据')
      } else {
        ElMessage.success(`成功获取 ${orders.length} 条订单，正在保存...`)
        try {
          await saveSalesOrders(searchForm.storeId, orders)
        } catch (saveErr) {
          console.warn('保存订单到服务器失败:', saveErr.message)
        }
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

function handleTrackShip() {
  console.log('[操作栏] 轨迹发货, 账号:', selectedAccount.value)
}

function handleOpenChat(order) {
  if (!order.buyerAccount) return
  const pin = encodeURIComponent(order.buyerAccount)
  const url = `https://im.jd.com/index?customerPin=${pin}`
  if (window.electronAPI) {
    window.electronAPI.invoke('open-external-url', { url })
  } else {
    window.open(url, '_blank')
  }
}

// ==================== 计算属性 ====================

const filteredOrders = computed(() => {
  return tableData.value.filter((order) => {
    if (searchForm.orderNo && !order.orderNo.includes(searchForm.orderNo)) return false
    if (searchForm.goodsName) {
      const hasGoods = order.items.some(item => item.name.includes(searchForm.goodsName))
      if (!hasGoods) return false
    }
    if (searchForm.outboundNo && !order.outboundNo.includes(searchForm.outboundNo)) return false
    if (searchForm.customerName && !order.customerName.includes(searchForm.customerName)) return false
    if (searchForm.customerPhone && !order.customerPhone.includes(searchForm.customerPhone)) return false
    if (searchForm.orderStatus && order.orderStatus !== searchForm.orderStatus) return false
    if (activeStatus.value && order.orderStatus !== activeStatus.value) return false
    return true
  })
})

const total = computed(() => filteredOrders.value.length)

const pagedOrders = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredOrders.value.slice(start, start + pageSize.value)
})

const statusTabs = computed(() => {
  const all = tableData.value.length
  const counts = {}
  for (const o of tableData.value) {
    if (o.orderStatus) {
      counts[o.orderStatus] = (counts[o.orderStatus] || 0) + 1
    }
  }
  return [
    { label: '全部', value: '', count: all },
    ...orderStatusOptions.map((s) => ({ label: s, value: s, count: counts[s] || 0 }))
  ]
})

const nearTimeoutCount = computed(() => tableData.value.filter((o) => o.timeoutStatus === 'nearTimeout').length)
const timeoutCount = computed(() => tableData.value.filter((o) => o.timeoutStatus === 'timeout').length)

// ==================== 选择功能 ====================

function handleSelectAll(val) {
  pagedOrders.value.forEach((order) => {
    order.selected = val
  })
}

function handleOrderSelect() {
  selectAll.value = pagedOrders.value.length > 0 && pagedOrders.value.every((o) => o.selected)
}

// ==================== 详情抽屉 ====================

const drawerVisible = ref(false)
const currentOrder = ref(null)

function handleView(row) {
  currentOrder.value = row
  drawerVisible.value = true
}

// ==================== 交互方法 ====================

function handleReset() {
  Object.assign(searchForm, {
    orderNo: '',
    goodsName: '',
    outboundNo: '',
    customerName: '',
    customerPhone: '',
    orderStatus: '',
    issueEvent: ''
  })
  activeStatus.value = ''
  currentPage.value = 1
}

function handleStatusClick(status) {
  activeStatus.value = status
  currentPage.value = 1
}

function handleSizeChange() {
  currentPage.value = 1
}

function handleCurrentChange() {}

function onDetailAction(action) {
  console.log(`[详情操作] ${action}`, currentOrder.value?.orderNo)
}

// ==================== Tag 类型映射 ====================

function orderStatusTagType(status) {
  const map = { '待付款': 'warning', '待发货': 'danger', '已发货': '', '已完成': 'success', '已取消': 'info' }
  return map[status] || ''
}

function purchaseStatusTagType(status) {
  const map = { '待采购': 'warning', '采购中': '', '已采购': 'success', '采购失败': 'danger' }
  return map[status] || ''
}

function shopTagColorType(tag) {
  const map = { '京东': 'danger', '天猫': '', '拼多多': 'warning', '抖音': 'success' }
  return map[tag] || ''
}

// ==================== 生命周期 ====================

watch(() => searchForm.storeId, (newId) => {
  if (newId) {
    activeStatus.value = ''
    currentPage.value = 1
    loadOrdersFromServer()
  } else {
    tableData.value = []
  }
})

onMounted(async () => {
  await loadStores()
})
</script>

<style scoped>
.page-container {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ==================== 筛选栏 + 功能区 ==================== */

.filter-panel {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  display: flex;
  overflow: hidden;
}

.filter-main {
  flex: 1;
  padding: 16px 20px;
  min-width: 0;
  border-right: 1px solid #f0f0f0;
}

.filter-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px 16px;
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

:deep(.filter-item .el-input),
:deep(.filter-item .el-select) {
  flex: 1;
  min-width: 0;
}

/* 功能区（横向3列） */
.func-panel {
  display: flex;
  gap: 24px;
  padding: 14px 20px;
  flex-shrink: 0;
}

.func-group {
  min-width: 0;
}

.func-group-title {
  font-size: 13px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 8px;
}

.func-item {
  margin-bottom: 6px;
}

.func-item:last-child {
  margin-bottom: 0;
}

.func-item-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.func-item-label {
  font-size: 12px;
  color: #303133;
  white-space: nowrap;
}

.func-item-desc {
  font-size: 11px;
  color: #9ca3af;
  margin: 2px 0 0;
  line-height: 1.3;
  white-space: nowrap;
}

.func-btn-group {
  display: flex;
  gap: 8px;
}

/* ==================== 操作栏 ==================== */

.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  gap: 16px;
}

.action-left {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}

.action-btn:hover {
  opacity: 0.9;
}

.action-btn-orange {
  background: #e67e22;
}

.action-btn-blue {
  background: #2196F3;
}

.action-btn-green {
  background: #52c41a;
}

.action-center {
  display: flex;
  gap: 20px;
  flex: 1;
  justify-content: center;
}

.action-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.action-right-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.action-stat {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.stat-num {
  font-style: normal;
  color: #f5222d;
  font-weight: 700;
  font-size: 15px;
}

/* ==================== 状态统计栏 ==================== */

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
.ot-col-check {
  width: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

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

.ot-col-logistics {
  width: 150px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-aftersale {
  width: 100px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-action {
  width: 90px;
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
  background: #f0f7f0;
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

.order-header-shop {
  color: #595959;
  font-weight: 500;
  flex-shrink: 0;
}

.order-header-platform {
  flex-shrink: 0;
}

.order-header-chat-icon {
  font-size: 15px;
  color: #2b5aed;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.2s;
}

.order-header-chat-icon:hover {
  color: #1a3fc7;
}

.order-header-account {
  color: #2b5aed;
  font-weight: 500;
  flex-shrink: 0;
}

.order-header-buyer {
  color: #1f2937;
  font-weight: 500;
  flex-shrink: 0;
}

.order-header-phone {
  color: #595959;
  flex-shrink: 0;
}

.order-header-address {
  color: #8c8c8c;
  font-size: 12px;
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

.product-row-border {
  border-bottom: 1px dashed #f0f0f0;
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
  flex-shrink: 0;
  object-fit: cover;
  cursor: pointer;
}

:deep(.goods-img .el-image__inner) {
  border-radius: 6px;
}

.goods-img-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
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
.order-body-right .ot-col-logistics,
.order-body-right .ot-col-aftersale,
.order-body-right .ot-col-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 4px;
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

.logistics-company {
  font-size: 12px;
  color: #1f2937;
  margin: 0;
  text-align: center;
}

.logistics-no {
  font-size: 11px;
  color: #2b5aed;
  margin: 2px 0 0;
  text-align: center;
  word-break: break-all;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text-muted {
  color: #d9d9d9;
  font-size: 13px;
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

.detail-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 20px;
  margin-top: 20px;
  border-top: 1px solid #f0f0f0;
}
</style>
