<template>
  <router-view />
  <AppUpdater />
</template>

<script setup>
import AppUpdater from './components/AppUpdater.vue'

// 应用启动时，将 localStorage 中已有的 token 同步到主进程
// 解决重启后主进程 authToken 丢失导致采购绑定 401 的问题
const savedToken = localStorage.getItem('accessToken')
if (savedToken) {
  window.electronAPI?.invoke('set-auth-token', savedToken).catch(() => {})
}
</script>
