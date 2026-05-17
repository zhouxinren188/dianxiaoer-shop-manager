/**
 * bootstrap.js — 主进程引导加载器
 *
 * 作为 Electron 入口（package.json main 字段），加载编译后的主进程字节码。
 * 热更新仅支持 renderer，主进程始终加载内置版本。
 */

const { app } = require('electron')

function bootstrap() {
  if (!app.isPackaged) {
    // 开发模式：直接加载源码（electron-vite dev 使用原始源码）
    require('./index.js')
    return
  }

  // 生产模式：加载 bytenode + 编译后的字节码
  require('bytenode')
  module.exports = require('./index.jsc')
}

bootstrap()
