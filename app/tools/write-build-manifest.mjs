import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'out');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const files = [];
function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name !== 'build-manifest.json') {
      const content = readFileSync(path);
      files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
}
walk(output);
writeFileSync(resolve(output, 'build-manifest.json'), JSON.stringify({ version: pkg.version,
  compatibleVersions: ['0.2.0-beta.1', '0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4', '0.3.5', '0.3.6', '0.3.7'], dependencies: pkg.dependencies, files }, null, 2) + '\n');
