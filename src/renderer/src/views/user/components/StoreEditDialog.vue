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
      <el-form-item label="店铺标签">
        <el-select
          v-model="form.tags"
          multiple
          filterable
          allow-create
          default-first-option
          placeholder="输入后回车添加标签"
          style="width: 100%"
        />
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
import { createStore, updateStore } from '@/api/store'

const props = defineProps({
  visible: { type: Boolean, default: false },
  storeData: { type: Object, default: null }
})

const emit = defineEmits(['update:visible', 'saved'])

const isEdit = ref(false)
const submitting = ref(false)
const formRef = ref(null)

const form = reactive({
  name: '',
  platform: '',
  account: '',
  password: '',
  merchant_id: '',
  shop_id: '',
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
        account: props.storeData.account || '',
        password: props.storeData.password || '',
        merchant_id: props.storeData.merchant_id || '',
        shop_id: props.storeData.shop_id || '',
        tags: Array.isArray(props.storeData.tags) ? [...props.storeData.tags] : [],
        status: props.storeData.status || 'enabled'
      })
    } else {
      isEdit.value = false
      Object.assign(form, {
        name: '', platform: '', account: '', password: '',
        merchant_id: '', shop_id: '', tags: [], status: 'enabled'
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
      ElMessage.success('编辑成功')
    } else {
      await createStore(data)
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
</script>
