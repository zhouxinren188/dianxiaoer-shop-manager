const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = 3001;
const UPDATES_DIR = path.join(__dirname, 'public', 'updates');
const META_FILE = path.join(UPDATES_DIR, 'update-meta.json');
const ADMIN_PASSWORD = 'dianxiaoer2026';

if (!fs.existsSync(UPDATES_DIR)) fs.mkdirSync(UPDATES_DIR, { recursive: true });

const upload = multer({ dest: path.join(UPDATES_DIR, 'tmp') });

app.use(require('cors')());
app.use(express.static(path.join(__dirname, 'public')));

function readMeta() {
  try {
    if (fs.existsSync(META_FILE)) return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  } catch (e) {}
  return null;
}

function isNewerVersion(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

app.get('/health', (req, res) => res.json({ status: 'ok', app: 'dianxiaoer' }));

app.get('/api/update/check', (req, res) => {
  const v = req.query.version;
  if (!v) return res.json({ needUpdate: false });
  const meta = readMeta();
  if (!meta || !meta.version) return res.json({ needUpdate: false });
  res.json({
    needUpdate: isNewerVersion(meta.version, v),
    version: meta.version,
    size: meta.size || 0,
    changelog: meta.changelog || ''
  });
});

app.get('/api/update/download', (req, res) => {
  const meta = readMeta();
  if (!meta || !meta.filename) return res.status(404).json({ error: 'no update' });
  const fp = path.join(UPDATES_DIR, meta.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'file missing' });
  res.download(fp, meta.filename);
});

app.post('/api/update/upload', upload.single('file'), (req, res) => {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const version = req.body.version;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'bad version format' });
  }
  const filename = 'update-' + version + '.zip';
  const dest = path.join(UPDATES_DIR, filename);
  const old = readMeta();
  if (old && old.filename && old.filename !== filename) {
    const op = path.join(UPDATES_DIR, old.filename);
    if (fs.existsSync(op)) fs.unlinkSync(op);
  }
  fs.renameSync(req.file.path, dest);
  const stat = fs.statSync(dest);
  const meta = {
    version,
    changelog: req.body.changelog || '',
    filename,
    size: stat.size,
    uploadedAt: new Date().toISOString()
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  console.log('Hot update uploaded: v' + version + ' size: ' + (stat.size / 1024).toFixed(1) + 'KB');
  res.json({ success: true, version, size: stat.size });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('dianxiaoer update server running on port ' + PORT);
});
