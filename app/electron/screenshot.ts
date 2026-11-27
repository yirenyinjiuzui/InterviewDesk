import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export async function captureQuietScreenshot(resourceRoot: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'meeting-copilot-shot-'));
  const file = join(directory, 'screen.png');
  try {
    await new Promise<void>((resolve, reject) => execFile(join(resourceRoot, 'tools', 'QuietCapture.exe'),
      ['--capture-once', file], { windowsHide: true, timeout: 15000 }, (error) => error ? reject(error) : resolve()));
    return 'data:image/png;base64,' + (await fs.readFile(file)).toString('base64');
  } finally {
    await fs.rm(file, { force: true });
    await fs.rmdir(directory);
  }
}

/** Only identical image/question/material/session combinations within 700 ms. */
export function createScreenshotGate(now = Date.now) {
  const recent = new Map<string, number>();
  const accept = (image: string, question: string, background: string, sessionId: string): boolean => {
    const time = now();
    for (const [key, at] of recent) if (time - at >= 700) recent.delete(key);
    const signature = createHash('sha256').update(JSON.stringify([image, question, background, sessionId])).digest('hex');
    if (recent.has(signature)) return false;
    recent.set(signature, time);
    return true;
  };
  return Object.assign(accept, { clear: () => recent.clear() });
}
