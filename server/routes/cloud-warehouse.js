const express = require('express')
const {
  assertMachineCode,
  canManageMachineBinding,
  getTenantOwnerId
} = require('../services/cloud-warehouse-protocol')
const {
  getOrderConfiguration
} = require('../services/cloud-warehouse-order-service')
const { createCloudWarehouseApiClient } = require('../services/cloud-warehouse-api-client')
const {
  attachExternalCommands,
  normalizeMachineStatus,
  queryMachineStatus,
  recordAutomaticRemarkLog,
  refreshCommandResult,
  refreshWarehouseOrderCheck,
  submitOrderCommand,
  submitOrderOutbound,
  submitOrderPrint,
  submitOrderReprint,
  submitWarehouseOrderChecksForOrders
} = require('../services/cloud-warehouse-third-party-service')

function ok(data) {
  return { code: 0, data }
}

function fail(message, reason) {
  const response = { code: 1, message }
  if (reason) response.reason = reason
  return response
}

function statusForError(error) {
  if (['purchase_order_not_found', 'cloud_command_not_found'].includes(error?.code)) return 404
  if (['machine_binding_forbidden'].includes(error?.code)) return 403
  if (['machine_code_in_use', 'workflow_task_active', 'precondition_not_met',
    'machine_binding_changed', 'order_locator_changed', 'machine_busy',
    'machine_selection_required', 'sales_order_store_missing',
    'store_cloud_warehouse_missing', 'cloud_warehouse_disabled',
    'warehouse_machine_binding_missing'].includes(error?.code)) return 409
  if (['machine_offline', 'capability_unavailable', 'login_environment_unavailable',
    'cloud_api_not_configured', 'cloud_api_unavailable', 'cloud_api_timeout'].includes(error?.code)) return 503
  if (['cloud_api_request_failed', 'cloud_api_invalid_response',
    'cloud_api_response_too_large'].includes(error?.code)) return 502
  if (error?.code) return 400
  return 500
}

function isCloudApiError(error) {
  return String(error?.code || '').startsWith('cloud_api_')
}

function cloudRefreshFailure(error) {
  return {
    reason: String(error?.code || 'cloud_api_unavailable').slice(0, 100),
    message: String(error?.message || '云仓助手状态查询暂时失败').slice(0, 500),
    httpStatus: Number(error?.httpStatus || 0) || null,
    occurredAt: new Date().toISOString()
  }
}

function formatBindingRow(row, canManage) {
  if (!row) return { bound: false, machineCode: '', assistant: null, canManage }
  return {
    bound: true,
    machineCode: row.machine_code,
    bindingVersion: Number(row.binding_version || 1),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
    canManage,
    // 在线状态改由云仓助手第三方服务查询；响应契约确认前不读取旧执行器心跳表。
    assistant: null
  }
}

async function readBinding(pool, ownerId, canManage) {
  const [rows] = await pool.execute(
    `SELECT machine_code, binding_version, bound_at, updated_at
       FROM cloud_machine_bindings
      WHERE owner_id = ?`,
    [ownerId]
  )
  return formatBindingRow(rows[0], canManage)
}

function assertEmptyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw Object.assign(new Error('请求体必须为空对象'), { code: 'invalid_request' })
  }
}

function assertWarehouseCheckBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('请求体格式错误'), { code: 'invalid_request' })
  }
  const keys = Object.keys(body)
  if (keys.some(key => key !== 'purchase_order_ids')) {
    throw Object.assign(new Error('云仓订单查询字段不合法'), { code: 'invalid_request' })
  }
  if (!Array.isArray(body.purchase_order_ids) || body.purchase_order_ids.length === 0) {
    throw Object.assign(new Error('purchase_order_ids 必须为非空数组'), { code: 'invalid_request' })
  }
}

function assertAutomaticRemarkLogBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('请求体格式错误'), { code: 'invalid_request' })
  }
  const keys = Object.keys(body)
  if (keys.some(key => !['success', 'message'].includes(key)) || typeof body.success !== 'boolean') {
    throw Object.assign(new Error('自动备注日志字段不合法'), { code: 'invalid_request' })
  }
  if (body.message !== undefined && typeof body.message !== 'string') {
    throw Object.assign(new Error('自动备注日志消息格式不合法'), { code: 'invalid_request' })
  }
}

module.exports = function createCloudWarehouseRouter(pool, options = {}) {
  const router = express.Router()
  const getApiClient = options.getApiClient || (() => createCloudWarehouseApiClient())

  router.get('/warehouses/:warehouseId/machine-status', async (req, res) => {
    try {
      const warehouseId = Number(req.params.warehouseId)
      if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
        return res.status(400).json(fail('仓库标识无效', 'invalid_request'))
      }
      const ownerId = getTenantOwnerId(req.user)
      const isMaster = req.user?.user_type === 'master'
      const [rows] = await pool.execute(
        `SELECT w.id, b.machine_code
           FROM warehouses w
           LEFT JOIN cloud_warehouse_machine_bindings b
             ON b.warehouse_id = w.id AND b.owner_id = w.owner_id
          WHERE w.id = ? AND w.owner_id = ?
            ${isMaster ? '' : 'AND EXISTS (SELECT 1 FROM user_warehouses uw WHERE uw.warehouse_id = w.id AND uw.user_id = ?)'}`,
        isMaster ? [warehouseId, ownerId] : [warehouseId, ownerId, Number(req.user.id)]
      )
      if (!rows.length) {
        return res.status(404).json(fail('仓库不存在或当前账号无权查看', 'warehouse_not_found'))
      }
      const machineCode = String(rows[0].machine_code || '').trim().toUpperCase()
      if (!machineCode) {
        return res.json(ok({ bound: false, machineCode: '', online: false, busy: false, status: 'unbound' }))
      }
      const status = normalizeMachineStatus(
        await getApiClient().getMachineStatus(assertMachineCode(machineCode)),
        machineCode
      )
      res.json(ok({ bound: true, ...status }))
    } catch (error) {
      console.error('[CloudWarehouse] 查询仓库机器状态失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '查询仓库机器状态失败', error.code))
    }
  })

  router.get('/machine-binding', async (req, res) => {
    try {
      const binding = await readBinding(pool, getTenantOwnerId(req.user), canManageMachineBinding(req.user))
      if (binding.bound) {
        try {
          binding.assistant = await queryMachineStatus(pool, getApiClient(), req.user)
        } catch (error) {
          console.warn('[CloudWarehouse] 在线状态查询失败', {
            code: error.code || 'cloud_api_unavailable',
            httpStatus: Number(error.httpStatus || 0) || undefined
          })
          binding.assistant = {
            online: false,
            busy: false,
            status: 'unavailable',
            capabilities: {},
            checkedAt: new Date().toISOString(),
            lastFailureReason: error.code || 'cloud_api_unavailable',
            lastFailureHttpStatus: Number(error.httpStatus || 0) || null
          }
        }
      }
      res.json(ok(binding))
    } catch (error) {
      console.error('[CloudWarehouse] 查询机器码绑定失败:', error.message)
      res.status(500).json(fail('查询机器码绑定失败'))
    }
  })

  router.put('/machine-binding', async (req, res) => {
    if (!canManageMachineBinding(req.user)) {
      return res.status(403).json(fail('只有主账号或管理员才能绑定和更换机器码', 'machine_binding_forbidden'))
    }
    let machineCode
    let ownerId
    try {
      machineCode = assertMachineCode(req.body?.machine_code)
      ownerId = getTenantOwnerId(req.user)
    } catch (error) {
      return res.status(400).json(fail(error.message, error.code))
    }

    const actorUserId = Number(req.user.id)
    let connection
    try {
      connection = await pool.getConnection()
      await connection.beginTransaction()

      const [currentRows] = await connection.execute(
        'SELECT machine_code, binding_version FROM cloud_machine_bindings WHERE owner_id = ? FOR UPDATE',
        [ownerId]
      )
      const current = currentRows[0] || null

      const [occupiedRows] = await connection.execute(
        'SELECT owner_id FROM cloud_machine_bindings WHERE machine_code = ? AND owner_id <> ? FOR UPDATE',
        [machineCode, ownerId]
      )
      if (occupiedRows.length > 0) {
        await connection.rollback()
        return res.status(409).json(fail('该机器码已被其他主账号体系绑定', 'machine_code_in_use'))
      }

      if (current?.machine_code === machineCode) {
        await connection.commit()
        return res.json(ok(await readBinding(pool, ownerId, true)))
      }

      const action = current ? 'rebind' : 'bind'
      const oldMachineCode = current?.machine_code || ''
      if (current) {
        await connection.execute(
          `UPDATE cloud_machine_bindings
              SET machine_code = ?, binding_version = binding_version + 1,
                  bound_by = ?, bound_at = NOW(3), updated_at = NOW(3)
            WHERE owner_id = ?`,
          [machineCode, actorUserId, ownerId]
        )
      } else {
        await connection.execute(
          `INSERT INTO cloud_machine_bindings
             (owner_id, machine_code, binding_version, bound_by, bound_at)
           VALUES (?, ?, 1, ?, NOW(3))`,
          [ownerId, machineCode, actorUserId]
        )
      }
      await connection.execute(
        `INSERT INTO cloud_machine_binding_audit
           (owner_id, actor_user_id, action, old_machine_code, new_machine_code)
         VALUES (?, ?, ?, ?, ?)`,
        [ownerId, actorUserId, action, oldMachineCode, machineCode]
      )
      await connection.commit()
      res.json(ok(await readBinding(pool, ownerId, true)))
    } catch (error) {
      if (connection) {
        try { await connection.rollback() } catch { /* ignore rollback failure */ }
      }
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json(fail('该机器码已被其他主账号体系绑定', 'machine_code_in_use'))
      }
      console.error('[CloudWarehouse] 保存机器码绑定失败:', error.message)
      res.status(500).json(fail('保存机器码绑定失败'))
    } finally {
      if (connection) connection.release()
    }
  })

  router.delete('/machine-binding', async (req, res) => {
    if (!canManageMachineBinding(req.user)) {
      return res.status(403).json(fail('只有主账号或管理员才能解除机器码绑定', 'machine_binding_forbidden'))
    }
    const actorUserId = Number(req.user.id)
    let ownerId
    try {
      ownerId = getTenantOwnerId(req.user)
    } catch (error) {
      return res.status(400).json(fail(error.message, error.code))
    }
    let connection
    try {
      connection = await pool.getConnection()
      await connection.beginTransaction()
      const [rows] = await connection.execute(
        'SELECT machine_code FROM cloud_machine_bindings WHERE owner_id = ? FOR UPDATE',
        [ownerId]
      )
      if (!rows.length) {
        await connection.commit()
        return res.json(ok({ bound: false, machineCode: '', assistant: null, canManage: true }))
      }
      const machineCode = rows[0].machine_code
      await connection.execute('DELETE FROM cloud_machine_bindings WHERE owner_id = ?', [ownerId])
      await connection.execute(
        `INSERT INTO cloud_machine_binding_audit
           (owner_id, actor_user_id, action, old_machine_code, new_machine_code)
         VALUES (?, ?, 'unbind', ?, '')`,
        [ownerId, actorUserId, machineCode]
      )
      await connection.commit()
      res.json(ok({ bound: false, machineCode: '', assistant: null, canManage: true }))
    } catch (error) {
      if (connection) {
        try { await connection.rollback() } catch { /* ignore rollback failure */ }
      }
      console.error('[CloudWarehouse] 解除机器码绑定失败:', error.message)
      res.status(500).json(fail('解除机器码绑定失败'))
    } finally {
      if (connection) connection.release()
    }
  })

  router.get('/orders/:purchaseOrderId/configuration', async (req, res) => {
    try {
      let config = await attachExternalCommands(
        pool,
        req.user,
        req.params.purchaseOrderId,
        await getOrderConfiguration(pool, req.user, req.params.purchaseOrderId)
      )
      const activeRequestId = config.workflow?.currentTask?.taskId
      if (activeRequestId) {
        try {
          await refreshCommandResult(pool, getApiClient(), req.user, activeRequestId)
          config = await attachExternalCommands(
            pool,
            req.user,
            req.params.purchaseOrderId,
            await getOrderConfiguration(pool, req.user, req.params.purchaseOrderId)
          )
        } catch (error) {
          if (!isCloudApiError(error)) throw error
          console.warn('[CloudWarehouse] 刷新云仓指令状态失败，保留已有配置', {
            code: error.code || 'cloud_api_unavailable',
            httpStatus: Number(error.httpStatus || 0) || undefined,
            requestId: activeRequestId
          })
          if (config.workflow) {
            config.workflow = {
              ...config.workflow,
              refreshFailure: cloudRefreshFailure(error)
            }
          }
        }
      }
      res.json(ok(config))
    } catch (error) {
      console.error('[CloudWarehouse] 查询订单云仓配置失败:', error.message)
      res.status(statusForError(error)).json(fail(error.message || '查询订单云仓配置失败', error.code))
    }
  })

  // 按当前页采购单逐笔核验是否已进入云仓。服务端负责解析关联销售订单号、
  // 订单年份和所属机器码，客户端不直接提交这些可被篡改的路由字段。
  router.post('/warehouse-orders/check', async (req, res) => {
    try {
      assertWarehouseCheckBody(req.body || {})
      res.json(ok(await submitWarehouseOrderChecksForOrders(pool, getApiClient(), {
        user: req.user,
        purchaseOrderIds: req.body.purchase_order_ids
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送云仓订单查询指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送云仓订单查询指令失败', error.code))
    }
  })

  // 只读取同一个查询指令的执行结果，不会再次创建 warehouse.order.check。
  router.get('/warehouse-orders/check/:requestId', async (req, res) => {
    try {
      res.json(ok(await refreshWarehouseOrderCheck(
        pool,
        getApiClient(),
        req.user,
        req.params.requestId
      )))
    } catch (error) {
      console.error('[CloudWarehouse] 刷新云仓订单查询结果失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '刷新云仓订单查询结果失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/exception/check', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderCommand(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId,
        command: 'exception.order.check'
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送异常查询指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送异常查询指令失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/exception/resolve', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderCommand(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId,
        command: 'exception.order.resolve'
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送异常处理指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送异常处理指令失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/print', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderPrint(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送订单打印指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送订单打印指令失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/outbound', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderOutbound(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送云仓发货指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送云仓发货指令失败', error.code))
    }
  })

  // 通道补打仍走云仓助手统一指令接口。202、提交超时和结果未知均由
  // cloud_external_commands 保留原 request_id，后续配置刷新只查询原请求。
  router.post('/orders/:purchaseOrderId/reprint', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderReprint(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送通道补打指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送通道补打指令失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/process-logs/auto-remark', async (req, res) => {
    try {
      assertAutomaticRemarkLogBody(req.body || {})
      res.json(ok(await recordAutomaticRemarkLog(pool, req.user, req.params.purchaseOrderId, req.body)))
    } catch (error) {
      console.error('[CloudWarehouse] 记录京东自动备注结果失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '记录京东自动备注结果失败', error.code))
    }
  })

  return router
}
