<template>
  <el-container class="app-layout">
    <el-aside width="240px" class="app-aside">
      <Sidebar />
    </el-aside>
    <el-container class="app-right">
      <el-header class="app-header">
        <Topbar />
      </el-header>
      <div class="tab-bar">
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
      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Close } from '@element-plus/icons-vue'
import Sidebar from './Sidebar.vue'
import Topbar from './Topbar.vue'

const route = useRoute()
const router = useRouter()

const visitedTabs = ref([
  { path: '/home', title: '首页' }
])

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

.app-header {
  background-color: #fff;
  border-bottom: 1px solid #f0f0f0;
  padding: 0 24px;
  display: flex;
  align-items: center;
  height: 56px;
  flex-shrink: 0;
}

.tab-bar {
  height: 40px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 4px;
  overflow-x: auto;
  flex-shrink: 0;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
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

.app-main {
  background-color: #f0f2f5;
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}
</style>
