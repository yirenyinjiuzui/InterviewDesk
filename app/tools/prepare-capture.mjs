import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../bin/QuietCapture.exe', import.meta.url));
const target = fileURLToPath(new URL('./QuietCapture.exe', import.meta.url));
if (!existsSync(source)) throw new Error('Build the native capture helper with the root build.cmd first.');
copyFileSync(source, target);

if (process.platform === 'win32') {
  execFileSync(join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/optimize+', '/codepage:65001', '/reference:System.Windows.Forms.dll',
    '/out:' + fileURLToPath(new URL('./MouseSideButtons.exe', import.meta.url)),
    fileURLToPath(new URL('../../src/MouseSideButtons.cs', import.meta.url)),
  ], { stdio: 'inherit' });
}
