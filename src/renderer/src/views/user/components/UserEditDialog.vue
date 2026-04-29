<template>
  <el-dialog
    v-model="visible"
    :title="isEdit ? '编辑用户' : '新增子账号'"
    width="520px"
    :close-on-click-modal="false"
    @closed="handleClosed"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
      style="padding-right: 20px;"
    >
      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="请输入用户名" :disabled="isEdit" />
      </el-form-item>
      <el-form-item label="真实姓名" prop="realName">
        <el-input v-model="form.realName" placeholder="请输入真实姓名" />
      </el-form-item>
      <el-form-item label="手机号" prop="phone">
        <el-input v-model="form.phone" placeholder="请输入手机号" maxlength="11" />
      </el-form-item>
      <el-form-item label="密码" prop="password" v-if="!isEdit">
        <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password />
      </el-form-item>
      <el-form-item label="账号类型" prop="userType">
        <el-radio-group v-model="form.userType" :disabled="isEdit">
          <el-radio label="master">主账号</el-radio>
          <el-radio label="sub">子账号</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="角色" prop="role">
        <el-select v-model="form.role" placeholder="请选择角色" style="width: 100%;">
          <el-option label="超级管理员" value="super_admin" />
          <el-option label="管理员" value="admin" />
          <el-option label="普通员工" value="staff" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-radio-group v-model="form.status">
          <el-radio label="enabled">启用</el-radio>
          <el-radio label="disabled">停用</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { createUser, updateUser } from '@/api/user'

const props = defineProps({
  visible: Boolean,
  userData: Object,
  currentUser: Object
})
const emit = defineEmits(['update:visible', 'saved'])

const visible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
})

const isEdit = computed(() => !!props.userData)

const formRef = ref()
const submitting = ref(false)

const form = ref({
  username: '',
  realName: '',
  phone: '',
  password: '',
  userType: 'sub',
  role: 'staff',
  status: 'enabled'
})

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' }
  ],
  realName: [
    { required: true, message: '请输入真实姓名', trigger: 'blur' }
  ],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' }
  ],
  userType: [
    { required: true, message: '请选择账号类型', trigger: 'change' }
  ],
  role: [
    { required: true, message: '请选择角色', trigger: 'change' }
  ]
}

watch(() => props.userData, (val) => {
  if (val) {
    form.value = {
      username: val.username || '',
      realName: val.realName || '',
      phone: val.phone || '',
      password: '',
      userType: val.userType || 'sub',
      role: val.role || 'staff',
      status: val.status || 'enabled'
    }
  } else {
    form.value = {
      username: '',
      realName: '',
      phone: '',
      password: '',
      userType: 'sub',
      role: 'staff',
      status: 'enabled'
    }
  }
}, { immediate: true })

async function handleSubmit() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  // 校验：只有主账号/超级管理员才能创建主账号
  if (!isEdit.value && form.value.userType === 'master') {
    const cur = props.currentUser || {}
    if (cur.userType !== 'master' && cur.role !== 'super_admin') {
      ElMessage.warning('只有主账号或超级管理员才能创建主账号')
      return
    }
  }

  submitting.value = true
  try {
    if (isEdit.value) {
      const { password, ...data } = form.value
      await updateUser(props.userData.id, data)
      ElMessage.success('修改成功')
    } else {
      await createUser(form.value)
      ElMessage.success('新增成功')
    }
    visible.value = false
    emit('saved')
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  } finally {
    submitting.value = false
  }
}

function handleClosed() {
  formRef.value?.resetFields()
}
</script>
