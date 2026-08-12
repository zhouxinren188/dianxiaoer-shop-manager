# 店小二与云仓助手协作契约

状态：机器码绑定接口已在店小二侧实现；执行器控制面仍为草案且保持禁用。正式服务地址、传输认证和双方基础字段确认前，不开放注册、心跳、领取、续租或回执端点，也不实现五个业务适配器。

## 1. 固定边界

本机执行端统一称为“云仓助手”。允许的业务命令只有：

- `exception.order.check`
- `exception.order.resolve`
- `warehouse.order.check`
- `warehouse.order.print`
- `warehouse.order.outbound`

禁止任意代码、脚本、Shell、模块路径、可执行文件或任意 URL 执行入口。实际业务接口未提供前，所有任务的 `params` 固定为空对象。

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

## 4. 执行器控制面草案

以下是双方仍需确认的基础数据契约。相对路径、正式服务地址和认证方式尚未生效。

### 4.1 注册

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "每次云仓助手启动生成的实例标识",
  "executor_version": "版本号",
  "started_at": "ISO时间",
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
  }
}
```

要求：

- `executor_instance_id`只用于心跳、租约和审计，不进入业务任务 `target`，也不由用户输入。
- 未知能力一律按 `false`处理。
- 同一机器码出现多个活跃实例时，中央服务不得派发写任务，直至冲突解除。
- 注册请求必须经过独立的控制面认证；机器码本身不能用于认证。

### 4.2 心跳和能力上报

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "reported_at": "ISO时间",
  "status": "online",
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

中央服务暂按最近90秒内存在有效心跳判断在线。正式间隔和离线阈值仍需双方确认。

### 4.3 任务领取

领取请求只声明执行器自己的身份和可用槽位：

```json
{
  "protocol_version": "1.0",
  "machine_code": "YC-7F3K-92MX",
  "executor_instance_id": "实例标识",
  "available_slots": 1
}
```

中央服务只能返回 `target.machine_code`完全相同的任务。建议领取响应使用外层租约，不修改业务任务允许的顶层字段：

```json
{
  "protocol_version": "1.0",
  "lease": {
    "lease_id": "lease_...",
    "fencing_token": 1,
    "expires_at": "ISO时间"
  },
  "task": {
    "protocol_version": "1.0",
    "task_id": "task_...",
    "trace_id": "wf_...",
    "command": "warehouse.order.check",
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

无任务时返回 `task: null`。领取和续租必须校验 `machine_code`、`executor_instance_id`、`lease_id`及单调递增的 `fencing_token`。

### 4.4 结果回传

结果沿用执行端协议，并建议回显 `trace_id`和 `idempotency_key`以便审计：

```json
{
  "protocol_version": "1.0",
  "task_id": "task_...",
  "trace_id": "wf_...",
  "idempotency_key": "idem_...",
  "command": "warehouse.order.print",
  "order_id": "ord_...",
  "status": "succeeded",
  "reason": "business_state_confirmed",
  "message": "",
  "delivery": {
    "received": true,
    "executed": true,
    "replayed": false,
    "business_confirmed": true
  },
  "result": {},
  "verification": {
    "confirmed": true,
    "observed_status": "printed_unshipped"
  },
  "executor": {
    "machine_code": "YC-7F3K-92MX",
    "executor_instance_id": "实例标识"
  },
  "completed_at": "ISO时间"
}
```

中央服务必须复核任务、租约、幂等键、机器码、实例和状态组合。写命令可信成功状态严格限定为：

- `exception.order.resolve` → `waiting_arrival`
- `warehouse.order.print` → `printed_unshipped`
- `warehouse.order.outbound` → `shipped`

不确定结果、租约丢失、执行中断、状态矛盾或复验失败一律进入 `review_required`，不得自动重复写操作。

## 5. 尚未确认且明确不实现

- 控制面正式服务地址和传输认证方式
- 实际异常查询、异常处理、到仓、打印和发货接口
- 采购单、采购编号、平台订单、店铺和云仓订单的字段映射
- 五个命令的 `params` Schema
- `requester_device_id`、`same_device_session_id`、`sameDeviceVerified`
- Named Pipe挑战、DPAPI设备签名或其他同机证明
