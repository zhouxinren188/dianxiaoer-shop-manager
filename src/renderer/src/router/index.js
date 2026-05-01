import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/login/LoginPage.vue'),
    meta: { title: '登录' }
  },
  {
    path: '/',
    component: AppLayout,
    redirect: '/home',
    children: [
      {
        path: '/home',
        name: 'Home',
        component: () => import('@/views/home/HomePage.vue'),
        meta: { title: '首页' }
      },
      {
        path: '/sales/orders',
        name: 'SalesOrders',
        component: () => import('@/views/sales/OrderList.vue'),
        meta: { title: '订单列表' }
      },
      {
        path: '/aftersale/returns',
        name: 'AftersaleReturns',
        component: () => import('@/views/aftersale/ReturnExchange.vue'),
        meta: { title: '退换货管理' }
      },
      {
        path: '/purchase/orders',
        name: 'PurchaseOrders',
        component: () => import('@/views/purchase/PurchaseOrder.vue'),
        meta: { title: '采购订单' }
      },
      {
        path: '/warehouse/goods',
        name: 'WarehouseGoods',
        component: () => import('@/views/warehouse/GoodsManage.vue'),
        meta: { title: '商品管理' }
      },
      {
        path: '/warehouse/setting',
        name: 'WarehouseSetting',
        component: () => import('@/views/warehouse/WarehouseSetting.vue'),
        meta: { title: '设置仓库' }
      },
      {
        path: '/tasks/todo',
        name: 'TasksTodo',
        component: () => import('@/views/tasks/TodoTask.vue'),
        meta: { title: '代办任务' }
      },
      {
        path: '/supplier/store-shipment',
        name: 'StoreShipment',
        component: () => import('@/views/supplier/StoreShipment.vue'),
        meta: { title: '供店发货' }
      },
      {
        path: '/supplier/report',
        name: 'SupplierReport',
        component: () => import('@/views/supplier/SupplierReport.vue'),
        meta: { title: '报表' }
      },
      {
        path: '/supplier/store-sales-stats',
        name: 'StoreSalesStats',
        component: () => import('@/views/supplier/StoreSalesStats.vue'),
        meta: { title: '店铺销售统计' }
      },
      {
        path: '/user/center',
        name: 'UserCenter',
        component: () => import('@/views/user/UserCenter.vue'),
        meta: { title: '用户中心' }
      },
      {
        path: '/user/manage',
        name: 'UserManage',
        component: () => import('@/views/user/UserManage.vue'),
        meta: { title: '用户管理' }
      },
      {
        path: '/user/store-manage',
        name: 'StoreManage',
        component: () => import('@/views/user/StoreManage.vue'),
        meta: { title: '店铺管理' }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// 注意：不在这里清除 token，避免 Vite HMR 模块重加载时误清 token
// 应用启动的 token 验证逻辑由 beforeEach 导航守卫处理

router.beforeEach((to, from) => {
  const token = localStorage.getItem('accessToken')
  if (to.path !== '/login' && !token) {
    return '/login'
  }
})

// 导航失败诊断日志
router.afterEach((to, from, failure) => {
  if (failure) {
    console.warn('[Router] 导航失败:', failure.type, failure.message, `from=${from.path} to=${to.path}`)
  }
})

router.onError((error) => {
  console.error('[Router] 路由错误:', error)
})

export default router
