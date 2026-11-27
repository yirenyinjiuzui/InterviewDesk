import { durationText } from '../../shared/latency';
import type { AsrUiState, HudStats } from '../App';
import { chipTone, type ChipTone, type ServiceHealthReport } from '../../shared/healthState';
import { useT } from '../i18n';

/** one glyph per tone — the chips must stay readable at 10px in a 28px bar */
const MARK: Record<ChipTone, string> = { ok: '✓', busy: '…', bad: '!', none: '–' };

export function StatusBar({
  asr,
  capturing,
  hud,
  health,
  onOpenHealth,
}: {
  asr: AsrUiState;
  capturing: boolean;
  hud?: HudStats;
  /** absent until the settings snapshot has loaded */
  health?: ServiceHealthReport;
  onOpenHealth: () => void;
}) {
  const t = useT();
  return (
    <footer className="statusbar">
      <div className="status-left">
        {asr.phase === 'loading' && <span className="tag tag-wait">{t.status.state.loading}</span>}
        {asr.phase === 'error' && <span className="tag tag-err">{t.status.engineError}</span>}
        {asr.phase === 'ready' && (
          <>
            <span className={capturing ? 'tag tag-live' : 'tag'}>
              {capturing ? t.status.state[asr.workerState] : t.status.idle}
            </span>
            <span className={asr.gpuSuspect ? 'tag tag-err' : 'tag tag-ok'}>
              {asr.gpuSuspect ? t.status.gpuBad : t.status.gpuOk}
            </span>
          </>
        )}
        {asr.lastError && (
          <span className="tag tag-err" title={asr.lastError}>
            ⚠
          </span>
        )}
        {/* compact service health; the panel behind it carries the detail */}
        {health && (
          <button className="health-chips" onClick={onOpenHealth} title={t.health.chipsTitle}>
            <span className={`health-chip is-${chipTone(health.asr)}`}>
              {t.health.chipAsr} {MARK[chipTone(health.asr)]}
            </span>
            <span className={`health-chip is-${chipTone(health.llm)}`}>
              {t.health.chipLlm} {MARK[chipTone(health.llm)]}
            </span>
            <span className={`health-chip is-${chipTone(health.audio)}`}>
              {t.health.chipAudio} {MARK[chipTone(health.audio)]}
            </span>
          </button>
        )}
      </div>
      {hud && (
        <div className="status-hud" title={t.uiLang === 'zh' ? '转录首字：该句音频起点到首次收到文本；定稿：句末采集到页面收到定稿（含网络和排队）。回答首字／完成：点击或自动发起请求到页面收到内容。不等于模型纯推理耗时；— 表示未知。' : 'ASR first: sentence audio start to first text; final: audio end to rendered final. Answer times: request to first content/completion. Includes transport and queues; — means unknown.'}>
          <span>{t.uiLang === 'zh' ? '转录首字' : 'ASR first'} {durationText(hud.lastAsrFirstMs)}</span>
          <span>{t.uiLang === 'zh' ? '定稿' : 'Final'} {durationText(hud.lastE2eMs)}</span>
          <span>{t.uiLang === 'zh' ? '回答首字' : 'Answer first'} {durationText(hud.lastAnswerFirstMs)}</span>
          <span>{t.uiLang === 'zh' ? '完成' : 'Done'} {durationText(hud.lastAnswerCompleteMs)}</span>
        </div>
      )}
    </footer>
  );
}
