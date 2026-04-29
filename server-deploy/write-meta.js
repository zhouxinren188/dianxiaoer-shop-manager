var fs = require('fs');
var meta = {
  version: '1.0.1',
  changelog: 'v1.0.1 hot update',
  filename: 'update-1.0.1.zip',
  size: 560276,
  uploadedAt: '2026-04-29T20:35:00Z'
};
fs.writeFileSync('C:/dianxiaoer-server/public/updates/update-meta.json', JSON.stringify(meta, null, 2));
console.log('meta written ok');
