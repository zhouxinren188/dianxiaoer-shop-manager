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

      <!-- 任务中心 分组 -->
      <div class="menu-group-title">任务中心</div>
      <el-menu-item index="/tasks/todo" @click="navigate('/tasks/todo')">
        <el-icon><Ticket /></el-icon>
        <span>代办任务</span>
      </el-menu-item>

      <!-- 用户中心 分组 -->
      <div class="menu-group-title">用户中心</div>
      <el-menu-item index="/user/center" @click="navigate('/user/center')">
        <el-icon><User /></el-icon>
        <span>用户中心</span>
      </el-menu-item>
    </el-menu>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Shop,
  HomeFilled,
  List,
  Service,
  RefreshLeft,
  Document,
  Goods,
  Ticket,
  User
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()

const activeMenu = computed(() => route.path)

function navigate(path) {
  router.push(path)
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
  background: #1890ff;
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
  background-color: #1890ff !important;
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
