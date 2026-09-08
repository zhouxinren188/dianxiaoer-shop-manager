<template>
  <el-dialog
    :model-value="visible"
    :title="isEdit ? '编辑店铺' : '新增店铺'"
    width="600px"
    @close="handleClose"
    :close-on-click-modal="false"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
      <el-form-item label="店铺名称" prop="name">
        <el-input v-model="form.name" placeholder="请输入店铺名称" />
      </el-form-item>
      <el-form-item label="平台类型" prop="platform">
        <el-select v-model="form.platform" placeholder="请选择平台" style="width: 100%">
          <el-option label="淘宝" value="taobao" />
          <el-option label="天猫" value="tmall" />
          <el-option label="京东" value="jd" />
          <el-option label="拼多多" value="pdd" />
          <el-option label="抖音小店" value="douyin" />
        </el-select>
      </el-form-item>
      <el-form-item label="店铺类型" prop="store_type">
        <el-select v-model="form.store_type" placeholder="请选择店铺类型" style="width: 100%">
          <el-option label="POP店铺" value="pop" />
          <el-option label="供应商店铺" value="supplier" />
          <el-option label="代销店铺" value="consignment" />
        </el-select>
      </el-form-item>
      <el-form-item label="登录账号">
        <el-input v-model="form.account" placeholder="请输入登录账号" />
      </el-form-item>
      <el-form-item label="登录密码">
        <el-input v-model="form.password" type="password" show-password placeholder="请输入登录密码" />
      </el-form-item>
      <el-form-item label="商家ID">
        <el-input v-model="form.merchant_id" placeholder="请输入商家ID" />
      </el-form-item>
      <el-form-item label="店铺ID">
        <el-input v-model="form.shop_id" placeholder="请输入店铺ID" />
      </el-form-item>
      <el-form-item label="所属云仓">
        <el-select
          v-model="form.cloud_warehouse_id"
          placeholder="请选择该店铺使用的云仓"
          clearable
          filterable
          style="width: 100%"
        >
          <el-option
            v-for="warehouse in warehouseOptions"
            :key="warehouse.id"
            :label="warehouse.name"
            :value="Number(warehouse.id)"
            :disabled="warehouse.status === 'disabled'"
          >
            <span>{{ warehouse.name }}</span>
            <span class="warehouse-option-status">
              {{ warehouse.cloud_machine_code ? '已绑定机器' : '未绑定机器' }}
            </span>
          </el-option>
        </el-select>
        <div class="form-help">订单将根据所属云仓自动选择对应的云仓助手机器。</div>
      </el-form-item>
      <el-form-item label="店铺标签">
        <el-select
          ref="tagSelectRef"
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          collapse-tags
          collapse-tags-tooltip
          placeholder="选择或输入后回车添加标签"
          style="width: 100%"
          @change="onTagChange"
        >
          <el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" />
        </el-select>
      </el-form-item>
      <el-form-item label="经营状态">
        <el-radio-group v-model="form.status">
          <el-radio value="enabled">启用</el-radio>
          <el-radio value="disabled">停用</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { createStore, fetchStore, updateStore } from '@/api/store'

const props = defineProps({
  visible: { type: Boolean, default: false },
  storeData: { type: Object, default: null },
  tagOptions: { type: Array, default: () => [] },
  warehouseOptions: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:visible', 'saved'])

const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref(null)
const tagSelectRef = ref(null)

function onTagChange() {
  // 选择标签后自动收起下拉面板，避免遮挡底部按钮
  nextTick(() => {
    tagSelectRef.value?.blur()
  })
}

const form = reactive({
  name: '',
  platform: '',
  store_type: '',
  account: '',
  password: '',
  merchant_id: '',
  shop_id: '',
  cloud_warehouse_id: null,
  tags: [],
  status: 'enabled'
})

const rules = {
  name: [{ required: true, message: '请输入店铺名称', trigger: 'blur' }],
  platform: [{ required: true, message: '请选择平台类型', trigger: 'change' }]
}

watch(() => props.visible, (val) => {
  if (val) {
    if (props.storeData) {
      isEdit.value = true
      Object.assign(form, {
        name: props.storeData.name || '',
        platform: props.storeData.platform || '',
        store_type: props.storeData.store_type || '',
        account: props.storeData.account || '',
        password: props.storeData.password || '',
        merchant_id: props.storeData.merchant_id || '',
        shop_id: props.storeData.shop_id || '',
        cloud_warehouse_id: Number(props.storeData.cloud_warehouse_id || 0) || null,
        tags: Array.isArray(props.storeData.tags) ? [...props.storeData.tags] : [],
        status: props.storeData.status || 'enabled'
      })
    } else {
      isEdit.value = false
      Object.assign(form, {
        name: '', platform: '', store_type: '', account: '', password: '',
        merchant_id: '', shop_id: '', cloud_warehouse_id: null, tags: [], status: 'enabled'
      })
    }
    nextTick(() => formRef.value?.clearValidate())
  }
})

function handleClose() {
  emit('update:visible', false)
}

async function handleSubmit() {
  try {
    await formRef.value.validate()
  } catch {
    return
  }

  submitting.value = true
  try {
    const data = { ...form }
    if (isEdit.value) {
      await updateStore(props.storeData.id, data)
      await verifyCloudWarehouseSaved(props.storeData.id, data.cloud_warehouse_id)
      ElMessage.success('编辑成功')
    } else {
      const created = await createStore(data)
      if (created?.id) await verifyCloudWarehouseSaved(created.id, data.cloud_warehouse_id)
      ElMessage.success('新增成功')
    }
    emit('saved')
    handleClose()
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  } finally {
    submitting.value = false
  }
}

async function verifyCloudWarehouseSaved(storeId, expectedWarehouseId) {
  const saved = await fetchStore(storeId)
  const expected = Number(expectedWarehouseId || 0) || null
  const actual = Number(saved?.cloud_warehouse_id || 0) || null
  if (actual !== expected) {
    throw new Error('服务端未保存店铺所属云仓，请先升级业务服务后重试')
  }
}
</script>

<style scoped>
.warehouse-option-status {
  float: right;
  margin-left: 16px;
  color: #909399;
  font-size: 12px;
}

.form-help {
  margin-top: 6px;
  color: #909399;
  font-size: 12px;
  line-height: 1.5;
}
</style>
