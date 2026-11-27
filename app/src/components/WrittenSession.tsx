import { useEffect, useRef } from 'react';
import type { PublicSettings, StoredSession, StoredTurn } from '../../shared/protocol';
import { configuredVisionSlots, enabledVisionSlots, visionSlotIndex } from '../../shared/visionSlots';
import { useT } from '../i18n';

export function WrittenSession({ settings, sessions, current, notice, onSwitch, onNew, onShot, onClear, onCancel, onStop, onSettings }: {
  settings: PublicSettings;
  sessions: StoredSession[];
  current: StoredSession | null;
  notice: string | null;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onShot: () => Promise<void>;
  onClear: () => void;
  onCancel: (id: string) => void;
  onStop: () => void;
  onSettings: () => void;
}) {
  const t = useT();
  const zh = t.uiLang === 'zh';
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const turns = current?.turns ?? [];
  const groups = new Map<string, StoredTurn[]>();
  for (const turn of turns) {
    const id = turn.batchId ?? turn.id;
    groups.set(id, [...groups.get(id) ?? [], turn]);
  }
  const ready = enabledVisionSlots(settings.vision);
  const active = turns.some((turn) => turn.status === 'streaming');
  useEffect(() => {
    if (follow.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [turns]);

  return <section className="written-pane" aria-label={zh ? '笔试' : 'Written test'}>
    <div className="written-toolbar">
      <select className="session-select" aria-label={zh ? '笔试会话' : 'Written session'} value={current?.id ?? ''} onChange={(e) => onSwitch(e.target.value)}>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}
      </select>
      <button className="btn" onClick={onNew}>{zh ? '新建' : 'New'}</button>
      <button className="btn btn-primary written-capture" disabled={!current || ready.length === 0} onClick={() => void onShot()} title={settings.ui.hotkeyShot}>
        {zh ? '截图' : 'Screenshot'}
      </button>
      <button className="btn" onClick={onStop} title={settings.ui.hotkeyStop}>{zh ? '停止全部' : 'Stop all'}</button>
      <button className="btn" onClick={onClear} title={settings.ui.hotkeyClear}>{zh ? '清空' : 'Clear'}</button>
      <span className="written-status" role="status">{active ? (zh ? '生成中' : 'Generating') : (zh ? '就绪' : 'Ready')}</span>
    </div>
    <div className="written-models">
      {configuredVisionSlots(settings.vision).map(({ id, config }, index) => <span key={id} className={`turn-tag ${ready.some((slot) => slot.id === id) ? 'model-enabled' : ''}`}>
        {index + 1} · {config.model || (zh ? '未配置' : 'Not configured')}
        {config.model && !ready.some((slot) => slot.id === id) && ((config.enabled ?? id === 'vision') ? (zh ? ' · 待配置' : ' · Incomplete') : (zh ? ' · 未启用' : ' · Disabled'))}
      </span>)}
    </div>
    {notice && <div role="alert" className="kb-notice">{notice}</div>}
    {ready.length === 0 && <div className="kb-notice">
      {zh ? '请先在设置中配置并启用至少一个视觉接口。' : 'Configure and enable at least one vision interface in Settings.'}
      <button className="btn btn-sm" onClick={onSettings}>{zh ? '设置' : 'Settings'}</button>
    </div>}
    <div className="written-output" ref={box} onScroll={() => {
      const element = box.current;
      if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    }}>
      {turns.length === 0 && <div className="pane-empty">{zh ? '点击截图，已启用的视觉模型会分别在这里显示答案。' : 'Take a screenshot to see a separate answer from each enabled model.'}</div>}
      {Array.from(groups, ([id, answers], index) => <section className="written-batch" key={id}>
        <div className="written-batch-label">{zh ? '截图' : 'Screenshot'} {index + 1}</div>
        <div className="written-answer-grid">
          {answers.map((turn) => <article className="turn turn-vision" key={turn.id} data-model-slot={turn.visionSlot}>
            <div className="turn-head">
              <strong className="written-model-name">{turn.visionSlot ? `${visionSlotIndex(turn.visionSlot) + 1} · ` : ''}{turn.modelName || (zh ? '视觉模型' : 'Vision model')}</strong>
              <span className="turn-tag">{turn.status === 'streaming' ? (zh ? '生成中' : 'Generating') : turn.status === 'cancelled' ? (zh ? '已停止' : 'Stopped') : turn.status === 'error' ? (zh ? '失败' : 'Failed') : (zh ? '已完成' : 'Done')}</span>
              {turn.status === 'streaming'
                ? <button className="btn btn-sm" onClick={() => onCancel(turn.id)}>{zh ? '停止' : 'Stop'}</button>
                : <button className="btn btn-sm" disabled={!turn.text} onClick={() => void navigator.clipboard.writeText(turn.text)}>{zh ? '复制' : 'Copy'}</button>}
            </div>
            <div className="turn-body">{turn.status === 'error'
              ? <span className="answer-error">{turn.error}</span>
              : turn.text || (turn.status === 'cancelled' ? turn.error || (zh ? '已停止' : 'Stopped') : (zh ? '正在读取截图…' : 'Reading screenshot…'))}
              {turn.status === 'streaming' && <span className="cursor">▍</span>}
            </div>
          </article>)}
        </div>
      </section>)}
    </div>
  </section>;
}
