# 云仓订单全量查询与待打印核验契约

更新时间：2026-09-02

## 1. 业务规则

- 店小二采购单在异常处理成功后先进入本地状态 `pending_print`。
- 用户进入待打印页面不会自动查询。
- 用户点击页面顶部“查询”时，店小二正常刷新当前采购单列表，并额外创建一次
  `warehouse.order.check`。
- 一次查询不携带单个订单号、年份或订单数组。云仓助手返回当前查询结果后，店小二和
  小程序使用关联销售订单号匹配本地待打印采购单。
- 查询结果轮询只读取同一个 `request_id`，不创建新的业务查询。
- 云仓结果明确允许打印前，打印按钮必须保持禁用。

## 2. 店小二调用云仓助手

店小二仍调用云仓助手第三方服务的统一命令接口：

`POST /api/cloud-warehouse/v1/commands`

请求体严格为：

```json
{
  "request_id": "UUID",
  "machine_code": "YC-XXXX-XXXX",
  "command": "warehouse.order.check"
}
```

不得增加 `order_no`、`order_year`、`orders`、用户 Token、Cookie 或账号密码。

若异步受理，返回 HTTP 202：

```json
{
  "request_id": "UUID",
  "command": "warehouse.order.check",
  "status": "accepted"
}
```

店小二随后使用原 `request_id` 查询：

`GET /api/cloud-warehouse/v1/commands/:requestId`

最终成功返回 HTTP 200：

```json
{
  "request_id": "UUID",
  "command": "warehouse.order.check",
  "status": "completed",
  "completed_at": "2026-09-02T08:00:00.000Z",
  "response": {
    "status": "succeeded",
    "reason": "query_completed",
    "message": "云仓订单查询完成",
    "result": {
      "queried_at": "2026-09-02T08:00:00.000Z",
      "orders": [
        {
          "order_no": "京东销售订单号",
          "status": "pending_print",
          "logistics_no": "运单号",
          "logistics_company": "物流公司",
          "printable": true
        }
      ]
    }
  }
}
```

字段要求：

- `order_no`：关联销售订单号，用于与采购单的 `sales_order_no` 匹配。
- `status`：云仓真实订单状态。
- `logistics_no`：云仓返回的运单号，没有时传空字符串。
- `logistics_company`：可选。
- `printable`：建议明确返回布尔值。未返回时，店小二只把
  `pending_print`、`waiting_print`、`ready_to_print`、`待打印`、`待打单`
  识别为可打印。
- 云仓助手机器状态接口必须上报能力
  `"warehouse.order.check": true`，否则店小二拒绝发送该命令。

## 3. 小程序调用店小二服务端

两个接口都需要：

`Authorization: Bearer <token>`

### 3.1 创建一次云仓订单查询

`POST /api/cloud-warehouse/warehouse-orders/check`

请求体：

```json
{}
```

请求中不要传订单号、订单 ID、年份、机器码或订单数组。

### 3.2 读取同一次查询的结果

`GET /api/cloud-warehouse/warehouse-orders/check/:requestId`

返回数据：

```json
{
  "code": 0,
  "data": {
    "requestId": "UUID",
    "transportStatus": "completed",
    "status": "succeeded",
    "final": true,
    "reason": "query_completed",
    "message": "云仓订单查询完成",
    "resultShapeValid": true,
    "queriedAt": "2026-09-02T08:00:00.000Z",
    "orders": [
      {
        "orderNo": "京东销售订单号",
        "status": "pending_print",
        "logisticsNo": "运单号",
        "logisticsCompany": "物流公司",
        "printable": true
      }
    ]
  }
}
```

小程序处理方式：

1. 先加载本地 `status=pending_print` 的采购订单。
2. 用户点击“查询”后调用 POST，只调用一次。
3. 若 `final=false`，使用返回的同一个 `requestId` 调用 GET，不能再次 POST。
4. 使用 `orders[].orderNo` 匹配采购订单的 `sales_order_no`。
5. 只有匹配项 `printable=true` 时才启用该订单的打印按钮。
6. 未匹配、查询失败、结果未完成或 `resultShapeValid=false` 时，打印按钮保持禁用。
