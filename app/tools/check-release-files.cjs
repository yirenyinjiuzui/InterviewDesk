const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '../release/win-unpacked/resources');
const archive = path.join(root, 'app.asar');
const allowed = new Set([
  'app.asar', 'elevate.exe', 'requirements-funasr.txt', 'requirements-moss.txt',
  'resources/test-image.png', 'resources/test-audio/asr-test-en.wav', 'resources/test-audio/asr-test-zh.wav',
  ...['tray.png', 'tray@2x.png', 'trayTemplate.png', 'trayTemplate@2x.png'].map(f => 'resources/tray/' + f),
  ...['funasr_device.py', 'funasr_stream_server.py', 'moss_asr_utils.py', 'moss_asr_server.py',
    'QuietCapture.exe', 'MouseSideButtons.exe'].map(f => 'tools/' + f),
]);
function visit(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (name === 'app.asar.unpacked') {
      assert.deepEqual(fs.readdirSync(path.join(dir, entry.name)), ['node_modules']);
      continue;
    }
    if (entry.isDirectory()) visit(path.join(dir, entry.name), name + '/');
    else assert(allowed.delete(name), 'Unexpected resource: ' + name);
  }
}
visit(root);
assert.equal(allowed.size, 0, 'Missing resources: ' + [...allowed].join(', '));
const files = asar.listPackage(archive).map(f => f.replaceAll('\\', '/').replace(/^\/+/, ''));
const manifest = JSON.parse(asar.extractFile(archive, 'out/build-manifest.json'));
const built = new Set(['package.json', 'out/build-manifest.json', ...manifest.files.map(f => f.path)]);
for (const name of files) {
  if (name === 'node_modules' || name.startsWith('node_modules/')) continue;
  if (asar.statFile(archive, path.normalize(name)).files) continue;
  assert(built.delete(name), 'Unexpected app file: ' + name);
}
assert.equal(built.size, 0, 'Missing app files: ' + [...built].join(', '));
for (const entry of manifest.files) {
  const data = asar.extractFile(archive, path.normalize(entry.path));
  assert.equal(require('node:crypto').createHash('sha256').update(data).digest('hex'), entry.sha256);
}
console.log('Packaged application bundles and resources match the build manifest and resource list.');
