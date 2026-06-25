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
    path: '/subscription',
    name: 'Subscription',
    component: () => import('@/views/SubscriptionPage.vue'),
    meta: { title: '订阅' }
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
        meta: { title: '商家售后纠纷' }
      },
      {
        path: '/aftersale/purchase-refund',
        name: 'PurchaseRefund',
        component: () => import('@/views/aftersale/PurchaseRefund.vue'),
        meta: { title: '采购单退货退款' }
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
        redirect: '/report/store-sales'
      },
      {
        path: '/report/store-sales',
        name: 'StoreSalesReport',
        component: () => import('@/views/report/StoreSalesReport.vue'),
        meta: { title: '店铺销售报表' }
      },
      {
        path: '/report/product-sales',
        name: 'ProductSalesReport',
        component: () => import('@/views/report/ProductSalesReport.vue'),
        meta: { title: '商品销售报表' }
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

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('accessToken')
  if (to.path === '/login') {
    token ? next('/') : next()
  } else if (to.path === '/subscription') {
    // 订阅页需要登录后才能访问
    token ? next() : next('/login')
  } else {
    token ? next() : next('/login')
  }
})

export default router
