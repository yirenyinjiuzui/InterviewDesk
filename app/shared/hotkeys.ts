export const HOTKEYS = [
  { id: 'hotkeyToggle', zh: '显示 / 隐藏窗口', en: 'Show / hide window', fallback: 'Control+B' },
  { id: 'hotkeyShot', zh: '截图问答', en: 'Screenshot question', fallback: 'Control+Shift+S' },
  { id: 'hotkeyClear', zh: '清空当前会话问答', en: 'Clear current answers', fallback: 'Control+Alt+Backspace' },
  { id: 'hotkeyStop', zh: '停止全部回答', en: 'Stop all answers', fallback: 'Control+Alt+S' },
  { id: 'hotkeyLeft', zh: '窗口向左', en: 'Move window left', fallback: 'Control+Alt+Left' },
  { id: 'hotkeyRight', zh: '窗口向右', en: 'Move window right', fallback: 'Control+Alt+Right' },
  { id: 'hotkeyUp', zh: '窗口向上', en: 'Move window up', fallback: 'Control+Alt+Up' },
  { id: 'hotkeyDown', zh: '窗口向下', en: 'Move window down', fallback: 'Control+Alt+Down' },
] as const;

export type HotkeyId = typeof HOTKEYS[number]['id'];
export type HotkeyConfig = Record<HotkeyId, string>;
export interface HotkeyStatus { id: HotkeyId; accelerator: string; registered: boolean }

export function resolveHotkeys(ui: Partial<HotkeyConfig>): HotkeyConfig {
  return Object.fromEntries(HOTKEYS.map((key) => [key.id, ui[key.id] ?? key.fallback])) as HotkeyConfig;
}

export function normalizeHotkey(value: string): string {
  const parts = value.trim().toLowerCase().split('+').map((part) => part.trim())
    .map((part) => ['ctrl', 'commandorcontrol', 'controlorcommand', 'cmdorctrl'].includes(part) ? 'control' : part === 'cmd' ? 'command' : part === 'option' ? 'alt' : part);
  return [...parts.slice(0, -1).sort(), parts.at(-1)].join('+');
}

export function validateHotkeys(config: HotkeyConfig): void {
  const seen = new Map<string, string>();
  for (const item of HOTKEYS) {
    const value = config[item.id].trim();
    if (!value) continue;
    const normalized = normalizeHotkey(value);
    if (normalized === 'alt+control+delete') throw new Error('Ctrl+Alt+Delete 是 Windows 保留组合键 / reserved by Windows');
    const parts = normalized.split('+');
    if (!parts.at(-1) || !parts.slice(0, -1).some((part) => ['control', 'command', 'alt', 'super'].includes(part))) {
      throw new Error(`${item.zh} / ${item.en}: 请包含 Ctrl、Alt 或 Command 修饰键`);
    }
    const previous = seen.get(normalized);
    if (previous) throw new Error(`快捷键重复 / Duplicate shortcut: ${previous} / ${item.zh} (${value})`);
    seen.set(normalized, item.zh);
  }
}
