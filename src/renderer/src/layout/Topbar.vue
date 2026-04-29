<template>
  <div class="topbar">
    <div class="topbar-left">
      <el-breadcrumb separator="/">
        <el-breadcrumb-item
          v-for="item in breadcrumbs"
          :key="item.path"
          :to="item.path"
        >
          {{ item.title }}
        </el-breadcrumb-item>
      </el-breadcrumb>
    </div>
    <div class="topbar-right">
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
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Bell, Search } from '@element-plus/icons-vue'

const route = useRoute()

const breadcrumbs = computed(() => {
  const matched = route.matched.filter((r) => r.meta && r.meta.title)
  return matched.map((r) => ({
    path: r.path,
    title: r.meta.title
  }))
})

const currentDate = computed(() => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}年${month}月${day}日`
})
</script>

<style scoped>
.topbar {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.topbar-action {
  cursor: pointer;
  color: #606266;
  display: flex;
  align-items: center;
  transition: color 0.2s;
}

.topbar-action:hover {
  color: #2b5aed;
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
</style>
