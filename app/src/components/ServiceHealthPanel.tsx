/**
 * 服务状态 overlay (spec §E.4): one row per service, in plain words, with the
 * three actions that can actually fix something — 打开设置 / 重新测试 / 打开配置
 * 向导.
 *
 * The states come from shared/healthState.ts, so this panel, the status-bar
 * chips and the answer-button gating cannot disagree. Nothing here blocks the
 * app: a failed row is information, and the app keeps running around it (ASR
 * without an LLM still transcribes, an LLM without ASR still answers typed
 * questions).
 */
import { useState } from 'react';
import { configuredVisionSlots, enabledVisionSlots } from '../../shared/visionSlots';
import { interviewService } from '../../shared/interviewService';
import type {
  StoredSession,
  ProviderSlot,
  ProviderTestResult,
  ProviderVerification,
  PublicSettings,
} from '../../shared/protocol';
import {
  chipTone,
  type ServiceHealth,
  type ServiceHealthReport,
} from '../../shared/healthState';
import {
  isTestableTarget,
  storedKeyTest,
  type EndpointTarget,
} from '../../shared/providerTestRequests';
import { PROVIDER_HELP, findPresetByEndpoint, providerIdForEndpoint } from '../../shared/providerCatalog';
import { useT } from '../i18n';
import { ConnectionResult } from './providers/ConnectionResult';
import { connectionResultCopy } from './providers/copy';

const TONE_CLASS: Record<string, string> = {
  ok: 'tag tag-ok',
  busy: 'tag tag-wait',
  bad: 'tag tag-err',
  none: 'tag',
};

/** stored endpoint for a slot; undefined when the service has no cloud side */
function targetForSlot(s: PublicSettings, slot: ProviderSlot): EndpointTarget | undefined {
  switch (slot) {
    case 'llm':
      return {
        capability: 'text-llm',
        providerId: providerIdForEndpoint(s.llm.baseUrl, s.llm.model, 'text-llm'),
        baseUrl: s.llm.baseUrl,
        model: s.llm.model,
        slot,
      };
    case 'vision':
    case 'vision-2':
    case 'vision-3':
    case 'vision-4': {
      const config = configuredVisionSlots(s.vision).find((item) => item.id === slot)!.config;
      return {
        capability: 'vision',
        providerId: providerIdForEndpoint(config.baseUrl, config.model, 'vision'),
        baseUrl: config.baseUrl ?? '',
        model: config.model ?? '',
        slot,
        ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
      };
    }
    case 'asr-cloud':
      return {
        capability: 'asr-segment',
        providerId: providerIdForEndpoint(s.asr.cloud.baseUrl, s.asr.cloud.model, 'asr-segment'),
        baseUrl: s.asr.cloud.baseUrl ?? '',
        model: s.asr.cloud.model ?? '',
        slot,
      };
    case 'asr-realtime':
    default:
      return {
        capability: 'asr-realtime',
        providerId: providerIdForEndpoint(
          s.asr.realtime.baseUrl,
          s.asr.realtime.model,
          'asr-realtime',
        ),
        baseUrl: s.asr.realtime.baseUrl ?? '',
        model: s.asr.realtime.model ?? '',
        slot,
      };
  }
}

export interface ServiceHealthPanelProps {
  settings: PublicSettings;
  health: ServiceHealthReport;
  material?: StoredSession;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  /** re-read the public settings after a test recorded a fresh verdict */
  onSettingsRefreshed: (s: PublicSettings) => void;
}

export function ServiceHealthPanel({
  settings,
  health,
  material,
  onClose,
  onOpenSettings,
  onOpenDiagnostics,
  onSettingsRefreshed,
}: ServiceHealthPanelProps) {
  const t = useT();
  const copy = connectionResultCopy(t);
  const [testing, setTesting] = useState<ProviderSlot | null>(null);
  const [results, setResults] = useState<
    Partial<Record<ProviderSlot, { result: ProviderTestResult; at: number }>>
  >({});
  const [error, setError] = useState<string | null>(null);

  const service = interviewService(settings);
  const serviceIdentity = JSON.stringify(service && {
    id: service.id, baseUrl: service.config.baseUrl, model: service.config.model,
    proxyUrl: 'proxyUrl' in service.config ? service.config.proxyUrl : undefined,
    apiKeyHint: service.config.apiKeyHint, apiKeySet: service.config.apiKeySet,
  });
  const [translation, setTranslation] = useState<{ identity: string; text?: string; error?: string } | null>(null);
  const zh = t.uiLang === 'zh';
  const testTranslation = async () => {
    if (!service) return;
    const identity = serviceIdentity;
    setTesting(service.id);
    setTranslation(null);
    try {
      const text = await window.mc.translate('Could you describe your recent project?');
      if (!text.trim()) throw new Error(zh ? '服务返回了空翻译' : 'The service returned an empty translation');
      setTranslation({ identity, text });
    } catch (e) {
      setTranslation({ identity, error: (e as Error).message });
    } finally {
      setTesting(null);
    }
  };

  const runTest = async (slot: ProviderSlot, target: EndpointTarget) => {
    setTesting(slot);
    setError(null);
    setResults((r) => ({ ...r, [slot]: undefined }));
    try {
      const result = await window.mc.providerTest(storedKeyTest(target));
      setResults((r) => ({ ...r, [slot]: { result, at: Date.now() } }));
      onSettingsRefreshed(await window.mc.getSettings());
    } catch (e) {
      setError(t.settings.testCrashed((e as Error).message));
    } finally {
      setTesting(null);
    }
  };

  const verificationLine = (v: ProviderVerification | undefined): string => {
    if (!v?.lastTestAt) return t.settings.testNever;
    const when = new Date(v.lastTestAt).toLocaleString(t.locale);
    return v.lastTestOk ? t.settings.testLastOk(when, v.latencyMs) : t.settings.testLastFail(when);
  };

  const row = (h: ServiceHealth, label: string, note?: string) => {
    const target = h.slot ? targetForSlot(settings, h.slot) : undefined;
    const canTest =
      !!h.slot &&
      !!target &&
      isTestableTarget(target) &&
      h.state !== 'unconfigured' &&
      h.state !== 'off';
    const fresh = h.slot ? results[h.slot] : undefined;
    const keyUrl = target
      ? (findPresetByEndpoint(target.baseUrl, target.model, target.capability)?.help.keyUrl ??
        PROVIDER_HELP[target.providerId].keyUrl)
      : undefined;
    return (
      <div className="health-row" key={h.slot ?? h.key}>
        <div className="conn-line">
          <span className="health-name">{label}</span>
          {h.optional && <span className="tag">{t.health.optional}</span>}
          <span className={TONE_CLASS[chipTone(h)]}>{t.health.state[h.state]}</span>
          <span className="health-actions">
            <button className="btn btn-sm" onClick={onOpenSettings}>
              {t.health.openSettings}
            </button>
            {canTest && target && (
              <button
                className="btn btn-sm"
                disabled={testing !== null}
                onClick={() => void runTest(h.slot!, target)}
              >
                {testing === h.slot ? t.health.testing : t.health.retest}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void window.mc.rerunOnboarding()}>
              {t.health.openWizard}
            </button>
          </span>
        </div>
        {note && <div className="conn-hint">{note}</div>}
        {h.detail && <div className="conn-hint">{h.detail}</div>}
        {/* a slot with nothing configured has nothing to say about test history */}
        {h.slot && !fresh && h.state !== 'off' && h.state !== 'unconfigured' && (
          <div className="conn-hint">{verificationLine(h.verification)}</div>
        )}
        {h.slot && (
          <ConnectionResult
            copy={copy}
            result={fresh?.result ?? null}
            testing={testing === h.slot}
            message={
              fresh
                ? t.uiLang === 'zh'
                  ? fresh.result.messageZh
                  : fresh.result.messageEn
                : undefined
            }
            hint={fresh ? t.settings.testHints[fresh.result.code] : undefined}
            at={fresh?.at}
          >
            {keyUrl && (
              <button className="btn btn-sm" onClick={() => void window.mc.openExternal(keyUrl)}>
                {t.settings.testOpenKeyPage}
              </button>
            )}
          </ConnectionResult>
        )}
      </div>
    );
  };

  /** the one sentence that explains a partial setup */
  const partialHint = health.needsSetup
    ? t.health.hintNeedsSetup
    : !health.answersAvailable
      ? t.health.hintAsrOnly
      : !health.transcriptionAvailable
        ? t.health.hintLlmOnly
        : null;

  return (
    <div className="settings health-panel">
      <div className="settings-section">{t.health.title}</div>
      {(settings.ui.workspace ?? 'interview') === 'interview' && <>
        <div className="settings-section">{zh ? '面试会前检查' : 'Pre-interview check'}</div>
        <div className="settings-hint">{zh ? '语音术语限制：本版本尚未把会话术语接入 ASR 热词或上下文参数。资料和个人信息只辅助回答，不会修正语音识别；识别错词可在当前问题中手动纠正。' : 'ASR terms: this version does not send session terminology as ASR hotwords/context. Materials guide answers, not speech recognition. Correct terms in the current question.'}</div>
        <div className="settings-hint">{zh ? '回答语言：' : 'Answer language: '}{settings.llm.answerLang === 'english' ? (zh ? '英文' : 'English') : (zh ? '中文' : 'Chinese')}</div>
        <div className="settings-hint">{zh ? '简历：' : 'Resume: '}{material?.resumeText?.trim() ? `${material.resumeName ?? ''} (${material.resumeText.length})` : (zh ? '未加载' : 'Not loaded')}
          {' · '}{zh ? '岗位资料：' : 'Job material: '}{material?.jdText?.trim() ? `${material.jdName ?? ''} (${material.jdText.length})` : (zh ? '未加载' : 'Not loaded')}
          {' · '}{zh ? '旧版全局资料（可手动导入）：' : 'Legacy material (manual import): '}{settings.knowledge.chars} {zh ? '字符' : 'characters'}</div>
        <div className="settings-hint">{zh ? '回答接口：' : 'Answer services: '}{settings.llm.answerWithVision
          ? enabledVisionSlots(settings.vision, 'interview').map(({ id, config }) => `${id}: ${config.model} (${config.baseUrl})`).join('；') || (zh ? '无可用接口' : 'None available')
          : `llm: ${settings.llm.model} (${settings.llm.baseUrl})`}</div>
        <div className="settings-hint">{zh ? '翻译与备忘：' : 'Translation and memo: '}{service ? `${service.id}: ${service.config.model} (${service.config.baseUrl})` : (zh ? '无可用接口，不回退文本接口' : 'No available service; no text fallback')}
          {service && ('proxyUrl' in service.config && service.config.proxyUrl ? ` · ${zh ? '代理' : 'Proxy'}: ${service.config.proxyUrl}` : ` · ${zh ? '直连' : 'Direct'}`)}</div>
        <div className="settings-hint">{zh ? '已配置表示地址、模型与密钥齐全；连接测试通过不代表实际翻译验证通过。打开此面板不会发送模型请求。' : 'Configured means endpoint, model and key are present. Connection tests and actual translation checks are separate. Opening this panel sends no model requests.'}</div>
        {(settings.llm.answerWithVision ? enabledVisionSlots(settings.vision, 'interview') : [{ id: 'llm' as const, config: settings.llm }]).map(({ id, config }) => row({
          key: id === 'llm' ? 'llm' : 'vision', slot: id,
          state: !config.apiKeySet || !config.baseUrl?.trim() || !config.model?.trim() ? 'unconfigured' : config.verification?.lastTestOk === true ? 'ok' : config.verification?.lastTestOk === false ? 'failed' : 'untested',
          verification: config.verification,
        }, `${id}: ${config.model ?? ''}`, zh ? '面试实际使用接口（连接测试）' : 'Active interview service (connection test)'))}
        <div className="health-row">
          <button className="btn btn-sm" disabled={testing !== null || !service || !service.config.apiKeySet} onClick={() => void testTranslation()}>{zh ? '验证实际翻译（会调用接口）' : 'Test actual translation (sends a request)'}</button>
          <div className="settings-hint">{zh ? '测试句：Could you describe your recent project?；只发送此公开例句，不发送会话资料。翻译与备忘仅使用上方第一个接口。' : 'Sample: Could you describe your recent project? Only this public sentence is sent. Translation and memo use only the first service above.'}</div>
          {translation?.identity === serviceIdentity && translation.text
            ? <div className="settings-hint">{zh ? '实际翻译验证通过（已返回文本，请核对译文）：' : 'Actual translation returned text; review the result: '}{translation.text}</div>
            : <div className="settings-hint">{zh ? '实际翻译尚未验证通过' : 'Actual translation has not passed verification'}</div>}
          {translation?.identity === serviceIdentity && translation.error && <div className="settings-warn">{translation.error}</div>}
        </div>
      </>}
      {partialHint && <div className="settings-hint">{partialHint}</div>}

      {row(health.asr, t.health.rowAsr, health.asr.local ? t.health.localBackend : undefined)}
      {row(health.llm, t.health.rowLlm)}
      {row(
        health.audio,
        t.health.rowAudio,
        health.audio.state === 'ok' ? t.health.audioOk : t.health.audioIdle,
      )}
      {row(
        health.vision,
        t.health.rowVision,
        health.vision.state === 'off' ? t.health.visionOff : undefined,
      )}

      {error && <div className="settings-warn">{error}</div>}
      <div className="settings-hint">{t.settings.testFeeNote}</div>

      <div className="settings-actions">
        <button className="btn" onClick={onOpenDiagnostics}>
          {t.health.diagnostics}
        </button>
        <button className="btn" onClick={onClose}>
          {t.health.close}
        </button>
      </div>
    </div>
  );
}
