import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';
import type { HotkeyId } from '../shared/hotkeys';

export class MouseShortcuts {
  private child: ChildProcessWithoutNullStreams | null = null;
  private bindings: (HotkeyId | '')[] = ['', ''];
  status: 'off' | 'starting' | 'ready' | 'failed' = 'off';

  constructor(private readonly resourceRoot: string, private readonly execute: (action: HotkeyId) => void) {}

  configure(first: HotkeyId | '' = '', second: HotkeyId | '' = ''): void {
    this.bindings = [first, second];
    const mask = (first ? 1 : 0) | (second ? 2 : 0);
    if (process.platform !== 'win32' || !mask) { this.stop(); return; }
    if (this.child) { this.child.stdin.write(`${mask}\n`); return; }
    this.status = 'starting';
    const child = spawn(join(this.resourceRoot, 'tools', 'MouseSideButtons.exe'), [String(mask)], { windowsHide: true });
    this.child = child;
    const fail = () => { if (this.child === child) { this.child = null; this.status = 'failed'; child.kill(); } };
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child) return;
      if (line === 'ready') this.status = 'ready';
      else if (line === '1' || line === '2') {
        const action = this.bindings[Number(line) - 1];
        if (action) this.execute(action);
      }
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.status = 'off';
    child?.stdin.end(); // EOF exits the helper and releases the hook.
  }
}
