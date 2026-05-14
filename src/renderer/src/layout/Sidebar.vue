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
      <el-sub-menu index="store-report">
        <template #title>
          <el-icon><TrendCharts /></el-icon>
          <span>店铺报表</span>
        </template>
        <el-menu-item index="/report/store-sales">
          <el-icon><TrendCharts /></el-icon>
          <span>店铺销售报表</span>
        </el-menu-item>
        <el-menu-item index="/report/product-sales">
          <el-icon><Goods /></el-icon>
          <span>商品销售报表</span>
        </el-menu-item>
      </el-sub-menu>
      <el-sub-menu index="aftersale">
        <template #title>
          <el-icon><Service /></el-icon>
          <span>售后管理</span>
        </template>
        <el-menu-item index="/aftersale/returns">
          <el-icon><RefreshLeft /></el-icon>
          <span>商家售后纠纷</span>
        </el-menu-item>
        <el-menu-item index="/aftersale/purchase-refund">
          <el-icon><Money /></el-icon>
          <span>采购单退货退款</span>
        </el-menu-item>
      </el-sub-menu>

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
    </el-menu>

    <!-- 版本号 -->
    <div class="sidebar-version">v{{ appVersion }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
  Setting,
  TrendCharts,
  Money
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

const appVersion = __APP_VERSION__

function onMenuSelect(index) {
  if (route.path === index) return

  router.push(index).then(failure => {
    if (failure) {
      console.warn('[Navigate] 导航未完成:', failure.type, failure.message)
    }
  }).catch(err => {
    console.error('[Navigate] 路由跳转失败:', err)
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

.sidebar-version {
  padding: 12px 20px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  text-align: center;
  letter-spacing: 1px;
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
</style>