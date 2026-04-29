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
        <div class="tab-bar-drag"></div>
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
          <div class="topbar-divider"></div>
          <div class="win-controls">
            <div class="win-btn" @click="handleMinimize">
              <el-icon :size="14"><Minus /></el-icon>
            </div>
            <div class="win-btn" @click="handleMaximize">
              <el-icon :size="14"><FullScreen /></el-icon>
            </div>
            <div class="win-btn win-btn-close" @click="handleClose">
              <el-icon :size="14"><Close /></el-icon>
            </div>
          </div>
        </div>
      </div>
      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, watch, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Close, Bell, Search, Minus, FullScreen } from '@element-plus/icons-vue'
import Sidebar from './Sidebar.vue'

const route = useRoute()
const router = useRouter()

// 进入主界面时切换到大窗口尺寸
onMounted(() => {
  window.electronAPI?.invoke('window-set-main-size')
})

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

function handleMinimize() {
  window.electronAPI?.invoke('window-minimize')
}

function handleMaximize() {
  window.electronAPI?.invoke('window-maximize')
}

function handleClose() {
  window.electronAPI?.invoke('window-close')
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
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
}

.tab-bar-left {
  display: flex;
  align-items: flex-end;
  gap: 0;
  overflow-x: auto;
  padding: 0 8px;
}

.tab-bar-left::-webkit-scrollbar {
  height: 0;
}

/* 中间空白区域可拖拽移动窗口 */
.tab-bar-drag {
  flex: 1;
  -webkit-app-region: drag;
}

.tab-bar-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  padding: 0 0 0 16px;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  font-size: 12px;
  color: #606266;
  cursor: pointer;
  white-space: nowrap;
  border: none;
  transition: all 0.2s;
  height: 32px;
  background: transparent;
}

.tab-item:hover {
  color: #1890ff;
}

.tab-item.active {
  color: #1890ff;
  font-weight: 500;
  border-bottom: 2px solid #1890ff;
}

.tab-close {
  color: #c0c4cc;
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

/* 窗口控制按钮 */
.win-controls {
  display: flex;
  align-items: stretch;
  height: 100%;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  cursor: pointer;
  color: #606266;
  transition: all 0.15s;
}

.win-btn:hover {
  background: #f0f0f0;
  color: #303133;
}

.win-btn-close:hover {
  background: #e81123;
  color: #fff;
}

.app-main {
  background-color: #f0f2f5;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}
</style>
