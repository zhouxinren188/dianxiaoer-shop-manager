/**
 * 测试当 response.data 是 JSON 字符串时的情况
 */

// 情况1: data 是字符串，解析后得到嵌套结构
const nestedInner = {
  "shopInfo_5113222887354003142": {
    "id": "5113222887354003142",
    "fields": { "tradeTitle": "卖家已发货" }
  },
  "orderStatus_5113222887354003142": {
    "id": "5113222887354003142",
    "fields": { "mailNo": "435156419889626", "cpCode": "YUNDA", "title": "运输中" }
  },
  "orderLogistics_5113222887354003142": {
    "id": "5113222887354003142",
    "fields": { "packagePreview": { "packageViewList": [{ "cpName": "韵达快递" }] } }
  }
}

// 模拟: response.data 是字符串 "{ \"data\": {...}, \"ret\": [...] }"
const responseStringNested = JSON.stringify({
  ret: ["SUCCESS::调用成功"],
  data: JSON.stringify(nestedInner)  // data 本身也是字符串
})

// 模拟: response.data 是字符串，直接是组件数据
const responseStringFlat = JSON.stringify({
  ret: ["SUCCESS::调用成功"],
  data: nestedInner  // data 是对象
})

console.log('=== 场景A: data 是嵌套字符串 ===')
const respA = JSON.parse(responseStringNested)
console.log('typeof response.data:', typeof respA.data)
console.log('response.data sample:', (typeof respA.data === 'string' ? respA.data : JSON.stringify(respA.data)).substring(0, 100))
if (typeof respA.data === 'string') {
  const parsedData = JSON.parse(respA.data)
  console.log('解析后 keys:', Object.keys(parsedData))
}

console.log()
console.log('=== 场景B: data 是对象（扁平） ===')
const respB = JSON.parse(responseStringFlat)
console.log('typeof response.data:', typeof respB.data)
console.log('response.data keys:', Object.keys(respB.data))

console.log()
console.log('=== 场景C: data 是对象（嵌套 data.data） ===')
const respC = { ret: ["SUCCESS::调用成功"], data: { data: nestedInner, ret: ["SUCCESS::调用成功"] } }
console.log('typeof response.data:', typeof respC.data)
console.log('response.data keys:', Object.keys(respC.data))
const dataC = respC.data
console.log('data.data keys:', Object.keys(dataC.data))
console.log('当前服务器代码会用 response.data，keys = ', Object.keys(dataC), ' -> 没有shopInfo_开头的key!')
