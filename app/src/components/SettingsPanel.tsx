import { configuredVisionSlots, VISION_SLOTS } from '../../shared/visionSlots';
import { useEffect, useState } from 'react';
import { HOTKEYS, resolveHotkeys, validateHotkeys } from '../../shared/hotkeys';
import type {
  AnswerLang,
  AsrLanguage,
  FontScale,
  ProviderSlot,
  ProviderTestResult,
  ProviderVerification,
  PublicSettings,
  ThemeMode,
  UiLang,
} from '../../shared/protocol';
import {
  LOCAL_REALTIME_MODELS,
  PROVIDER_HELP,
  findPresetById,
  findPresetByEndpoint,
  presetsForCapability,
  providerIdForEndpoint,
  type ProviderCapability,
  type ProviderPreset,
} from '../../shared/providerCatalog';
import {
  candidateKeyTest,
  isTestableTarget,
  storedKeyTest,
  type EndpointTarget,
} from '../../shared/providerTestRequests';
import { sanitizeApiKeyInput } from '../../shared/keyInput';
import { listMics } from '../audio/micCapture';
import { useT } from '../i18n';
import { ConnectionResult } from './providers/ConnectionResult';
import { connectionResultCopy } from './providers/copy';

type AsrBackend = 'local' | 'cloud' | 'cloud-realtime' | 'local-realtime';

/**
 * One API-key slot in the panel. Keys are write-only: the renderer never sees
 * a stored key, only whether one exists plus its last-4 hint. Three outcomes
 * feed the save patch — leave alone (undefined), replace (the new plaintext),
 * delete (`''`, which SettingsStore.applyPatch treats as "clear this slot").
 */
function useKeySlot() {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const reset = (): void => {
    setValue('');
    setEditing(false);
    setPendingDelete(false);
    setConfirming(false);
  };

  /** the `apiKey` field for the settings patch, or undefined to keep it */
  const patchValue = (): string | undefined => {
    if (pendingDelete) return '';
    const clean = sanitizeApiKeyInput(value).value;
    return clean || undefined;
  };

  return {
    value,
    setValue,
    editing,
    setEditing,
    pendingDelete,
    setPendingDelete,
    confirming,
    setConfirming,
    reset,
    patchValue,
  };
}

type KeySlot = ReturnType<typeof useKeySlot>;

/** in-flight / finished connection test for one provider slot */
interface SlotTest {
  testing: boolean;
  result?: ProviderTestResult;
  at?: number;
  /** the IPC itself failed (provider failures arrive as a result, not a throw) */
  error?: string;
  /** the verdict belongs to a key that is typed but not saved yet */
  candidate?: boolean;
}

/** the public (secret-free) view of one credential slot */
function publicSlot(
  s: PublicSettings,
  slot: ProviderSlot,
): { apiKeySet: boolean; apiKeyHint?: string; verification?: ProviderVerification } {
  switch (slot) {
    case 'llm':
      return s.llm;
    case 'vision':
    case 'vision-2':
    case 'vision-3':
    case 'vision-4':
      return configuredVisionSlots(s.vision).find((item) => item.id === slot)!.config;
    case 'asr-cloud':
      return s.asr.cloud;
    case 'asr-realtime':
    default:
      return s.asr.realtime;
  }
}

/**
 * BYOK settings (R7). Reorganised in Phase 2 into 常用 / 高级 (SPEC §G) and
 * fed by shared/providerCatalog.ts instead of the local preset constants that
 * used to live here — the wizard and this panel now offer exactly the same
 * providers, selected by stable preset id rather than by URL matching.
 * baseUrl/model keep being stored in settings for compatibility; providerId is
 * derived from them at save time.
 */
export function SettingsPanel({
  settings,
  onSaved,
  onClose,
  onRerunWizard,
  onOpenDiagnostics,
  onOpenHelp,
}: {
  settings: PublicSettings;
  onSaved: (s: PublicSettings) => void;
  onClose: () => void;
  /** opens the first-run wizard again (main window stays alive) */
  onRerunWizard?: () => void;
  /** 高级 entry into the local support report */
  onOpenDiagnostics?: () => void;
  /** in-app help center (also reachable from the tray) */
  onOpenHelp?: () => void;
}) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl);
  const [model, setModel] = useState(settings.llm.model);
  const [answerLang, setAnswerLang] = useState<AnswerLang>(settings.llm.answerLang);
  const [language, setLanguage] = useState<AsrLanguage>(settings.asr.language);
  const [shortcuts, setShortcuts] = useState(() => resolveHotkeys(settings.ui));
  const [saveError, setSaveError] = useState('');
  const [mouseX1, setMouseX1] = useState(settings.ui.mouseX1 ?? '');
  const [mouseX2, setMouseX2] = useState(settings.ui.mouseX2 ?? '');
  const [visionDraft, setVisionDraft] = useState(() => configuredVisionSlots(settings.vision).map(({ id, config }) => ({
    baseUrl: config.baseUrl ?? '', model: config.model ?? '', proxyUrl: config.proxyUrl ?? '', enabled: config.enabled ?? id === 'vision', interviewEnabled: config.interviewEnabled ?? id === 'vision',
  })));
  const updateVision = (index: number, patch: Partial<typeof visionDraft[number]>) =>
    setVisionDraft((slots) => slots.map((slot, i) => i === index ? { ...slot, ...patch } : slot));
  const [asrBackend, setAsrBackend] = useState<AsrBackend>(settings.asr.backend);
  const [cloudBaseUrl, setCloudBaseUrl] = useState(settings.asr.cloud.baseUrl ?? '');
  const [cloudModel, setCloudModel] = useState(settings.asr.cloud.model ?? '');
  const [rtBaseUrl, setRtBaseUrl] = useState(settings.asr.realtime.baseUrl ?? '');
  const [rtModel, setRtModel] = useState(settings.asr.realtime.model ?? '');
  const [rtLocalModel, setRtLocalModel] = useState(
    settings.asr.localRealtime.model ?? 'fun-asr-nano',
  );
  const [autoLaunch, setAutoLaunch] = useState(settings.ui.autoLaunch);
  const [fontScale, setFontScale] = useState<FontScale>(settings.ui.fontScale ?? 'medium');
  const [theme, setTheme] = useState<ThemeMode>(settings.ui.theme ?? 'dark');
  const [uiLang, setUiLang] = useState<UiLang>(settings.ui.lang);
  const [themDeviceId, setThemDeviceId] = useState(settings.audio.themDeviceId ?? '');
  const [micDeviceId, setMicDeviceId] = useState(settings.audio.micDeviceId ?? '');
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);
  /** weak-crypto confirmation is pending; nothing has been sent to main yet */
  const [confirmWeak, setConfirmWeak] = useState(false);

  const llmKey = useKeySlot();
  const visionKeys = [useKeySlot(), useKeySlot(), useKeySlot(), useKeySlot()];
  const cloudKey = useKeySlot();
  const rtKey = useKeySlot();

  /**
   * Live secret-free snapshot. The props seed the form once (uncontrolled by
   * design: the panel is a draft the user commits with 保存), but 已配置 flags
   * and connection-test verdicts must reflect what the main process just
   * recorded — a test writes `verification` through a dedicated store write.
   */
  const [live, setLive] = useState<PublicSettings>(settings);
  const [tests, setTests] = useState<Partial<Record<ProviderSlot, SlotTest>>>({});
  const anyTesting = Object.values(tests).some((s) => s?.testing);
  const resultCopy = connectionResultCopy(t);

  useEffect(() => {
    void listMics()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  /**
   * One real provider round-trip on an explicit click. A key typed above wins
   * over the stored one — that is the 更换 Key flow's whole question — and the
   * candidate is NOT saved by the test: 保存 still commits the form.
   */
  const runSlotTest = async (slot: ProviderSlot, target: EndpointTarget, candidate: string) => {
    setTests((s) => ({ ...s, [slot]: { testing: true, candidate: candidate !== '' } }));
    try {
      const result = await window.mc.providerTest(
        candidate ? candidateKeyTest(target, candidate) : storedKeyTest(target),
      );
      setTests((s) => ({
        ...s,
        [slot]: { testing: false, result, at: Date.now(), candidate: candidate !== '' },
      }));
    } catch (e) {
      setTests((s) => ({
        ...s,
        [slot]: { testing: false, error: t.settings.testCrashed((e as Error).message) },
      }));
    }
    try {
      // main recorded the verdict into the slot — re-read so 上次测试… is current
      setLive(await window.mc.getSettings());
    } catch {
      /* the verdict is already on screen; a stale snapshot is not worth failing */
    }
  };

  /** the provider's own key page, for the failure path */
  const keyPageFor = (target: EndpointTarget): string | undefined =>
    findPresetByEndpoint(target.baseUrl, target.model, target.capability)?.help.keyUrl ??
    PROVIDER_HELP[target.providerId].keyUrl;

  const verificationSummary = (v: ProviderVerification | undefined): string => {
    if (!v?.lastTestAt) return t.settings.testNever;
    const when = new Date(v.lastTestAt).toLocaleString(t.locale);
    return v.lastTestOk ? t.settings.testLastOk(when, v.latencyMs) : t.settings.testLastFail(when);
  };

  /** preset display name in the current UI language */
  const presetName = (p: ProviderPreset): string => (t.uiLang === 'zh' ? p.nameZh : p.nameEn);

  /** a save that would persist at least one NEW plaintext key (a deletion is
   * `''`, which never writes a secret and therefore needs no warning) */
  const savesAKey = (): boolean =>
    [llmKey, ...visionKeys, cloudKey, rtKey].some((s) => {
      const v = s.patchValue();
      return v !== undefined && v !== '';
    });

  /** pre-flight: ask before the plaintext leaves the renderer, so 「返回」
   * really means the key was never persisted */
  const requestSave = () => {
    if (settings.weakCrypto && savesAKey()) {
      setConfirmWeak(true);
      return;
    }
    void save();
  };

  const save = async () => {
    setConfirmWeak(false);
    setSaving(true);
    setSaveError('');
    try {
      validateHotkeys(shortcuts);
      const llmApiKey = llmKey.patchValue();
      const visionPatches = visionDraft.map((slot, index) => ({
        baseUrl: slot.baseUrl.trim(), model: slot.model.trim(), proxyUrl: slot.proxyUrl.trim(), enabled: slot.enabled, interviewEnabled: slot.interviewEnabled,
        providerId: providerIdForEndpoint(slot.baseUrl.trim(), slot.model.trim(), 'vision'),
        ...(visionKeys[index].patchValue() !== undefined ? { apiKey: visionKeys[index].patchValue() } : {}),
      }));
      const cloudApiKey = cloudKey.patchValue();
      const rtApiKey = rtKey.patchValue();
      const next = await window.mc.setSettings({
        llm: {
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          answerLang,
          providerId: providerIdForEndpoint(baseUrl.trim(), model.trim(), 'text-llm'),
          ...(llmApiKey !== undefined ? { apiKey: llmApiKey } : {}),
        },
        vision: { ...visionPatches[0], additional: visionPatches.slice(1) },
        asr: {
          language,
          backend: asrBackend,
          // local backends have no cloud provider; leave the stored value alone
          ...(asrBackend === 'cloud-realtime'
            ? {
                providerId: providerIdForEndpoint(
                  rtBaseUrl.trim(),
                  rtModel.trim(),
                  'asr-realtime',
                ),
              }
            : asrBackend === 'cloud'
              ? {
                  providerId: providerIdForEndpoint(
                    cloudBaseUrl.trim(),
                    cloudModel.trim(),
                    'asr-segment',
                  ),
                }
              : {}),
          cloud: {
            baseUrl: cloudBaseUrl.trim(),
            model: cloudModel.trim(),
            ...(cloudApiKey !== undefined ? { apiKey: cloudApiKey } : {}),
          },
          realtime: {
            baseUrl: rtBaseUrl.trim(),
            model: rtModel.trim(),
            ...(rtApiKey !== undefined ? { apiKey: rtApiKey } : {}),
          },
          localRealtime: { model: rtLocalModel },
        },
        ui: {
          ...Object.fromEntries(Object.entries(shortcuts).map(([key, value]) => [key, value.trim()])),
          mouseX1, mouseX2,
          fontScale,
          theme,
          lang: uiLang,
          autoLaunch,
        },
        audio: {
          themDeviceId: themDeviceId || undefined,
          micDeviceId: micDeviceId || undefined,
        },
      });
      llmKey.reset();
      visionKeys.forEach((slot) => slot.reset());
      cloudKey.reset();
      rtKey.reset();
      onSaved(next);
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** provider dropdown driven by the catalog; the value is always the truth
   * derived from the stored baseUrl+model, so an unmatched pair reads 自定义 */
  const providerSelect = (
    capability: ProviderCapability,
    currentBaseUrl: string,
    currentModel: string,
    onPick: (p: ProviderPreset) => void,
  ) => {
    const presets = presetsForCapability(capability).filter((p) => p.baseUrl && p.model);
    const current = findPresetByEndpoint(currentBaseUrl, currentModel, capability);
    return (
      <select
        value={current?.id ?? ''}
        onChange={(e) => {
          const p = findPresetById(e.target.value);
          if (p) onPick(p);
        }}
      >
        {!current && <option value="">{t.settings.providerCustom}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {presetName(p)}
          </option>
        ))}
      </select>
    );
  };

  const keyRow = (label: string, slot: KeySlot, slotId: ProviderSlot, target: EndpointTarget) => {
    const pub = publicSlot(live, slotId);
    const apiKeySet = pub.apiKeySet;
    const hint = pub.apiKeyHint;
    const state = tests[slotId];
    const candidate = sanitizeApiKeyInput(slot.value).value;
    const canTest =
      isTestableTarget(target) && !slot.pendingDelete && (candidate !== '' || apiKeySet);
    const keyUrl = keyPageFor(target);
    return (
      <div className="settings-row">
        <label>{label}</label>
        {apiKeySet && !slot.editing && !slot.pendingDelete ? (
          <div className="key-status">
            <span className="tag tag-ok">{t.settings.keyConfigured}</span>
            {hint && <span className="key-mask">{`••••${hint}`}</span>}
            <button className="btn btn-sm" onClick={() => slot.setEditing(true)}>
              {t.settings.keyReplace}
            </button>
            {slot.confirming ? (
              <>
                <span className="settings-inline-hint">{t.settings.keyDeleteConfirm}</span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    slot.setPendingDelete(true);
                    slot.setConfirming(false);
                  }}
                >
                  {t.settings.keyDeleteYes}
                </button>
                <button className="btn btn-sm" onClick={() => slot.setConfirming(false)}>
                  {t.settings.keyDeleteNo}
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => slot.setConfirming(true)}>
                {t.settings.keyDelete}
              </button>
            )}
          </div>
        ) : slot.pendingDelete ? (
          <div className="key-status">
            <span className="tag tag-err">{t.settings.keyPendingDelete}</span>
            <button className="btn btn-sm" onClick={slot.reset}>
              {t.settings.keyUndoDelete}
            </button>
          </div>
        ) : (
          <>
            <input
              type="password"
              aria-label={`${slotId}-apiKey`}
              value={slot.value}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => slot.setValue(e.target.value)}
              placeholder={apiKeySet ? t.settings.keyNewPlaceholder : 'sk-…'}
            />
            <span className="settings-inline-hint">
              {apiKeySet ? t.settings.keyKeepPlaceholder : t.settings.keyMissing} ·{' '}
              {t.settings.keySanitizedHint}
            </span>
          </>
        )}

        <div className="key-status">
          <button
            className="btn btn-sm"
            disabled={!canTest || anyTesting}
            title={canTest ? undefined : t.settings.testNoKey}
            onClick={() => void runSlotTest(slotId, target, candidate)}
          >
            {state?.testing ? t.settings.testing : t.settings.testConnection}
          </button>
          <span className="settings-inline-hint">{verificationSummary(pub.verification)}</span>
        </div>

        <ConnectionResult
          copy={resultCopy}
          result={state?.result ?? null}
          testing={state?.testing}
          message={
            state?.result
              ? t.uiLang === 'zh'
                ? state.result.messageZh
                : state.result.messageEn
              : undefined
          }
          hint={state?.result ? t.settings.testHints[state.result.code] : undefined}
          at={state?.at}
        >
          {keyUrl && (
            <button className="btn btn-sm" onClick={() => void window.mc.openExternal(keyUrl)}>
              {t.settings.testOpenKeyPage}
            </button>
          )}
        </ConnectionResult>
        {state?.result?.ok && state.candidate && (
          <span className="settings-inline-hint">{t.settings.testCandidateOk}</span>
        )}
        {state?.error && <div className="settings-warn">{state.error}</div>}
      </div>
    );
  };

  /** where each key row points its connection test */
  const llmTarget = (): EndpointTarget => ({
    capability: 'text-llm',
    providerId: providerIdForEndpoint(baseUrl.trim(), model.trim(), 'text-llm'),
    baseUrl,
    model,
    slot: 'llm',
  });
  const cloudTarget = (): EndpointTarget => ({
    capability: 'asr-segment',
    providerId: providerIdForEndpoint(cloudBaseUrl.trim(), cloudModel.trim(), 'asr-segment'),
    baseUrl: cloudBaseUrl,
    model: cloudModel,
    slot: 'asr-cloud',
  });
  const rtTarget = (): EndpointTarget => ({
    capability: 'asr-realtime',
    providerId: providerIdForEndpoint(rtBaseUrl.trim(), rtModel.trim(), 'asr-realtime'),
    baseUrl: rtBaseUrl,
    model: rtModel,
    slot: 'asr-realtime',
  });

  const asrSummary = (): string => {
    if (asrBackend === 'local') return t.settings.asrLocalWhisper;
    if (asrBackend === 'local-realtime') {
      const m = LOCAL_REALTIME_MODELS.find((x) => x.value === rtLocalModel);
      return m ? (t.uiLang === 'zh' ? m.nameZh : m.nameEn) : rtLocalModel;
    }
    const p =
      asrBackend === 'cloud-realtime'
        ? findPresetByEndpoint(rtBaseUrl, rtModel, 'asr-realtime')
        : findPresetByEndpoint(cloudBaseUrl, cloudModel, 'asr-segment');
    return p ? presetName(p) : t.settings.providerCustom;
  };

  const llmSummary = (): string => {
    const p = findPresetByEndpoint(baseUrl, model, 'text-llm');
    return p ? presetName(p) : `${model || '—'}`;
  };

  const deviceOptions = (
    <>
      <option value="">{t.settings.deviceDefault}</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || d.deviceId}
        </option>
      ))}
    </>
  );

  return (
    <div className="settings">
      <div className="settings-section">{t.uiLang === 'zh' ? '视觉模型 · 四个独立接口' : 'Vision models · Four independent interfaces'}</div>
      <div className="settings-hint">{t.uiLang === 'zh' ? '模型配置共用，分别勾选笔试或面试。截图按当前界面选择模型；面试的视觉问答使用“面试启用”的模型。每个参与的接口单独计 API 用量。' : 'Share model settings across both workspaces. Check where each model is enabled. Screenshots use the current workspace selection; interview vision answers use interview-enabled models. Each participating interface incurs its own API usage.'}</div>
      {visionDraft.map((slot, index) => {
        const id = VISION_SLOTS[index];
        const target: EndpointTarget = { capability: 'vision', providerId: providerIdForEndpoint(slot.baseUrl.trim(), slot.model.trim(), 'vision'), baseUrl: slot.baseUrl, model: slot.model, proxyUrl: slot.proxyUrl, slot: id };
        return <section className="vision-slot-card" key={id} data-vision-slot={id}>
          <div className="vision-slot-title">
            <strong>{t.uiLang === 'zh' ? '接口' : 'Interface'} {index + 1} · {slot.model || (t.uiLang === 'zh' ? '未配置' : 'Not configured')}</strong>
            <div className="vision-slot-usage">
              <label><input type="checkbox" aria-label={`${id}-enabled`} checked={slot.enabled} onChange={(e) => updateVision(index, { enabled: e.target.checked })} /> {t.uiLang === 'zh' ? '笔试启用' : 'Written tests'}</label>
              <label><input type="checkbox" aria-label={`${id}-interview-enabled`} checked={slot.interviewEnabled} onChange={(e) => updateVision(index, { interviewEnabled: e.target.checked })} /> {t.uiLang === 'zh' ? '面试启用' : 'Interviews'}</label>
            </div>
          </div>
          <div className="settings-row"><label>{t.settings.providerPreset}</label>{providerSelect('vision', slot.baseUrl, slot.model, (preset) => updateVision(index, { baseUrl: preset.baseUrl, model: preset.model, proxyUrl: preset.defaultProxyUrl ?? '' }))}</div>
          <div className="settings-row"><label>Base URL</label><input aria-label={`${id}-baseUrl`} value={slot.baseUrl} onChange={(e) => updateVision(index, { baseUrl: e.target.value })} spellCheck={false} placeholder="https://api.example.com/v1" /></div>
          <div className="settings-row"><label>{t.uiLang === 'zh' ? '模型名称' : 'Model name'}</label><input aria-label={`${id}-model`} value={slot.model} onChange={(e) => updateVision(index, { model: e.target.value })} spellCheck={false} /></div>
          {keyRow(t.settings.visionApiKey, visionKeys[index], id, target)}
          <div className="settings-row"><label>{t.settings.visionProxy}</label><input aria-label={`${id}-proxy`} value={slot.proxyUrl} onChange={(e) => updateVision(index, { proxyUrl: e.target.value })} spellCheck={false} placeholder={t.settings.visionProxyPlaceholder} /></div>
        </section>;
      })}
      {/* ---------------- 常用 ---------------- */}
      <div className="settings-section">{t.settings.commonSection}</div>
      <div className="settings-hint">
        {t.settings.planSection}: {t.settings.planAsr} — {asrSummary()} · {t.settings.planLlm} —{' '}
        {llmSummary()}
      </div>
      {/* said once for the whole panel: every 测试连接 button below costs one
          minimal billable request, and tests only ever run on a click */}
      <div className="settings-hint">{t.settings.testFeeNote}</div>

      {window.mc.platform === 'darwin' && (
        <div className="settings-hint">{t.settings.macAudioHint}</div>
      )}
      <div className="settings-row">
        <label>{t.settings.asrBackend}</label>
        <select value={asrBackend} onChange={(e) => setAsrBackend(e.target.value as AsrBackend)}>
          <optgroup label={t.settings.asrLocalGroup}>
            <option value="local-realtime">{t.settings.asrLocalRealtime}</option>
            <option value="local">{t.settings.asrLocalWhisper}</option>
          </optgroup>
          <optgroup label={t.settings.asrCloudGroup}>
            <option value="cloud-realtime">{t.settings.asrCloudRealtime}</option>
            <option value="cloud">{t.settings.asrCloudSeg}</option>
          </optgroup>
        </select>
      </div>
      {asrBackend === 'local-realtime' && (
        <div className="settings-row">
          <label>{t.settings.localRtModel}</label>
          <select value={rtLocalModel} onChange={(e) => setRtLocalModel(e.target.value)}>
            {LOCAL_REALTIME_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {t.uiLang === 'zh' ? m.nameZh : m.nameEn}
              </option>
            ))}
          </select>
        </div>
      )}
      {asrBackend === 'cloud-realtime' && (
        <>
          <div className="settings-row">
            <label>{t.settings.providerPreset}</label>
            {providerSelect('asr-realtime', rtBaseUrl, rtModel, (p) => {
              setRtBaseUrl(p.baseUrl);
              setRtModel(p.model);
            })}
          </div>
          {keyRow(t.settings.rtApiKey, rtKey, 'asr-realtime', rtTarget())}
        </>
      )}
      {asrBackend === 'cloud' && (
        <>
          <div className="settings-row">
            <label>{t.settings.providerPreset}</label>
            {providerSelect('asr-segment', cloudBaseUrl, cloudModel, (p) => {
              setCloudBaseUrl(p.baseUrl);
              setCloudModel(p.model);
            })}
          </div>
          {keyRow(t.settings.cloudApiKey, cloudKey, 'asr-cloud', cloudTarget())}
        </>
      )}
      <div className="settings-row">
        <label>{t.settings.asrLanguage}</label>
        <select value={language} onChange={(e) => setLanguage(e.target.value as AsrLanguage)}>
          <option value="auto">{t.settings.asrLangAuto}</option>
          <option value="chinese">{t.settings.asrLangZh}</option>
          <option value="english">{t.settings.asrLangEn}</option>
        </select>
      </div>

      <div className="settings-row">
        <label>
          {t.settings.planLlm} · {t.settings.providerPreset}
        </label>
        {providerSelect('text-llm', baseUrl, model, (p) => {
          setBaseUrl(p.baseUrl);
          setModel(p.model);
        })}
      </div>
      {keyRow(t.settings.apiKey, llmKey, 'llm', llmTarget())}
      <div className="settings-row">
        <label>{t.settings.answerLangLabel}</label>
        <select value={answerLang} onChange={(e) => setAnswerLang(e.target.value as AnswerLang)}>
          <option value="chinese">{t.settings.answerLangZh}</option>
          <option value="english">{t.settings.answerLangEn}</option>
        </select>
      </div>

      <div className="settings-row">
        <label>{t.settings.uiLang}</label>
        <select value={uiLang} onChange={(e) => setUiLang(e.target.value as UiLang)}>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.theme}</label>
        <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeMode)}>
          <option value="dark">{t.settings.themeDark}</option>
          <option value="light">{t.settings.themeLight}</option>
          <option value="system">{t.settings.themeSystem}</option>
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.fontScaleLabel}</label>
        <select value={fontScale} onChange={(e) => setFontScale(e.target.value as FontScale)}>
          <option value="small">{t.settings.fontSmall}</option>
          <option value="medium">{t.settings.fontMedium}</option>
          <option value="large">{t.settings.fontLarge}</option>
        </select>
      </div>

      <div className="settings-section">{t.uiLang === 'zh' ? '全局快捷键' : 'Global shortcuts'}</div>
      <div className="settings-hint">{t.uiLang === 'zh' ? '例如 Control+Alt+S；留空可禁用。保存时检查重复与占用，失败不会覆盖原快捷键。' : 'Example: Control+Alt+S. Leave empty to disable. Duplicates and conflicts are checked before saving.'}</div>
      {HOTKEYS.map((item) => {
        const status = settings.hotkeys?.find((entry) => entry.id === item.id);
        return <div className="settings-row" key={item.id}>
          <label>{t.uiLang === 'zh' ? item.zh : item.en}</label>
          <input aria-label={item.id} value={shortcuts[item.id]} onChange={(e) => setShortcuts((current) => ({ ...current, [item.id]: e.target.value }))} spellCheck={false} />
          {status && status.accelerator === shortcuts[item.id] && <span className="settings-inline-hint">{!status.accelerator ? (t.uiLang === 'zh' ? '已禁用' : 'Disabled') : status.registered ? (t.uiLang === 'zh' ? '已注册' : 'Registered') : (t.uiLang === 'zh' ? '注册失败：请换一个组合键' : 'Unavailable: choose another shortcut')}</span>}
        </div>;
      })}
      {window.mc.platform === 'win32' && <>
        <div className="settings-hint">{t.uiLang === 'zh' ? '鼠标侧键：保存后全局生效，包括窗口隐藏时。已绑定侧键会替代原来的前进/后退功能；选择“不绑定”恢复。鼠标驱动需保留标准侧键功能。' : 'Mouse side buttons work globally after saving, including while hidden. A binding replaces Back/Forward; choose Unbound to restore. Keep standard side buttons enabled in your mouse driver.'}</div>
        {([['mouseX1', mouseX1, setMouseX1, 1], ['mouseX2', mouseX2, setMouseX2, 2]] as const).map(([id, value, setValue, number]) => <div className="settings-row" key={id}>
          <label>{t.uiLang === 'zh' ? `鼠标侧键 ${number}` : `Mouse side button ${number}`} (XBUTTON{number})</label>
          <select aria-label={id} value={value} onChange={(e) => setValue(e.target.value as typeof mouseX1)}>
            <option value="">{t.uiLang === 'zh' ? '不绑定（保留原功能）' : 'Unbound (original function)'}</option>
            {HOTKEYS.map((item) => <option value={item.id} key={item.id}>{t.uiLang === 'zh' ? item.zh : item.en}</option>)}
          </select>
        </div>)}
        {settings.mouseShortcutStatus === 'failed' && <div role="alert" className="answer-error">{t.uiLang === 'zh' ? '鼠标侧键监听未启动，请重新保存设置或重启软件。' : 'Mouse listener failed. Save again or restart the app.'}</div>}
      </>}
      {saveError && <div role="alert" className="answer-error">{saveError}</div>}
      <div className="settings-row">
        <label>{t.settings.autoLaunch}</label>
        <select
          value={autoLaunch ? 'on' : 'off'}
          onChange={(e) => setAutoLaunch(e.target.value === 'on')}
        >
          <option value="off">{t.settings.autoLaunchOff}</option>
          <option value="on">{t.settings.autoLaunchOn}</option>
        </select>
        <span className="settings-inline-hint">{t.settings.autoLaunchHint}</span>
      </div>

      <div className="settings-section">{t.settings.audioSection}</div>
      <div className="settings-row">
        <label>{t.settings.themDevice}</label>
        <select value={themDeviceId} onChange={(e) => setThemDeviceId(e.target.value)}>
          {deviceOptions}
        </select>
      </div>
      <div className="settings-row">
        <label>{t.settings.micDevice}</label>
        <select value={micDeviceId} onChange={(e) => setMicDeviceId(e.target.value)}>
          {deviceOptions}
        </select>
      </div>
      <div className="settings-hint">{t.settings.otherHint}</div>
      {onOpenHelp && (
        <div className="settings-row">
          <button className="btn" onClick={onOpenHelp}>
            {t.help.title}
          </button>
          <span className="settings-inline-hint">{t.settings.helpHint}</span>
        </div>
      )}

      {onRerunWizard && (
        <div className="settings-row">
          <button className="btn" onClick={onRerunWizard}>
            {t.settings.rerunWizard}
          </button>
          <span className="settings-inline-hint">{t.settings.rerunWizardHint}</span>
        </div>
      )}

      {/* ---------------- 高级 ---------------- */}
      <details className="settings-advanced">
        <summary>{t.settings.advancedSection}</summary>
        <div className="settings-hint">{t.settings.advancedHint}</div>

        {onOpenDiagnostics && (
          <div className="settings-row">
            <button className="btn" onClick={onOpenDiagnostics}>
              {t.diagnostics.title}
            </button>
            <span className="settings-inline-hint">{t.diagnostics.intro}</span>
          </div>
        )}

        <div className="settings-section">{t.settings.textSection}</div>
        <div className="settings-row">
          <label>{t.settings.baseUrl}</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
        </div>
        <div className="settings-row">
          <label>{t.settings.model}</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
        </div>

        <div className="settings-section">{t.settings.asrSection}</div>
        <div className="settings-row">
          <label>{t.settings.rtBaseUrl}</label>
          <input value={rtBaseUrl} onChange={(e) => setRtBaseUrl(e.target.value)} spellCheck={false} />
        </div>
        <div className="settings-row">
          <label>{t.settings.rtModel}</label>
          <input value={rtModel} onChange={(e) => setRtModel(e.target.value)} spellCheck={false} />
        </div>
        <div className="settings-row">
          <label>{t.settings.cloudBaseUrl}</label>
          <input
            value={cloudBaseUrl}
            onChange={(e) => setCloudBaseUrl(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="settings-row">
          <label>{t.settings.cloudModel}</label>
          <input
            value={cloudModel}
            onChange={(e) => setCloudModel(e.target.value)}
            spellCheck={false}
          />
        </div>
      </details>

      {confirmWeak && (
        <div className="settings-warn">
          <div>{t.settings.weakCryptoWarning}</div>
          <div className="settings-actions" style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={() => setConfirmWeak(false)}>
              {t.settings.weakCryptoBack}
            </button>
            <button className="btn btn-sm" onClick={() => void save()}>
              {t.settings.weakCryptoContinue}
            </button>
          </div>
        </div>
      )}

      <div className="settings-actions">
        <button className="btn btn-primary" onClick={requestSave} disabled={saving}>
          {saving ? t.settings.saving : t.settings.save}
        </button>
        <button className="btn" onClick={onClose}>
          {t.settings.cancel}
        </button>
      </div>
    </div>
  );
}
