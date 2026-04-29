<template>
  <el-container class="app-layout">
    <el-aside width="240px" class="app-aside">
      <Sidebar />
    </el-aside>
    <el-container class="app-right">
      <div class="tab-bar">
        <div class="tab-bar-left">
          <div
            v-for="tab in visitedTabs"
            :key="tab.path"
            class="tab-item"
            :class="{ active: tab.path === route.path }"
            @click="router.push(tab.path)"
          >
            <span>{{ tab.title }}</span>
            <el-icon
              v-if="visitedTabs.length > 1"
              class="tab-close"
              :size="12"
              @click.stop="closeTab(tab)"
            >
              <Close />
            </el-icon>
          </div>
        </div>
        <div class="tab-bar-right">
          <div class="topbar-action">
            <el-badge :value="3" :max="99">
              <el-icon :size="18"><Bell /></el-icon>
            </el-badge>
          </div>
          <div class="topbar-action">
            <el-icon :size="18"><Search /></el-icon>
          </div>
          <div class="topbar-divider"></div>
          <span class="topbar-date">{{ currentDate }}</span>
        </div>
      </div>
      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Close, Bell, Search } from '@element-plus/icons-vue'
import Sidebar from './Sidebar.vue'

const route = useRoute()
const router = useRouter()

const visitedTabs = ref([
  { path: '/home', title: '首页' }
])

const currentDate = computed(() => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}年${month}月${day}日`
})

watch(
  () => route.path,
  (newPath) => {
    const exists = visitedTabs.value.find((t) => t.path === newPath)
    if (!exists && route.meta?.title) {
      visitedTabs.value.push({ path: newPath, title: route.meta.title })
    }
  },
  { immediate: true }
)

function closeTab(tab) {
  const index = visitedTabs.value.findIndex((t) => t.path === tab.path)
  if (index === -1) return
  visitedTabs.value.splice(index, 1)
  if (tab.path === route.path) {
    const next = visitedTabs.value[index] || visitedTabs.value[index - 1]
    if (next) router.push(next.path)
  }
}
</script>

<style scoped>
.app-layout {
  height: 100vh;
}

.app-aside {
  background-color: #001529;
  overflow: hidden;
}

.app-right {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tab-bar {
  height: 40px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  flex-shrink: 0;
}

.tab-bar-left {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
}

.tab-bar-left::-webkit-scrollbar {
  height: 0;
}

.tab-bar-right {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
  margin-left: 16px;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  color: #606266;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.tab-item:hover {
  background: #f5f7fa;
}

.tab-item.active {
  background: #e6f4ff;
  color: #1890ff;
  border-color: #91caff;
}

.tab-close {
  color: #909399;
  border-radius: 50%;
  transition: all 0.2s;
}

.tab-close:hover {
  color: #fff;
  background: #909399;
}

.topbar-action {
  cursor: pointer;
  color: #606266;
  display: flex;
  align-items: center;
  transition: color 0.2s;
}

.topbar-action:hover {
  color: #1890ff;
}

.topbar-divider {
  width: 1px;
  height: 16px;
  background: #e4e7ed;
}

.topbar-date {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.app-main {
  background-color: #f0f2f5;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}
</style>
