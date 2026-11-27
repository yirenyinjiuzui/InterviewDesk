import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const fake = vi.hoisted(() => ({ children: [] as any[] }));
vi.mock('child_process', () => ({ spawn: vi.fn(() => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  fake.children.push(child); return child;
}) }));
import { MouseShortcuts } from '../electron/mouseShortcuts';

describe('mouse side button listener', () => {
  it('routes each button through current actions, updates without duplicate listeners, and releases on disable', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const execute = vi.fn();
    const listener = new MouseShortcuts('fixture', execute);
    listener.configure();
    expect(listener.status).toBe('off');
    listener.configure('hotkeyShot', 'hotkeyStop');
    const child = fake.children.at(-1);
    child.stdout.write('ready\n1\n2\n');
    expect(listener.status).toBe('ready');
    expect(execute.mock.calls).toEqual([['hotkeyShot'], ['hotkeyStop']]);
    listener.configure('', 'hotkeyToggle');
    child.stdout.write('1\n2\nunknown\n');
    expect(execute.mock.calls).toEqual([['hotkeyShot'], ['hotkeyStop'], ['hotkeyToggle']]);
    listener.configure();
    expect(child.stdin.writableEnded).toBe(true);
    child.stdout.write('2\n');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(listener.status).toBe('off');
    platform.mockRestore();
  });

  it('reports helper failure and can retry', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const listener = new MouseShortcuts('fixture', vi.fn());
    listener.configure('hotkeyShot');
    fake.children.at(-1).emit('error', new Error('missing helper'));
    expect(listener.status).toBe('failed');
    listener.configure('hotkeyShot');
    fake.children.at(-1).stdout.write('ready\n');
    expect(listener.status).toBe('ready');
    listener.stop(); platform.mockRestore();
  });
});
