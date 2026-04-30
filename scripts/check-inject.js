const fs = require('fs');
const c = fs.readFileSync('C:/Users/Administrator/dianxiaoer-server/index.js', 'utf8');
console.log('contains sku-purchase-config:', c.includes('sku-purchase-config'));
