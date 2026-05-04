<template>
  <div class="goods-manage-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Goods /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">仓库商品管理</h2>
          <p class="header-desc">管理所有仓库的商品库存、售价、货位及销售情况</p>
        </div>
      </div>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="选择仓库">
          <el-select v-model="filterForm.warehouse" placeholder="全部仓库" clearable style="width: 160px">
            <el-option label="杭州主仓库" value="杭州主仓库" />
            <el-option label="广州分仓" value="广州分仓" />
            <el-option label="成都分仓" value="成都分仓" />
          </el-select>
        </el-form-item>
        <el-form-item label="仓库商品ID">
          <el-input v-model="filterForm.id" placeholder="请输入商品ID" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="仓库商品名称">
          <el-input v-model="filterForm.name" placeholder="请输入商品名称" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item label="货位号">
          <el-input v-model="filterForm.location" placeholder="请输入货位号" clearable style="width: 140px" />
        </el-form-item>
        <el-form-item label="已触发预警">
          <el-switch v-model="filterForm.warningOnly" active-text="是" inactive-text="全部" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">
            <el-icon><Refresh /></el-icon>
            重置
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 数据表格 -->
    <el-card class="table-card" shadow="never">
      <template #header>
        <div class="table-header">
          <span>商品列表</span>
          <el-button type="primary" @click="handleAdd">
            <el-icon><Plus /></el-icon>
            新增商品
          </el-button>
        </div>
      </template>

      <el-table
        :data="filteredData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
      >
        <el-table-column prop="id" label="商品ID" width="110" align="center" />

        <el-table-column label="主图" width="80" align="center">
          <template #default="{ row }">
            <el-image
              :src="row.image"
              :preview-src-list="[row.image]"
              fit="cover"
              style="width: 50px; height: 50px; border-radius: 4px"
              :preview-teleported="true"
            />
          </template>
        </el-table-column>

        <el-table-column prop="name" label="商品名称" min-width="180" show-overflow-tooltip />

        <el-table-column prop="price" label="售价" width="100" align="right">
          <template #default="{ row }">
            <span style="color: #f56c6c; font-weight: 600">¥{{ row.price.toFixed(2) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="库存预警" width="110" align="center">
          <template #default="{ row }">
            <el-tag
              :type="isWarning(row) ? 'danger' : 'success'"
              size="small"
              effect="light"
            >
              {{ isWarning(row) ? '已预警' : '正常' }}
            </el-tag>
            <div class="warning-threshold">预警值: {{ row.stockWarning }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="currentStock" label="当前库存" width="100" align="center">
          <template #default="{ row }">
            <span :class="{ 'warning-text': isWarning(row) }">{{ row.currentStock }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="inTransit" label="运输中" width="90" align="center">
          <template #default="{ row }">
            <span style="color: #409eff">{{ row.inTransit }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="weekSales" label="近7日销售" width="100" align="center">
          <template #default="{ row }">
            <span style="color: #67c23a; font-weight: 500">{{ row.weekSales }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="warehouse" label="所属仓库" width="120" align="center" />

        <el-table-column prop="location" label="货位号" width="100" align="center">
          <template #default="{ row }">
            <el-tag type="info" size="small">{{ row.location }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="260" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleBindStore(row)">
              <el-icon><Link /></el-icon>
              绑定店铺
            </el-button>
            <el-button link type="success" size="small" @click="handlePurchase(row)">
              <el-icon><ShoppingCart /></el-icon>
              采购进货
            </el-button>
            <el-button link type="primary" size="small" @click="handleEdit(row)">
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
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
    </el-card>

    <!-- 编辑/新增商品弹窗 -->
    <el-dialog
      v-model="editVisible"
      :title="editTitle"
      width="580px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form
        ref="editFormRef"
        :model="editForm"
        :rules="editRules"
        label-width="100px"
      >
        <el-form-item label="商品名称" prop="name">
          <el-input v-model="editForm.name" placeholder="请输入商品名称" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="商品售价" prop="price">
          <el-input-number v-model="editForm.price" :min="0" :precision="2" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="所属仓库" prop="warehouse">
          <el-select v-model="editForm.warehouse" placeholder="请选择仓库" style="width: 200px">
            <el-option label="杭州主仓库" value="杭州主仓库" />
            <el-option label="广州分仓" value="广州分仓" />
            <el-option label="成都分仓" value="成都分仓" />
          </el-select>
        </el-form-item>
        <el-form-item label="货位号" prop="location">
          <el-input v-model="editForm.location" placeholder="如：A-01-03" style="width: 200px" />
        </el-form-item>
        <el-form-item label="库存预警值" prop="stockWarning">
          <el-input-number v-model="editForm.stockWarning" :min="0" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="当前库存" prop="currentStock">
          <el-input-number v-model="editForm.currentStock" :min="0" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="主图链接" prop="image">
          <el-input v-model="editForm.image" placeholder="请输入图片URL" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="handleEditSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 绑定店铺弹窗 -->
    <el-dialog
      v-model="bindVisible"
      title="绑定店铺"
      width="420px"
      align-center
      destroy-on-close
    >
      <p style="margin-bottom: 12px; color: #606266">
        正在为 <strong>{{ currentRow?.name }}</strong> 选择绑定店铺：
      </p>
      <el-select v-model="bindStoreId" placeholder="请选择店铺" style="width: 100%">
        <el-option label="优选好物旗舰店" value="store1" />
        <el-option label="数码潮流小店" value="store2" />
        <el-option label="家居生活馆" value="store3" />
        <el-option label="潮流服饰店" value="store4" />
      </el-select>
      <template #footer>
        <el-button @click="bindVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!bindStoreId" @click="handleBindSubmit">确定绑定</el-button>
      </template>
    </el-dialog>

    <!-- 采购进货弹窗 -->
    <el-dialog
      v-model="purchaseVisible"
      title="采购进货"
      width="480px"
      align-center
      destroy-on-close
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="商品名称">{{ currentRow?.name }}</el-descriptions-item>
        <el-descriptions-item label="当前库存">{{ currentRow?.currentStock }}</el-descriptions-item>
        <el-descriptions-item label="运输中数量">{{ currentRow?.inTransit }}</el-descriptions-item>
      </el-descriptions>
      <el-form style="margin-top: 16px" label-width="100px">
        <el-form-item label="采购数量">
          <el-input-number v-model="purchaseQty" :min="1" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="预计到货">
          <el-date-picker v-model="purchaseEta" type="date" placeholder="选择预计到货日期" style="width: 200px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="purchaseRemark" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="purchaseVisible = false">取消</el-button>
        <el-button type="primary" @click="handlePurchaseSubmit">确认采购</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import {
  Goods,
  Search,
  Refresh,
  Plus,
  Link,
  ShoppingCart,
  Edit
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const loading = ref(false)

// 筛选表单
const filterForm = reactive({
  warehouse: '',
  id: '',
  name: '',
  location: '',
  warningOnly: false
})

// 分页
const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 8
})

// 示例数据
const tableData = ref([
  {
    id: 'WSP001',
    image: 'https://picsum.photos/seed/goods1/100/100',
    name: '无线蓝牙耳机 Pro 降噪版 - 黑色',
    price: 199.00,
    stockWarning: 20,
    currentStock: 8,
    inTransit: 50,
    weekSales: 32,
    warehouse: '杭州主仓库',
    location: 'A-01-03'
  },
  {
    id: 'WSP002',
    image: 'https://picsum.photos/seed/goods2/100/100',
    name: '智能运动手环 X3 心率血氧监测 - 白色',
    price: 299.00,
    stockWarning: 15,
    currentStock: 45,
    inTransit: 0,
    weekSales: 18,
    warehouse: '杭州主仓库',
    location: 'A-02-01'
  },
  {
    id: 'WSP003',
    image: 'https://picsum.photos/seed/goods3/100/100',
    name: '20000mAh 超薄充电宝 双向快充',
    price: 89.90,
    stockWarning: 30,
    currentStock: 12,
    inTransit: 100,
    weekSales: 56,
    warehouse: '广州分仓',
    location: 'B-03-02'
  },
  {
    id: 'WSP004',
    image: 'https://picsum.photos/seed/goods4/100/100',
    name: '机械键盘 RGB背光 青轴 游戏办公',
    price: 359.00,
    stockWarning: 10,
    currentStock: 25,
    inTransit: 20,
    weekSales: 8,
    warehouse: '杭州主仓库',
    location: 'A-03-05'
  },
  {
    id: 'WSP005',
    image: 'https://picsum.photos/seed/goods5/100/100',
    name: '4K高清显示器 27英寸 IPS面板',
    price: 1299.00,
    stockWarning: 5,
    currentStock: 3,
    inTransit: 10,
    weekSales: 4,
    warehouse: '成都分仓',
    location: 'C-01-01'
  },
  {
    id: 'WSP006',
    image: 'https://picsum.photos/seed/goods6/100/100',
    name: 'Type-C 扩展坞 USB3.0 六合一',
    price: 128.00,
    stockWarning: 25,
    currentStock: 60,
    inTransit: 0,
    weekSales: 22,
    warehouse: '广州分仓',
    location: 'B-01-04'
  },
  {
    id: 'WSP007',
    image: 'https://picsum.photos/seed/goods7/100/100',
    name: '无线鼠标 静音办公 可充电',
    price: 59.00,
    stockWarning: 20,
    currentStock: 5,
    inTransit: 30,
    weekSales: 41,
    warehouse: '成都分仓',
    location: 'C-02-03'
  },
  {
    id: 'WSP008',
    image: 'https://picsum.photos/seed/goods8/100/100',
    name: '手机支架 桌面折叠 铝合金',
    price: 35.00,
    stockWarning: 50,
    currentStock: 120,
    inTransit: 0,
    weekSales: 65,
    warehouse: '杭州主仓库',
    location: 'A-04-02'
  }
])

// 判断是否触发预警
function isWarning(row) {
  return row.currentStock <= row.stockWarning
}

// 筛选后的数据
const filteredData = computed(() => {
  let data = tableData.value

  if (filterForm.warehouse) {
    data = data.filter(item => item.warehouse === filterForm.warehouse)
  }
  if (filterForm.id) {
    data = data.filter(item => item.id.toLowerCase().includes(filterForm.id.toLowerCase()))
  }
  if (filterForm.name) {
    data = data.filter(item => item.name.toLowerCase().includes(filterForm.name.toLowerCase()))
  }
  if (filterForm.location) {
    data = data.filter(item => item.location.toLowerCase().includes(filterForm.location.toLowerCase()))
  }
  if (filterForm.warningOnly) {
    data = data.filter(item => isWarning(item))
  }

  const start = (pageInfo.page - 1) * pageInfo.pageSize
  return data.slice(start, start + pageInfo.pageSize)
})

watch(filteredData, (val) => {
  // 从 computed 中移出，避免在 computed 内变异 reactive 状态
  // 重新计算符合条件的总条数
  let data = [...tableData.value]
  if (filterForm.warehouse) {
    data = data.filter(item => item.warehouse === filterForm.warehouse)
  }
  if (filterForm.id) {
    data = data.filter(item => String(item.id).includes(filterForm.id))
  }
  if (filterForm.name) {
    data = data.filter(item => item.name.toLowerCase().includes(filterForm.name.toLowerCase()))
  }
  if (filterForm.location) {
    data = data.filter(item => item.location.toLowerCase().includes(filterForm.location.toLowerCase()))
  }
  if (filterForm.warningOnly) {
    data = data.filter(item => isWarning(item))
  }
  pageInfo.total = data.length
})

function handleSearch() {
  pageInfo.page = 1
  loading.value = true
  setTimeout(() => { loading.value = false }, 300)
}

function handleReset() {
  filterForm.warehouse = ''
  filterForm.id = ''
  filterForm.name = ''
  filterForm.location = ''
  filterForm.warningOnly = false
  pageInfo.page = 1
  handleSearch()
}

function handleSizeChange(val) {
  pageInfo.pageSize = val
}

function handlePageChange(val) {
  pageInfo.page = val
}

// 编辑弹窗
const editVisible = ref(false)
const editTitle = ref('编辑商品')
const editFormRef = ref()
const isEditMode = ref(false)
const editForm = reactive({
  id: '',
  name: '',
  price: 0,
  warehouse: '',
  location: '',
  stockWarning: 0,
  currentStock: 0,
  image: ''
})

const editRules = {
  name: [{ required: true, message: '请输入商品名称', trigger: 'blur' }],
  price: [{ required: true, message: '请输入售价', trigger: 'blur' }],
  warehouse: [{ required: true, message: '请选择仓库', trigger: 'change' }],
  location: [{ required: true, message: '请输入货位号', trigger: 'blur' }],
  stockWarning: [{ required: true, message: '请输入预警值', trigger: 'blur' }],
  currentStock: [{ required: true, message: '请输入当前库存', trigger: 'blur' }]
}

function handleAdd() {
  isEditMode.value = false
  editTitle.value = '新增商品'
  editForm.id = 'WSP' + String(Date.now()).slice(-5)
  editForm.name = ''
  editForm.price = 0
  editForm.warehouse = ''
  editForm.location = ''
  editForm.stockWarning = 10
  editForm.currentStock = 0
  editForm.image = ''
  editVisible.value = true
}

function handleEdit(row) {
  isEditMode.value = true
  editTitle.value = '编辑商品'
  editForm.id = row.id
  editForm.name = row.name
  editForm.price = row.price
  editForm.warehouse = row.warehouse
  editForm.location = row.location
  editForm.stockWarning = row.stockWarning
  editForm.currentStock = row.currentStock
  editForm.image = row.image
  editVisible.value = true
}

function handleEditSubmit() {
  editFormRef.value.validate((valid) => {
    if (!valid) return

    if (isEditMode.value) {
      const item = tableData.value.find(i => i.id === editForm.id)
      if (item) {
        item.name = editForm.name
        item.price = editForm.price
        item.warehouse = editForm.warehouse
        item.location = editForm.location
        item.stockWarning = editForm.stockWarning
        item.currentStock = editForm.currentStock
        if (editForm.image) item.image = editForm.image
        ElMessage.success('修改成功')
      }
    } else {
      tableData.value.unshift({
        id: editForm.id,
        name: editForm.name,
        price: editForm.price,
        warehouse: editForm.warehouse,
        location: editForm.location,
        stockWarning: editForm.stockWarning,
        currentStock: editForm.currentStock,
        image: editForm.image || 'https://picsum.photos/seed/new/100/100',
        inTransit: 0,
        weekSales: 0
      })
      pageInfo.total = tableData.value.length
      ElMessage.success('新增成功')
    }
    editVisible.value = false
  })
}

// 绑定店铺
const bindVisible = ref(false)
const bindStoreId = ref('')
const currentRow = ref(null)

function handleBindStore(row) {
  currentRow.value = row
  bindStoreId.value = ''
  bindVisible.value = true
}

function handleBindSubmit() {
  const storeMap = {
    store1: '优选好物旗舰店',
    store2: '数码潮流小店',
    store3: '家居生活馆',
    store4: '潮流服饰店'
  }
  ElMessage.success(`已将「${currentRow.value.name}」绑定至 ${storeMap[bindStoreId.value]}`)
  bindVisible.value = false
}

// 采购进货
const purchaseVisible = ref(false)
const purchaseQty = ref(1)
const purchaseEta = ref('')
const purchaseRemark = ref('')

function handlePurchase(row) {
  currentRow.value = row
  purchaseQty.value = 1
  purchaseEta.value = ''
  purchaseRemark.value = ''
  purchaseVisible.value = true
}

function handlePurchaseSubmit() {
  if (currentRow.value) {
    currentRow.value.inTransit += purchaseQty.value
    ElMessage.success(`已为「${currentRow.value.name}」采购 ${purchaseQty.value} 件，运输中数量已更新`)
  }
  purchaseVisible.value = false
}
</script>

<style scoped>
.goods-manage-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶部标题卡片 */
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

/* 筛选卡片 */
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

/* 表格卡片 */
.table-card {
  border-radius: 12px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

/* 预警相关 */
.warning-text {
  color: #f56c6c;
  font-weight: 600;
}

.warning-threshold {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
