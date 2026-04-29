<template>
  <div class="store-shipment-page">
    <div class="page-header">
      <h2 class="page-title">供店发货</h2>
      <p class="page-desc">管理供货商向门店的发货记录与状态跟踪</p>
    </div>

    <el-card class="search-card">
      <el-form :model="searchForm" inline>
        <el-form-item label="供货商">
          <el-input v-model="searchForm.supplier" placeholder="请输入供货商名称" clearable />
        </el-form-item>
        <el-form-item label="门店">
          <el-input v-model="searchForm.store" placeholder="请输入门店名称" clearable />
        </el-form-item>
        <el-form-item label="发货状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
            <el-option label="待发货" value="pending" />
            <el-option label="已发货" value="shipped" />
            <el-option label="已签收" value="received" />
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
    </el-card>

    <el-card class="table-card">
      <template #header>
        <div class="table-header">
          <span>发货记录</span>
          <el-button type="primary" @click="handleAdd">
            <el-icon><Plus /></el-icon>
            新增发货
          </el-button>
        </div>
      </template>

      <el-table :data="tableData" stripe border>
        <el-table-column prop="id" label="发货单号" width="160" />
        <el-table-column prop="supplier" label="供货商" width="140" />
        <el-table-column prop="store" label="收货门店" width="140" />
        <el-table-column prop="goods" label="商品信息" min-width="200" />
        <el-table-column prop="quantity" label="数量" width="80" align="center" />
        <el-table-column prop="shipDate" label="发货日期" width="120" />
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleView(row)">查看</el-button>
            <el-button link type="primary" @click="handleEdit(row)">编辑</el-button>
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
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { Search, Plus } from '@element-plus/icons-vue'

const searchForm = reactive({
  supplier: '',
  store: '',
  status: ''
})

const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 3
})

const tableData = ref([
  {
    id: 'SH20260001',
    supplier: '优供货源',
    store: '北京朝阳店',
    goods: '无线蓝牙耳机 Pro - 黑色',
    quantity: 50,
    shipDate: '2026-04-28',
    status: 'shipped'
  },
  {
    id: 'SH20260002',
    supplier: '鑫盛商贸',
    store: '上海浦东店',
    goods: '智能手环 X3 - 白色',
    quantity: 30,
    shipDate: '2026-04-27',
    status: 'received'
  },
  {
    id: 'SH20260003',
    supplier: '优供货源',
    store: '广州天河店',
    goods: '便携式充电宝 20000mAh',
    quantity: 100,
    shipDate: '',
    status: 'pending'
  }
])

function statusType(status) {
  const map = {
    pending: 'warning',
    shipped: 'primary',
    received: 'success'
  }
  return map[status] || 'info'
}

function statusText(status) {
  const map = {
    pending: '待发货',
    shipped: '已发货',
    received: '已签收'
  }
  return map[status] || status
}

function handleSearch() {
  // TODO: 实现查询逻辑
}

function handleReset() {
  searchForm.supplier = ''
  searchForm.store = ''
  searchForm.status = ''
}

function handleAdd() {
  // TODO: 实现新增发货逻辑
}

function handleView(row) {
  // TODO: 实现查看详情逻辑
}

function handleEdit(row) {
  // TODO: 实现编辑逻辑
}

function handleSizeChange(val) {
  pageInfo.pageSize = val
}

function handlePageChange(val) {
  pageInfo.page = val
}
</script>

<style scoped>
.store-shipment-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  margin-bottom: 8px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: #1f2d3d;
  margin: 0 0 4px;
}

.page-desc {
  font-size: 13px;
  color: #909399;
  margin: 0;
}

.search-card {
  border-radius: 8px;
}

.table-card {
  border-radius: 8px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
