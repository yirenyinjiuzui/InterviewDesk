import { durationText, measuredMs } from '../../shared/latency';
import { useEffect, useRef, useState } from 'react';
import type { RewriteStyle, StoredScript, StoredSession, StoredTurn } from '../../shared/protocol';
import { useT } from '../i18n';

export type TurnKind = 'segment' | 'continuous' | 'free' | 'translate' | 'vision';

export type AnswerTurn = StoredTurn;

/**
 * 智能体 conversation panel (R4) with a multi-session bar. Answers ACCUMULATE
 * as a scrolling session (never replaced); each meeting is its own session
 * with its own knowledge base. The 📷 screenshot button only appears in
 * multimodal mode (it needs a vision model).
 */
export function AnswerSession({
  sessions,
  currentId,
  turns,
  scripts,
  showChineseQuestion,
  onShowChineseQuestion,
  onTranslateQuestion,
  onRewrite,
  onPinTurn,
  onAddScript,
  onToggleScript,
  onRemoveScript,
  currentQuestion,
  questionEditing,
  onEditQuestion,
  onAnswerQuestion,
  resumeChars,
  notice,
  visionReady,
  answersReady,
  answersHint,
  onSwitch,
  onNew,
  onOpenLibrary,
  onDelete,
  onRename,
  onCancel,
  onClear,
  onFreeAsk,
  onShotAsk,
  clearShortcut,
  stopShortcut,
}: {
  sessions: StoredSession[];
  currentId: string;
  turns: AnswerTurn[];
  scripts: StoredScript[];
  showChineseQuestion: boolean;
  onShowChineseQuestion: (show: boolean) => void;
  onTranslateQuestion: (turn: AnswerTurn) => void;
  onRewrite: (turn: AnswerTurn, style: RewriteStyle) => void;
  onPinTurn: (turn: AnswerTurn) => void;
  onAddScript: (title: string, text: string) => void;
  onToggleScript: (id: string) => void;
  onRemoveScript: (id: string) => void;
  currentQuestion: string;
  questionEditing: boolean;
  onEditQuestion: (text: string) => void;
  onAnswerQuestion: () => void;
  resumeChars: number;
  /** transient parse warning (e.g. scanned PDF with no text layer) */
  notice?: string | null;
  visionReady: boolean;
  /** false = no LLM configured; asking is disabled with an explanation */
  answersReady: boolean;
  answersHint: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onOpenLibrary: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onCancel: (id: string) => void;
  onClear: () => void;
  clearShortcut?: string;
  stopShortcut?: string;
  onFreeAsk: (question: string) => void;
  onShotAsk: (question: string) => Promise<void>;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [questionEditorOpen, setQuestionEditorOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingScript, setAddingScript] = useState(false);
  const [scriptTitle, setScriptTitle] = useState('');
  const [scriptText, setScriptText] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const currentSession = sessions.find((s) => s.id === currentId);
  const currentName = currentSession?.name ?? '';

  useEffect(() => {
    if (stick && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  });

  useEffect(() => {
    setStick(true);
    setAddingScript(false);
    setScriptTitle('');
    setScriptText('');
  }, [currentId]);

  useEffect(() => {
    // ASR updates never expand the editor. Manual entry or a selected bank
    // question does, so the fallback remains accessible when it is needed.
    setQuestionEditorOpen(questionEditing);
  }, [currentId, questionEditing]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const submit = () => {
    const q = inputRef.current?.value.trim();
    if (!q) return;
    onFreeAsk(q);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section className="pane pane-answer">
      <header className="pane-head session-bar">
        {editing ? (
          <input
            className="session-select"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              onRename(currentId, nameDraft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename(currentId, nameDraft);
                setEditing(false);
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
          />
        ) : (
          <select
            className="session-select"
            value={currentId}
            onChange={(e) => onSwitch(e.target.value)}
            title={t.answer.switchTitle}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm" onClick={onNew} title={t.answer.newTitle}>＋</button>
        <button className="btn btn-sm" onClick={onOpenLibrary}>{t.uiLang === 'zh' ? '面试资料' : 'Materials'}</button>
        <details className="session-more reading-controls">
          <summary className="btn btn-sm">{t.uiLang === 'zh' ? '更多' : 'More'}</summary>
          <div className="session-more-menu">
            <label title={t.uiLang === 'zh' ? '开启后会调用接口翻译问题' : 'Uses API to translate questions'}><input type="checkbox" checked={showChineseQuestion} onChange={(e) => onShowChineseQuestion(e.target.checked)} />{t.uiLang === 'zh' ? '问题中文释义' : 'Chinese question gloss'}</label>
            <button className="btn btn-sm" onClick={(e) => { setAddingScript((v) => !v); e.currentTarget.closest('details')?.removeAttribute('open'); }}>{t.uiLang === 'zh' ? '添加讲稿' : 'Add script'}</button>
            <button className="btn btn-sm" onClick={() => { setNameDraft(currentName); setEditing(true); }} title={t.answer.renameTitle}>{t.uiLang === 'zh' ? '重命名会话' : 'Rename session'}</button>
            <button className="btn btn-sm" onClick={onClear} title={`${t.answer.clearTitle} · ${t.uiLang === 'zh' ? '保留固定讲稿' : 'Keeps pinned scripts'}${clearShortcut ? ` (${clearShortcut})` : ''}`}>{t.answer.clear}</button>
            <button className="btn btn-sm" onClick={() => onDelete(currentId)} title={t.answer.deleteTitle}>{t.uiLang === 'zh' ? '删除会话' : 'Delete session'}</button>
          </div>
        </details>
      </header>
      {addingScript && <form className="script-editor" onSubmit={(e) => { e.preventDefault(); if (!scriptText.trim()) return; onAddScript(scriptTitle.trim() || (t.uiLang === 'zh' ? '讲稿' : 'Script'), scriptText.trim()); setAddingScript(false); setScriptText(''); setScriptTitle(''); }}>
        <input aria-label={t.uiLang === 'zh' ? '讲稿标题' : 'Script title'} placeholder={t.uiLang === 'zh' ? '讲稿标题' : 'Script title'} value={scriptTitle} onChange={(e) => setScriptTitle(e.target.value)} />
        <textarea aria-label={t.uiLang === 'zh' ? '讲稿内容' : 'Script text'} placeholder={t.uiLang === 'zh' ? '粘贴已确认的讲稿' : 'Paste your confirmed script'} rows={4} value={scriptText} onChange={(e) => setScriptText(e.target.value)} />
        <button className="btn btn-sm btn-primary" disabled={!scriptText.trim()}>{t.uiLang === 'zh' ? '保存并固定' : 'Save and pin'}</button>
        <button type="button" className="btn btn-sm" onClick={() => setAddingScript(false)}>{t.uiLang === 'zh' ? '取消' : 'Cancel'}</button>
      </form>}
      {scripts.length > 0 && <div className="pinned-scripts">
        <div className="settings-hint">{t.uiLang === 'zh' ? '固定讲稿 · 清空问答时保留；移除按钮只删除该讲稿副本' : 'Pinned scripts survive clearing answers; Remove deletes only this copy'}</div>
        {scripts.map((script) => <div className="pinned-script" key={script.id}>
          <div className="script-head"><button className="btn btn-sm" aria-expanded={!script.collapsed} onClick={() => onToggleScript(script.id)}>{script.collapsed ? '▸' : '▾'} {script.title}</button>
            {script.source && <span className="script-provenance">{t.uiLang === 'zh' ? '复制自：' : 'Copied from: '}{script.source.sessionName}</span>}
            {script.sourceTurnId && <span className="turn-tag">{t.uiLang === 'zh' ? 'AI 建议副本' : 'AI suggestion copy'}</span>}
            <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(script.text)}>{t.answer.copy}</button>
            <button className="btn btn-sm" onClick={() => onRemoveScript(script.id)}>{t.uiLang === 'zh' ? '移除讲稿' : 'Remove script'}</button></div>
          {!script.collapsed && <div className="turn-body">{script.text}</div>}
        </div>)}
      </div>}
      <details className="current-question" open={questionEditorOpen} onToggle={(e) => setQuestionEditorOpen(e.currentTarget.open)}>
        <summary>{questionEditing
          ? (t.uiLang === 'zh' ? '问题已手动修改 · 展开生成' : 'Question edited · expand to generate')
          : (t.uiLang === 'zh' ? '修正问题（可选）' : 'Correct question (optional)')}</summary>
        <label htmlFor="current-interview-question">{t.uiLang === 'zh' ? '当前问题（可修正）' : 'Current question (editable)'}</label>
        <textarea id="current-interview-question" rows={2} value={currentQuestion}
          placeholder={t.uiLang === 'zh' ? '等待提问，或在此输入问题' : 'Waiting for a question, or type one here'}
          onChange={(e) => onEditQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.ctrlKey && e.key === 'Enter' && !e.nativeEvent.isComposing && answersReady && currentQuestion.trim()) onAnswerQuestion(); }} />
        <div className="current-question-actions">
          <span>{questionEditing ? (t.uiLang === 'zh' ? '编辑中：暂停自动生成，点击生成使用修正问题' : 'Editing pauses automatic answers; generate to use the correction') : (t.uiLang === 'zh' ? '仅对方提问触发；切换会话后需重新开启持续答' : 'Only interviewer questions trigger answers; re-enable automatic answers after switching sessions')}</span>
          <button className="btn btn-sm btn-primary" disabled={!answersReady || !currentQuestion.trim()} onClick={onAnswerQuestion}>{t.uiLang === 'zh' ? '生成回答' : 'Generate answer'}</button>
        </div>
      </details>
      {notice && <div className="kb-notice">{notice}</div>}
      <div className="session" ref={boxRef} onScroll={onScroll}>
        {turns.length === 0 ? (
          <div className="pane-empty">
            {t.answer.empty}
            {resumeChars === 0 && t.answer.emptyKbHint}
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className={`turn turn-${turn.kind}`}>
              <div className="turn-head">
                <span className="turn-tag">{t.answer.kindTag[turn.kind]}</span>
                {turn.kind !== 'translate' && <span className="turn-tag">{t.uiLang === 'zh' ? 'AI 建议（未实际说出）' : 'AI suggestion (not spoken)'}</span>}
                {turn.rewriteStyle && <span className="turn-tag" title={turns.find((source) => source.id === turn.rewriteOf)?.text}>{t.uiLang === 'zh' ? ({ shorter: '更短', expand: '展开', rephrase: '换个说法' }[turn.rewriteStyle]) : turn.rewriteStyle} · {t.uiLang === 'zh' ? '原答案改写' : 'Answer revision'}</span>}
                {turn.modelName && <span className="turn-tag">{turn.modelName}</span>}
                {turn.status === 'cancelled' && <span className="turn-tag">{t.uiLang === 'zh' ? '已停止' : 'Stopped'}</span>}
                <span className="turn-label" title={turn.label}>
                  {turn.label}
                </span>
                {turn.status === 'streaming' ? (
                  <button className="btn btn-sm" onClick={() => onCancel(turn.id)} title={stopShortcut ? `${t.uiLang === 'zh' ? '停止全部' : 'Stop all'}: ${stopShortcut}` : undefined}>
                    {t.answer.stop}
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => void navigator.clipboard.writeText(turn.text)}
                    title={t.answer.copyTitle}
                  >
                    {t.answer.copy}
                  </button>
                )}
              </div>
              <div className="reading-question">{turn.label}</div>
              {turn.rewriteOf && <details className="rewrite-source">
                <summary>{t.uiLang === 'zh' ? '查看本次改写依据的原答案' : 'View the answer used for this revision'}</summary>
                <div className="rewrite-source-body">{turns.find((source) => source.id === turn.rewriteOf)?.text ?? (t.uiLang === 'zh' ? '原答案已不在当前历史范围内' : 'Original answer is outside the current history window')}</div>
              </details>}
              {showChineseQuestion && turn.kind !== 'translate' && <div className="question-gloss">
                {turn.questionTranslation || (turn.questionTranslating ? (t.uiLang === 'zh' ? '中文释义翻译中…' : 'Translating question…') : turn.questionTranslationError || (t.uiLang === 'zh' ? '尚未翻译问题' : 'Question not translated'))}
                {!turn.questionTranslating && !turn.questionTranslation && <button className="btn btn-sm" onClick={() => onTranslateQuestion(turn)}>{turn.questionTranslationError ? (t.uiLang === 'zh' ? '重试释义' : 'Retry gloss') : (t.uiLang === 'zh' ? '翻译问题' : 'Translate question')}</button>}
              </div>}
              <div className="turn-body">
                {turn.status === 'error' ? (
                  <>{turn.text && <div>{turn.text}</div>}<span className="answer-error">{turn.error}</span></>
                ) : (
                  <>
                    {turn.text || (turn.status === 'cancelled' ? (turn.error || (t.uiLang === 'zh' ? '已停止' : 'Stopped')) : turn.kind === 'vision' ? t.answer.visionWaiting : t.answer.genWaiting)}
                    {turn.status === 'streaming' && <span className="cursor">▍</span>}
                  </>
                )}
              </div>
              <div className="answer-latency" title={t.uiLang === 'zh' ? '从发起请求到页面首次收到非空内容／完整结束。非流式接口首字与完成接近；缺少采样为未知。' : 'Request to first non-empty content / completion. Non-streaming returns both together; — is unknown.'}>
                {turn.captureStartedAt !== undefined && <>
                  {t.uiLang === 'zh' ? '触发到截图就绪' : 'Trigger to image'} {durationText(measuredMs(turn.imageReadyAt, turn.captureStartedAt))} ·
                  {' '}{t.uiLang === 'zh' ? '截图就绪到发送' : 'Image to send'} {durationText(measuredMs(turn.requestStartedAt, turn.imageReadyAt))} ·{' '}
                </>}
                {t.uiLang === 'zh' ? '首字' : 'First'} {durationText(turn.firstTokenMs)} · {t.uiLang === 'zh' ? '完成' : 'Done'} {durationText(turn.completedMs)}</div>
              {turn.status === 'done' && turn.kind !== 'translate' && <div className="answer-actions">
                {(['shorter', 'expand', 'rephrase'] as const).map((style) => <button key={style} className="btn btn-sm" disabled={!answersReady} onClick={() => onRewrite(turn, style)}>{t.uiLang === 'zh' ? ({ shorter: '更短', expand: '展开', rephrase: '换个说法' }[style]) : ({ shorter: 'Shorter', expand: 'Expand', rephrase: 'Rephrase' }[style])}</button>)}
                <button className="btn btn-sm" disabled={scripts.some((script) => script.sourceTurnId === turn.id)} onClick={() => onPinTurn(turn)}>{t.uiLang === 'zh' ? '固定为讲稿' : 'Pin as script'}</button>
              </div>}
            </div>
          ))
        )}
        {!stick && (
          <button
            className="jump-bottom"
            onClick={() => {
              setStick(true);
              if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
            }}
          >
            {t.transcript.jumpLatest}
          </button>
        )}
      </div>
      {!answersReady && <div className="kb-notice">{answersHint}</div>}
      <div className="answer-input">
        <input
          ref={inputRef}
          disabled={!answersReady}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
          }}
          placeholder={answersReady ? t.answer.freePlaceholder : answersHint}
        />
        <button
          className="btn btn-primary"
          disabled={!answersReady}
          title={answersReady ? undefined : answersHint}
          onClick={submit}
        >
          {t.answer.ask}
        </button>
        {visionReady && (
          <button
            className="btn"
            title={t.answer.shotTitle}
            onClick={async () => {
              const q = inputRef.current?.value.trim() ?? '';
              if (inputRef.current) inputRef.current.value = '';
              await onShotAsk(q);
            }}
          >
            📷
          </button>
        )}
      </div>
    </section>
  );
}
