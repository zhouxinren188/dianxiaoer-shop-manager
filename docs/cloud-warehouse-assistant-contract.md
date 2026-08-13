# 店小二与云仓助手协作契约

状态：机器码绑定、关联销售订单定位和异常查询/处理参数已在店小二侧确定。执行器认证与中央任务传输 v1 路径及字段已形成供双方本地联调的固定契约；端点尚未实现并保持禁用，不开放注册、心跳、领取、续租、映射或回执网络访问。

## 1. 固定边界

本机执行端统一称为“云仓助手”。允许的业务命令只有：

- `exception.order.check`
- `exception.order.resolve`
- `warehouse.order.check`
- `warehouse.order.print`
- `warehouse.order.outbound`

禁止任意代码、脚本、Shell、模块路径、可执行文件或任意 URL 执行入口。`exception.order.check` 的 `params` 固定为空对象；`exception.order.resolve` 的 `params` 必须且只能包含 `exception_snapshot_ref`。其余三项业务接口未确认前，`params` 继续固定为空对象。

机器码格式：

```text
^YC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$
```

机器码仅是设备路由标识，不是密码或身份认证凭据。

异常查询、异常处理和到仓查询由中央服务路由到绑定机器码；打印和发货还必须确认该云仓助手在线、打印机可用且登录环境有效。中央传输在双方确认正式服务地址、认证方式和基础字段前保持硬禁用。

## 2. 主账号体系绑定

绑定单位是店小二主账号体系（租户），由一个主账号及其已授权子账号组成。主账号和子账号查询到同一份绑定；只有主账号或具备管理权限的管理员可以绑定、解除和换绑。

已实现的登录用户接口：

| 方法 | 相对路径 | 说明 |
|---|---|---|
| `GET` | `/api/cloud-warehouse/machine-binding` | 查询所属主账号体系的绑定、管理权限和云仓助手可用状态 |
| `PUT` | `/api/cloud-warehouse/machine-binding` | 主账号或管理员首次绑定/换绑，正文仅需 `machine_code` |
| `DELETE` | `/api/cloud-warehouse/machine-binding` | 主账号或管理员解除所属体系的绑定，重复解除按成功处理 |

绑定请求：

```json
{
  "machine_code": "YC-7F3K-92MX"
}
```

服务端只使用登录令牌确定实际操作人及其所属 `owner_id`，不允许页面提交或覆盖用户、主账号或租户标识。一个主账号体系只能有一个有效绑定；一个 `machine_code` 默认只能被一个主账号体系占用，数据库同时对 `owner_id` 和 `machine_code` 设置唯一约束。绑定审计分别记录所属主账号体系和实际操作用户。

## 3. 业务任务信封 v1.0

任务顶层字段严格限定为：

```json
{
  "protocol_version": "1.0",
  "task_id": "task_...",
  "trace_id": "wf_...",
  "command": "warehouse.order.check",
  "order_id": "ord_...",
  "idempotency_key": "idem_...",
  "created_at": "2026-08-12T12:00:00.000Z",
  "expires_at": "2026-08-12T12:10:00.000Z",
  "requested_by": {
    "actor_id": "123",
    "actor_type": "user",
    "display_name": "操作人"
  },
  "target": {
    "machine_code": "YC-7F3K-92MX"
  },
  "params": {}
}
```

写命令必须附加 `confirmation`，且 `action`与 `command`完全一致。`requested_by.actor_id`记录实际发起任务的登录用户；`confirmation.actor_id`记录实际确认人，二者均由中央服务根据认证会话写入，不能由页面冒充。只读任务最长10分钟，写任务最长2分钟。

`target.machine_code`只能由中央服务根据实际发起人所属的“主账号体系/租户 → machine_code”绑定填充。主账号、已授权子账号共用该路由；renderer 和其他调用方不得传入任务级目标机器码，`target`中也不增加主账号、子账号或租户字段。

`trace_id`在一个工作流中保持不变并等同于 `workflow_id`。每轮真实的30秒查询生成新的 `task_id`和 `idempotency_key`；同一个任务的网络重投复用原标识。

## 4. 异常订单定位与快照

### 4.1 中央订单定位

任务中的 `order_id` 继续使用中央服务生成的不透明 `order_ref_id`。中央服务内部映射为：

```text
order_ref_id -> purchase_order_id -> 关联 sales_order_id -> sales_orders.order_id + YEAR(sales_orders.order_time)
```

- 返回云仓助手的 `platform_order_no`固定取关联 `sales_orders.order_id`，用于真实异常接口的 `billexception.sellerBillNo`和`soExceptionCentre.spSoNo`查询。
- 返回云仓助手的 `order_year`固定取 `YEAR(sales_orders.order_time)`。
- `purchase_no`只保留在中央服务用于审计，不传云仓助手。
- 采购平台的 `purchase_orders.platform_order_no`不参与云仓异常查询。
- 禁止使用采购单 `created_at`、当前年份、采购平台下单时间或订单号格式推断年份，也不要求用户人工确认年份。
- 采购单关联的销售订单发生变化会递增定位版本；已有未完成工作流必须进入 `review_required`。

用户侧已实现：

| 方法 | 相对路径 | 说明 |
|---|---|---|
| `GET` | `/api/cloud-warehouse/orders/:purchaseOrderId/configuration` | 查询可见采购单的定位状态及最新脱敏异常结果 |
| `POST` | `/api/cloud-warehouse/orders/:purchaseOrderId/order-ref` | 定位字段就绪后生成或读取不透明订单引用 |

主账号只能解析本体系订单；子账号还必须通过现有采购账号授权或该采购单创建归属校验。执行器侧映射实现为受信任内部服务，并额外校验有效任务、租约状态、目标机器码、执行器实例、租户归属和定位版本。控制面认证未定稿前不挂载公网 HTTP 路由。

### 4.2 两项命令参数

异常查询：

```json
{}
```

异常处理：

```json
{
  "exception_snapshot_ref": "exsnap-..."
}
```

平台订单号和年份只通过受信任映射返回，不放入任务 `params`。异常处理不得附加内部异常 ID、平台订单号、年份或其他字段。

### 4.3 查询结果的页面字段

中央服务只接受并向页面投影以下脱敏结果字段：

```json
{
  "exception_snapshot_ref": "exsnap-...",
  "exception_count": 2,
  "queried_at": "ISO时间",
  "exceptions": [
    {
      "source": "billexception",
      "exception_type_masked": "脱敏异常类型",
      "reason_masked": "脱敏异常原因"
    }
  ]
}
```

`source`只允许 `billexception`或`soExceptionCentre`。中央服务不会把执行器结果中的未知字段、内部异常 ID、URL 或凭据转发到页面。页面展示全部脱敏异常及数量，只有存在有效快照且用户确认后才能创建处理任务。

## 5. 执行器认证与中央任务传输 v1

以下路径作为双方本地联调的固定契约，统一前缀为 `/api/cloud-warehouse/executor/v1`。当前代码仍保持传输硬禁用，不挂载这些网络端点；双方确认并完成实现后才启用。

### 5.1 认证与首次登记

机器码只用于路由，不是密码。主账号或管理员在已登录的店小二页面为已绑定机器码签发一次性登记码：

`POST /api/cloud-warehouse/machine-binding/enrollment`

请求正文为空对象，成功响应为：

```json
{
  "machine_code": "YC-7F3K-92MX",
  "enrollment_code": "一次性登记码",
  "expires_at": "ISO时间"
}
```

登记码使用256位随机数，服务端只保存哈希，10分钟过期且只能使用一次。云仓助手提交：

`POST /api/cloud-warehouse/executor/v1/enroll`

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "enrollment_code": "一次性登记码",
  "executor_instance_id": "本次进程实例标识",
  "executor_version": "版本号",
  "started_at": "ISO时间"
}
```

成功返回一次且仅一次的独立执行器凭据：

```json
{
  "credential_id": "execred_...",
  "client_id": "exec_...",
  "client_secret": "256位随机密钥",
  "machine_code": "YC-7F3K-92MX",
  "issued_at": "ISO时间"
}
```

云仓助手应把 `client_secret`保存在本机加密安全存储。机器码换绑、解除绑定或凭据吊销后，旧凭据和未完成租约立即失效。

云仓助手使用客户端凭据换取短期访问令牌：

`POST /api/cloud-warehouse/executor/v1/token`

```json
{
  "grant_type": "client_credentials",
  "client_id": "exec_...",
  "client_secret": "独立执行器密钥"
}
```

```json
{
  "access_token": "不透明随机令牌",
  "token_type": "Bearer",
  "expires_in": 900,
  "machine_code": "YC-7F3K-92MX"
}
```

除 `enroll`和`token`外的所有控制面请求必须通过 HTTPS，并携带 `Authorization: Bearer <access_token>`。访问令牌绑定 `credential_id + machine_code`，服务端仍逐次校验正文中的机器码和实例标识。Cookie、云仓账号、平台 Token、密码、Authorization 或 API Key 不得作为业务数据上传或写入日志。

### 5.2 心跳与能力上报

`POST /api/cloud-warehouse/executor/v1/heartbeat`

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "reported_at": "ISO时间",
  "status": "online",
  "executor_version": "版本号",
  "capabilities": {
    "exception.order.check": false,
    "exception.order.resolve": false,
    "warehouse.order.check": false,
    "warehouse.order.print": false,
    "warehouse.order.outbound": false
  },
  "readiness": {
    "printer_available": false,
    "login_environment_available": false
  },
  "active_task_count": 0,
  "last_failure_reason": "脱敏原因码或空字符串"
}
```

```json
{
  "accepted": true,
  "server_time": "ISO时间",
  "heartbeat_interval_seconds": 30,
  "offline_after_seconds": 90
}
```

未知能力按 `false`处理。同一机器码存在多个活跃实例时停止派发写任务并返回 `executor_instance_conflict`。

### 5.3 定向任务领取

`POST /api/cloud-warehouse/executor/v1/tasks/claim`

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "available_slots": 1,
  "wait_seconds": 25
}
```

中央服务只返回 `target.machine_code`与访问令牌及请求机器码完全一致的任务。租约放在任务信封外层，不改变任务允许的顶层字段：

```json
{
  "lease": {
    "lease_id": "lease_...",
    "fencing_token": 1,
    "expires_at": "ISO时间",
    "renew_after_seconds": 20
  },
  "task": {
    "protocol_version": "1.0",
    "task_id": "task_...",
    "trace_id": "wf_...",
    "command": "exception.order.check",
    "order_id": "ord_...",
    "idempotency_key": "idem_...",
    "created_at": "ISO时间",
    "expires_at": "ISO时间",
    "requested_by": {
      "actor_id": "123",
      "actor_type": "user",
      "display_name": "操作人"
    },
    "target": {
      "machine_code": "YC-7F3K-92MX"
    },
    "params": {}
  }
}
```

无任务时返回 `200 {"lease":null,"task":null,"retry_after_seconds":3}`。初始租约为60秒，不能超过任务 `expires_at`。

### 5.4 执行状态与租约续期

`POST /api/cloud-warehouse/executor/v1/tasks/:taskId/status`

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "lease_id": "lease_...",
  "fencing_token": 1,
  "status": "executing",
  "reported_at": "ISO时间"
}
```

成功响应：

```json
{
  "accepted": true,
  "task_id": "task_...",
  "status": "executing",
  "recorded_at": "ISO时间"
}
```

`POST /api/cloud-warehouse/executor/v1/tasks/:taskId/lease/renew`

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "lease_id": "lease_...",
  "fencing_token": 1,
  "requested_extension_seconds": 60
}
```

续租成功响应：

```json
{
  "lease_id": "lease_...",
  "fencing_token": 1,
  "expires_at": "ISO时间",
  "renew_after_seconds": 20
}
```

`fencing_token`保持当前租约值。租约重新分配时 fencing token 必须单调递增；旧 token 的状态、解析和结果请求全部拒绝。

### 5.5 受信任订单解析

只有已经领取且仍持有有效租约的执行器才能调用：

`POST /api/cloud-warehouse/executor/v1/tasks/:taskId/order-mapping`

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "lease_id": "lease_...",
  "fencing_token": 1,
  "order_id": "ord_..."
}
```

成功响应正文严格只有：

```json
{
  "platform_order_no": "3588401003348721",
  "order_year": 2026
}
```

服务端校验任务、租约、机器码、实例、租户归属、采购单与销售单关系及定位版本。`platform_order_no`固定来自 `sales_orders.order_id`，`order_year`固定来自 `YEAR(sales_orders.order_time)`。

### 5.6 结果回传

`POST /api/cloud-warehouse/executor/v1/tasks/:taskId/result`

请求外层携带租约，`response`内部保持云仓助手 v1.0 响应结构，不新增业务响应顶层字段：

```json
{
  "lease_id": "lease_...",
  "fencing_token": 1,
  "response": {
    "protocol_version": "1.0",
    "task_id": "task_...",
    "command": "exception.order.check",
    "order_id": "ord_...",
    "status": "succeeded",
    "reason": "business_state_confirmed",
    "message": "",
    "delivery": {
      "received": true,
      "executed": true,
      "business_confirmed": true
    },
    "result": {},
    "verification": {
      "confirmed": true,
      "observed_status": ""
    },
    "executor": {
      "device_id": "",
      "executor_instance_id": "实例标识"
    },
    "completed_at": "ISO时间"
  }
}
```

成功回执：

```json
{
  "accepted": true,
  "task_id": "task_...",
  "workflow_id": "wf_...",
  "workflow_state": "当前中央工作流状态",
  "recorded_at": "ISO时间",
  "replayed": false
}
```

中央服务复核任务、租约、幂等键、机器码、实例和状态组合。重复上传同一完整结果返回原回执并设置 `replayed: true`；同一任务上传不同结果返回 `idempotency_key_collision`并进入人工复核。写命令可信成功状态严格限定为：

- `exception.order.resolve` → `waiting_arrival`
- `warehouse.order.print` → `printed_unshipped`
- `warehouse.order.outbound` → `shipped`

`warehouse.order.outbound`只有在云仓助手回传 `status: succeeded`、`delivery.business_confirmed: true`、`verification.confirmed: true`且`verification.observed_status: shipped`全部成立后，中央服务才在同一事务中把对应采购单状态更新为 `forwarded`。其他任何响应均不得修改采购单状态，并进入 `review_required`。原有“我已转发”按钮是独立的人工兜底入口，不依赖云仓助手绑定或传输接口。

### 5.7 错误与重试

错误响应统一为：

```json
{
  "error": {
    "code": "lease_expired",
    "message": "脱敏说明",
    "retryable": false,
    "review_required": true
  }
}
```

固定控制面错误码包括：`invalid_request`、`invalid_protocol_version`、`unauthorized_executor`、`credential_revoked`、`machine_binding_missing`、`machine_binding_changed`、`machine_code_mismatch`、`executor_instance_conflict`、`capability_unavailable`、`task_not_found`、`task_expired`、`lease_mismatch`、`lease_expired`、`fencing_token_stale`、`order_mapping_forbidden`、`order_locator_changed`、`result_conflict`和`rate_limited`。

- `401`时允许刷新访问令牌后重放同一个传输请求一次。
- `429`、`502`、`503`、`504`按服务端 `Retry-After`或1、2、4、8、15秒退避并加入随机抖动。
- 同一任务的网络重投复用原 `task_id`、`idempotency_key`、`lease_id`和 fencing token。
- 只读任务允许在租约有效且业务结果确定未产生前进行传输重试；中央30秒调度的下一轮真实查询必须生成新 `task_id`和新 `idempotency_key`。
- 三个写命令不得自动业务重试。超时、断线、租约丢失、执行中断、结果未知或复验失败一律 `review_required`。

## 6. 尚未确认且明确不实现

- 到仓、打印和发货的实际接口及三个命令的 `params` Schema
- 执行器控制面网络端点在双方完成字段复核前保持禁用
- `requester_device_id`、`same_device_session_id`、`sameDeviceVerified`
- Named Pipe挑战、DPAPI设备签名或其他同机证明
