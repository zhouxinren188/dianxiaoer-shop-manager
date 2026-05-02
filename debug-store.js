/**
 * 店铺新增功能诊断脚本
 * 在浏览器控制台运行此脚本，帮助诊断问题
 */

(function() {
  console.log('=== 店小二店铺新增功能诊断 ===\n');

  // 1. 检查 electronAPI
  console.log('1. 检查 electronAPI...');
  if (!window.electronAPI) {
    console.error('❌ window.electronAPI 不存在');
    return;
  }
  console.log('✅ window.electronAPI 存在');

  // 2. 检查 token
  console.log('\n2. 检查认证 token...');
  const token = localStorage.getItem('accessToken');
  if (!token) {
    console.error('❌ 没有 access token，请先登录');
    return;
  }
  console.log('✅ token 存在:', token.substring(0, 20) + '...');

  // 3. 测试 3002 端口连接
  console.log('\n3. 测试业务 API (3002端口)...');
  fetch('http://150.158.54.108:3002/api/health', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(res => res.json())
  .then(data => {
    console.log('业务 API 响应:', data);
    if (data.code === 0) {
      console.log('✅ 业务 API 正常');
    } else {
      console.error('❌ 业务 API 错误:', data.message);
    }
  })
  .catch(err => {
    console.error('❌ 无法连接业务 API:', err.message);
  });

  // 4. 查询当前店铺列表
  console.log('\n4. 查询当前店铺列表...');
  fetch('http://150.158.54.108:3002/api/stores?page=1&pageSize=10', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(res => res.json())
  .then(data => {
    console.log('店铺列表响应:', data);
    if (data.code === 0) {
      console.log('✅ 当前有', data.data.total, '家店铺');
      console.log('店铺列表:', data.data.list);
    } else {
      console.error(' 查询店铺失败:', data.message);
    }
  })
  .catch(err => {
    console.error('❌ 查询店铺出错:', err.message);
  });

  // 5. 测试新增店铺
  console.log('\n5. 测试新增店铺...');
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(/[\/\s:]/g, '');

  fetch('http://150.158.54.108:3002/api/stores', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `诊断测试店铺${timeStr}`,
      platform: 'jd'
    })
  })
  .then(res => res.json())
  .then(data => {
    console.log('新增店铺响应:', data);
    if (data.code === 0) {
      console.log('✅ 店铺创建成功, ID:', data.data.id);
      // 再次查询列表确认
      setTimeout(() => {
        fetch('http://150.158.54.108:3002/api/stores?page=1&pageSize=10', {
          headers: { 'Authorization': `Bearer ${token}` }
        })
        .then(res => res.json())
        .then(listData => {
          console.log('新增后店铺列表:', listData);
        });
      }, 1000);
    } else {
      console.error('❌ 店铺创建失败:', data.message);
    }
  })
  .catch(err => {
    console.error('❌ 新增店铺出错:', err.message);
  });

  console.log('\n=== 诊断完成，请查看控制台输出 ===');
})();
