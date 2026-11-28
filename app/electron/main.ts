import { bankAnswerText, bankMaterialKey, prepareWithoutJob, generalBankKey, matchBankAnswer, parseBankAnswer } from '../shared/interviewBank';
import { LEGACY_GLOBAL_SOURCE } from '../shared/interviewLibrary';
import { semanticBankAnswer } from './llm/interviewBank';
import { MouseShortcuts } from './mouseShortcuts';
import { HOTKEYS, resolveHotkeys, validateHotkeys, type HotkeyConfig, type HotkeyStatus } from '../shared/hotkeys';
import { createWindowMover } from './windowMovement';
import { captureQuietScreenshot, createScreenshotGate } from './screenshot';
import { redactSecrets } from '../shared/redact';
import { configuredVisionSlots, enabledVisionSlots, VISION_SLOTS } from '../shared/visionSlots';
/**
 * MeetingCopilot main process: overlay window, stealth, hotkeys,
 * settings, IPC hub, ASR worker host. PLAN.en.md §5.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { release } from 'os';
import { join } from 'path';
import {
  captureKindForPlatform,
  whisperExecutionProvidersForPlatform,
} from '../shared/platform';
import { AsrHost } from './asrHost';
import {
  LocalPythonProbe,
  buildDiagnosticsReport,
  recentDiagnosticErrors,
  recordDiagnosticError,
} from './diagnostics';
import { openExternalUrl } from './externalLinks';
import { FunasrSidecar, parseLocalWsPort, pythonCandidates, resolvePython } from './funasrSidecar';
import { resolveTestApiKey, runProviderTest, withoutCandidateKey } from './providerTest';
import { getResourceRoot } from './resourcePaths';
import { SettingsStore, plainCipher, type SecretCipher } from './settings';
import { SETUP_READY_MARKER, createSetupWindow } from './setupWindow';
import { AppTray, trayIconPath } from './tray';
import { isRendererCommand, type TrayCommand, type TrayMenuState } from '../shared/trayMenu';
import { KnowledgeStore } from './knowledge';
import { completeBilingualAnswer, interviewDelta, interviewChat, translateTranscript, updateInterviewMemo } from './llm/translate';
import { InterviewLibraryStore } from './interviewLibrary';
import { SessionStore } from './sessions';
import { DOC_EXTENSIONS, extractDocText } from './docparse';
import { basename } from 'path';
import { chatOnce, chatStream, type ChatResult } from './llm/adapter';
import { visionChat } from './llm/vision';
import {
  buildAnswerMessages,
  buildPrewarmMessages,
  buildStablePrefix,
  buildVisionMessages,
} from './llm/prompts';
import type { AnswerLang, AppInfo, PersonalInfo, InterviewLibraryUpdate, PublicSettings, UiLang } from '../shared/protocol';
import {
  IPC,
  type AsrEvent,
  type CaptureTraceEvent,
  type Speaker,
  type LlmAskPayload,
  type LlmEvent,
  type OnboardingCompletePayload,
  type OnboardingProgressPatch,
  type ProviderTestRequest,
  type ProviderTestResult,
  type SettingsPatch,
  type VisionSlot,
  type WorkspaceMode,
} from '../shared/protocol';
import { mainStrings } from './uiStrings';

const MODEL_ID = 'onnx-community/whisper-large-v3-turbo-ONNX';

/** tray 「检查更新」 (Phase 4). A real updater is Phase 5; until then the honest
 * answer is the releases page, opened through the same allowlist as every other
 * documentation link. */
const RELEASES_URL = 'https://github.com/JWM0203/MeetingCopilot/releases/latest';

// Preserve the existing profile and OS-encrypted credentials across source upgrades.
app.setName('MeetingCopilot');
if (process.env.MC_USERDATA) app.setPath('userData', process.env.MC_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  let win: BrowserWindow | null = null;
  /** first-run wizard window; mutually exclusive with `win` until completion */
  let setupWin: BrowserWindow | null = null;
  /** the wizard was reopened from a running main window (设置 → 重新运行配置
   * 向导 / the upgrade notice). Re-run mode never quits the app. */
  let setupRerun = false;
  let settings: SettingsStore;
  let knowledge: KnowledgeStore;
  let sessionStore: SessionStore;
  let interviewLibrary: InterviewLibraryStore;
  let osLang: UiLang = 'zh';
  /** set by before-quit so window handlers stop prompting mid-shutdown */
  let quitting = false;
  /** an ASR-affecting settings patch arrived while the wizard owned the flow */
  let pendingAsrRestart = false;
  /** renderer capture lifecycle; the tray menu and the diagnostics report read it */
  let capturing = false;
  const llmControllers = new Map<string, AbortController>();
  const auxiliaryControllers = new Set<AbortController>();
  const acceptScreenshot = createScreenshotGate();
  const moveWindow = createWindowMover();
  let hotkeyStatuses: HotkeyStatus[] = [];
  const mouseShortcuts = new MouseShortcuts(getResourceRoot(), (action) => shortcutActions()[action]());
  function stopAllAnswers(): void {
    for (const controller of auxiliaryControllers) controller.abort();
    auxiliaryControllers.clear();
    for (const [requestId, controller] of llmControllers) {
      controller.abort();
      win?.webContents.send(IPC.llmEvent, { requestId, kind: 'cancelled' });
    }
    llmControllers.clear();
    acceptScreenshot.clear();
    win?.webContents.send(IPC.trayCommand, { command: 'stop-all-answers' });
  }
  const asr = new AsrHost();
  const sidecar = new FunasrSidecar();
  const tray = new AppTray();

  /** main-process strings in the current UI language */
  const T = () => mainStrings(settings.data.ui.lang, osLang);

  /** getPublic() + real knowledge char count (KB lives outside settings.json) */
  function publicSettings(): PublicSettings {
    const pub = settings.getPublic();
    pub.knowledge = { chars: knowledge.chars };
    pub.hotkeys = hotkeyStatuses;
    pub.mouseShortcutStatus = mouseShortcuts.status;
    return pub;
  }

  function buildAsrOptions() {
    const a = settings.data.asr;
    const backend = a.backend ?? 'local';
    // each backend has its own config slot so switching never clobbers the others
    let cloud: { baseUrl: string; model: string; apiKey: string } | undefined;
    if (backend === 'local-realtime') {
      // fixed localhost sidecar (auto-spawned); only the model is a choice
      cloud = {
        baseUrl: 'ws://127.0.0.1:10097',
        model: a.localRealtime?.model ?? 'fun-asr-nano',
        apiKey: '',
      };
    } else if (backend === 'cloud-realtime') {
      const rtKey = settings.getRealtimeAsrApiKey() ?? '';
      if (a.realtime?.baseUrl && a.realtime?.model && rtKey) {
        cloud = { baseUrl: a.realtime.baseUrl, model: a.realtime.model, apiKey: rtKey };
      }
    } else if (a.cloud?.baseUrl && a.cloud?.model && settings.getCloudAsrApiKey()) {
      cloud = { baseUrl: a.cloud.baseUrl, model: a.cloud.model, apiKey: settings.getCloudAsrApiKey()! };
    }
    return {
      // the worker treats both realtime flavors identically (same WS engine)
      backend: (backend === 'local-realtime' ? 'cloud-realtime' : backend) as
        | 'local'
        | 'cloud'
        | 'cloud-realtime',
      modelsDir: a.modelsDir ?? join(app.getPath('userData'), 'models'),
      modelId: MODEL_ID,
      ep: whisperExecutionProvidersForPlatform(process.platform),
      language: a.language,
      preconnectOnCapture: backend === 'cloud-realtime',
      cloud,
    };
  }

  /** start the ASR worker; a local ws:// realtime backend auto-spawns the
   * python sidecar first (selecting the preset is all the user does) */
  async function startAsr(): Promise<void> {
    if (settings.data.ui.workspace === 'written') return;
    const opts = buildAsrOptions();
    const port = opts.backend === 'cloud-realtime' ? parseLocalWsPort(opts.cloud?.baseUrl) : null;
    if (port) {
      try {
        // NOT app.getAppPath(): packaged that resolves inside app.asar, which
        // python cannot read and the OS cannot use as a spawn cwd
        await sidecar.ensureRunning(port, getResourceRoot(), opts.cloud?.model);
        console.log(`[sidecar] local ASR ready on :${port}`);
      } catch (e) {
        const message = T().sidecarFail((e as Error).message);
        console.error(`[sidecar] ${message}`);
        recordDiagnosticError('sidecar', (e as Error).message);
        win?.webContents.send(IPC.asrEvent, { kind: 'error', message, fatal: true });
        return;
      }
    } else {
      await sidecar.stop(); // switched away from local — reclaim its RAM/VRAM
    }
    if (settings.getPublic().ui.workspace === 'written') {
      await sidecar.stop();
      return;
    }
    asr.start(opts);
  }

  const safeCipher: SecretCipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    secure: true,
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };

  function cipher(): SecretCipher {
    if (safeCipher.available()) return safeCipher;
    console.warn('[security] OS secret storage unavailable; API keys will only be obfuscated');
    return plainCipher;
  }

  // ---- window visibility + system tray ----------------------------------
  // Quit/hide matrix (Phase 4):
  //   hide  (hotkey / 「—」 / tray toggle) -> window stays alive, app keeps
  //         running, tray is the way back; NEVER quits.
  //   quit  (titlebar ✕ / tray 退出 / OS shutdown) -> app.quit() -> before-quit
  //         reaps the ASR utilityProcess, the python sidecar and the tray.
  //   first-run wizard closed without completing -> app.quit() (Phase 2), since
  //         nothing is configured and no main window exists yet.
  //   re-run wizard closed -> main window keeps running; window-all-closed does
  //         not fire because the overlay is still open (possibly hidden).

  function showWindow(): void {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function toggleWindow(): void {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  }

  function trayState(): TrayMenuState {
    return { windowVisible: !!win?.isVisible(), capturing };
  }

  /** rebuild the tray menu — call after anything the menu shows has changed */
  function refreshTray(): void {
    tray.refresh();
  }

  function handleTrayCommand(command: TrayCommand): void {
    if (command === 'quit') {
      app.quit();
      return;
    }
    if (command === 'toggle-window') {
      toggleWindow();
      return;
    }
    if (command === 'check-updates') {
      void openExternalUrl(RELEASES_URL);
      return;
    }
    if (isRendererCommand(command)) {
      // capture, sessions and the panels live in the renderer; a hidden window
      // would swallow the result, so make it visible first
      showWindow();
      win?.webContents.send(IPC.trayCommand, { command });
    }
  }

  function ensureTray(): void {
    if (tray.exists) return;
    tray.create({
      iconPath: trayIconPath(getResourceRoot()),
      labels: () => T().tray,
      state: trayState,
      onCommand: handleTrayCommand,
      onClick: toggleWindow,
      onDoubleClick: showWindow,
    });
  }

  /** one-shot balloon the first time the window disappears (spec §A) */
  function noticeWindowHidden(): void {
    if (!tray.exists || settings.data.ui.trayNoticeShown) return;
    settings.applyPatch({ ui: { trayNoticeShown: true } });
    const t = T();
    tray.notifyHidden(t.trayNoticeTitle, t.trayNoticeBody);
    console.log('[tray] hide notice shown once');
  }

  /**
   * 开机自动启动. Deliberately inert in development: `setLoginItemSettings`
   * would register the electron.exe dev launcher (and on Linux Electron does
   * not implement it at all), so the stored intent is kept and applied by the
   * installed build instead.
   */
  function applyAutoLaunch(enabled: boolean): void {
    if (process.platform === 'linux') return;
    if (!app.isPackaged) {
      console.log(`[autolaunch] ${enabled ? 'on' : 'off'} stored; not applied in a dev build`);
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
    } catch (e) {
      console.warn('[autolaunch] could not be applied:', (e as Error).message);
    }
  }

  /** the OS is the source of truth; reconcile it with the stored intent once */
  function syncAutoLaunch(): void {
    if (process.platform === 'linux' || !app.isPackaged) return;
    const wanted = !!settings.data.ui.autoLaunch;
    try {
      if (app.getLoginItemSettings().openAtLogin !== wanted) applyAutoLaunch(wanted);
    } catch (e) {
      console.warn('[autolaunch] could not be read:', (e as Error).message);
    }
  }

  function checkHotkeys(config: HotkeyConfig): void {
    validateHotkeys(config);
    const tested: string[] = [];
    try {
      for (const item of HOTKEYS) {
        const key = config[item.id].trim();
        if (!key || globalShortcut.isRegistered(key)) continue;
        if (!globalShortcut.register(key, () => {})) throw new Error(`${item.zh} / ${item.en}: 快捷键已被占用 / Shortcut unavailable (${key})`);
        tested.push(key);
      }
    } finally { for (const key of tested) globalShortcut.unregister(key); }
  }

  function shortcutActions(): Record<keyof HotkeyConfig, () => void> {
    return {
      hotkeyToggle: toggleWindow,
      hotkeyShot: () => win?.webContents.send(IPC.shotHotkey),
      hotkeyClear: () => win?.webContents.send(IPC.trayCommand, { command: 'clear-answers' }),
      hotkeyStop: stopAllAnswers,
      hotkeyLeft: () => moveWindow(win, screen.getAllDisplays().map((d) => d.workArea), -40, 0),
      hotkeyRight: () => moveWindow(win, screen.getAllDisplays().map((d) => d.workArea), 40, 0),
      hotkeyUp: () => moveWindow(win, screen.getAllDisplays().map((d) => d.workArea), 0, -40),
      hotkeyDown: () => moveWindow(win, screen.getAllDisplays().map((d) => d.workArea), 0, 40),
    };
  }

  function registerHotkeys(): void {
    globalShortcut.unregisterAll();
    const actions = shortcutActions();
    const config = resolveHotkeys(settings.data.ui);
    hotkeyStatuses = HOTKEYS.map((item) => {
      const accelerator = config[item.id].trim();
      let registered = false;
      try { registered = !!accelerator && globalShortcut.register(accelerator, actions[item.id]); }
      catch { /* Report an invalid or unavailable key in the settings panel. */ }
      return { id: item.id, accelerator, registered };
    });
  }

  function createWindow(): void {
    win = new BrowserWindow({
      width: 940,
      height: 560,
      minWidth: 420,
      minHeight: 280,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(settings.data.ui.stealth);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    win.webContents.on('did-finish-load', () => {
      // replay cached ASR state for late-attaching renderer
      if (asr.lastReady) win?.webContents.send(IPC.asrEvent, asr.lastReady);
      if (asr.lastStatus) win?.webContents.send(IPC.asrEvent, asr.lastStatus);
      if (process.env.MC_AUTOSTART === '1') {
        // executeJavaScript(code, true) supplies the user gesture that
        // getDisplayMedia needs — used by the E2E smoke test.
        void win?.webContents.executeJavaScript(
          'window.__mcAutoStart && window.__mcAutoStart()',
          true,
        );
      }
      // E2E: exercise the FULL renderer->IPC->main->LLM->stream->renderer path.
      if (process.env.MC_E2E_LLM) {
        const q = process.env.MC_E2E_LLM;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.llmAsk({requestId:'e2e-llm',mode:'free',freeQuestion:${JSON.stringify(q)},recentTranscript:[]});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-llm]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-llm] threw', (e as Error).message));
      }
      // Visual QA of the main window (same spirit as MC_SETUP_SHOT for the
      // wizard): open the settings panel, let it paint, capture a PNG.
      if (process.env.MC_MAIN_SHOT) {
        const dir = process.env.MC_MAIN_SHOT;
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const shoot = async (name: string): Promise<void> => {
          const image = await win?.webContents.capturePage();
          if (!image) return;
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `${name}.png`);
          writeFileSync(file, image.toPNG());
          console.log(`[main] screenshot ${file}`);
        };
        void (async () => {
          try {
            await win?.webContents.executeJavaScript(
              'window.__mcOpenSettings && window.__mcOpenSettings()',
              true,
            );
            await wait(1200);
            await shoot('main-settings-common');
            // expand 高级 and scroll to it, so the collapsed half is reviewable too
            await win?.webContents.executeJavaScript(
              `(()=>{const p=document.querySelector('.settings');if(!p)return 0;p.querySelectorAll('details').forEach(d=>d.open=true);p.scrollTop=p.scrollHeight;return p.scrollHeight;})()`,
            );
            await wait(600);
            await shoot('main-settings-advanced');
          } catch (e) {
            console.warn('[main] screenshot failed:', (e as Error).message);
          }
        })();
      }
      if (process.env.MC_E2E_SHOT) {
        const q = process.env.MC_E2E_SHOT;
        const js = `(async()=>{const d=[];const done=new Promise(r=>{const off=window.mc.onLlmEvent(e=>{if(e.kind==='delta')d.push(e.text);else if(e.kind==='done'){off();r({ok:true,text:e.text||d.join('')});}else if(e.kind==='error'){off();r({ok:false,error:e.message});}});});window.mc.shotAsk({requestId:'e2e-shot',question:${JSON.stringify(q)}});return await done;})()`;
        void win?.webContents
          .executeJavaScript(js, true)
          .then((r) => console.log('[e2e-shot]', JSON.stringify(r)))
          .catch((e) => console.log('[e2e-shot] threw', (e as Error).message));
      }
    });

    // the tray menu shows 显示/隐藏窗口, so it has to follow the real state —
    // whichever of the four hide paths was used (hotkey, 「—」, tray, IPC)
    // "where did my window go" is THE support question for a frameless,
    // taskbar-less, content-protected overlay, so both transitions are logged
    win.on('show', () => {
      console.log('[window] shown');
      refreshTray();
    });
    win.on('hide', () => {
      console.log('[window] hidden');
      refreshTray();
      noticeWindowHidden();
    });

    win.on('closed', () => {
      win = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    // the tray belongs to the running app, not to the first-run wizard: an
    // unconfigured machine that closes the wizard must still quit (Phase 2)
    ensureTray();
  }

  /** normal boot: warm the ASR worker, bind hotkeys, show the overlay */
  function startMainApp(): void {
    if (settings.data.ui.workspace !== 'written') void startAsr();
    registerHotkeys();
    mouseShortcuts.configure(settings.data.ui.mouseX1, settings.data.ui.mouseX2);
    syncAutoLaunch();
    createWindow();
  }

  /**
   * First-run gate. While the wizard is up there is no ASR worker, no python
   * sidecar, no cloud connection and no LLM prewarm — an unconfigured machine
   * must not spawn anything.
   */
  function openSetupWindow(rerun = false): void {
    if (setupWin) {
      if (setupWin.isMinimized()) setupWin.restore();
      setupWin.show();
      setupWin.focus();
      return;
    }
    setupRerun = rerun;
    const w = createSetupWindow();
    setupWin = w;

    // E2E: drive the wizard->main-app handover without a human click
    if (process.env.MC_E2E_ONBOARDING_COMPLETE === '1') {
      w.webContents.on('did-finish-load', () => {
        void w.webContents.executeJavaScript('window.mcSetup.completeOnboarding({})', true);
      });
    }

    w.on('close', (e) => {
      // completion closes this window programmatically, an OS shutdown /
      // app.quit() must never be blocked by a modal, and a re-run just puts
      // the user back into a working app — no prompt in any of those cases
      if (quitting || setupRerun || settings.data.onboarding.completed) return;
      const t = T();
      const choice = dialog.showMessageBoxSync(w, {
        type: 'warning',
        title: t.setupQuitTitle,
        message: t.setupQuitTitle,
        detail: t.setupQuitMessage,
        buttons: [t.setupQuitConfirm, t.setupQuitCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice !== 0) e.preventDefault();
    });

    w.on('closed', () => {
      const wasRerun = setupRerun;
      setupWin = null;
      setupRerun = false;
      if (wasRerun) {
        // keys saved before the user backed out still have to reach the engine
        if (pendingAsrRestart) {
          pendingAsrRestart = false;
          void asr.stop().then(() => startAsr());
        }
        win?.focus();
        return;
      }
      // first-run launch closed without finishing => nothing is configured and
      // there is no other window; Phase 4 adds a tray
      if (!settings.data.onboarding.completed) app.quit();
    });
  }

  app.whenReady().then(() => {
    // users who never chose a UI language get their OS language (zh → zh, else en)
    osLang = app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
    settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), cipher(), osLang);
    knowledge = new KnowledgeStore(join(app.getPath('userData'), 'knowledge.md'));
    sessionStore = new SessionStore(join(app.getPath('userData'), 'sessions.json'));
    let history;
    try {
      history = sessionStore.load();
    } catch (error) {
      const hint = osLang === 'zh' ? '请备份并修复该文件或恢复读取权限，然后重新启动。' : 'Back up and repair the file or restore read access, then restart.';
      dialog.showErrorBox('MeetingCopilot', `${(error as Error).message}\n\n${hint}`);
      app.quit();
      return;
    }
    interviewLibrary = new InterviewLibraryStore(join(app.getPath('userData'), 'interview-library.sqlite'), history.sessions);

    // Electron's `audio: loopback` display-media source is Windows-only.
    // macOS/Linux use a selectable ordinary input in the renderer instead.
    if (captureKindForPlatform(process.platform) === 'loopback') {
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
          .catch((e) => {
            console.error('[main] display media handler failed:', e);
            callback({});
          });
      });
    }

    // ---- IPC ----
    const frameBatches = new Map<Speaker, {
      sid: string; event: Extract<CaptureTraceEvent, { kind: 'frames' }>; timer: NodeJS.Timeout;
    }>();
    function flushFrames(speaker: Speaker) {
      const batch = frameBatches.get(speaker);
      if (!batch) return;
      clearTimeout(batch.timer);
      frameBatches.delete(speaker);
      win?.webContents.send(IPC.captureTrace, batch.sid, batch.event);
    }
    function recordChannel(speaker: Speaker, active: boolean, sid?: string) {
      flushFrames(speaker);
      if (sid) win?.webContents.send(IPC.captureTrace, sid, { kind: 'channel', at: Date.now(), speaker, active } satisfies CaptureTraceEvent);
    }
    ipcMain.on(IPC.capturePcm, (_e, buf: ArrayBuffer, captureTs: number, channel: Speaker, sid?: string) => {
      const speaker = channel === 'me' ? 'me' : 'them';
      const forwarded = asr.sendPcm(buf, captureTs, speaker, sid);
      if (!sid) return;
      const at = Date.now();
      let batch = frameBatches.get(speaker);
      if (!batch || batch.sid !== sid) {
        flushFrames(speaker);
        batch = { sid, event: { kind: 'frames', speaker, at, lastAt: at, firstCaptureTs: captureTs,
          lastCaptureTs: captureTs, count: 0, forwarded: 0 }, timer: setTimeout(() => flushFrames(speaker), 5000) };
        frameBatches.set(speaker, batch);
      }
      batch.event.count++;
      if (forwarded) batch.event.forwarded++;
      batch.event.lastAt = at;
      batch.event.lastCaptureTs = captureTs;
    });

    // ---- P1-6: DeepSeek prefix-cache prewarm + keep-warm while capturing ----
    // One max_tokens=1 request with the byte-identical stable prefix builds the
    // provider-side KV cache, so the first real answer prefills at 0.1x price
    // and lower latency. Re-ping when the cache would go cold (same pattern as
    // the ASR 45s keep-warm). Real answer requests refresh the cache themselves.
    const PREWARM_IDLE_MS = 4 * 60_000;
    let lastPrefix: string | null = null;
    let lastPrefixActivity = 0; // last time the answer prefix hit the provider
    let keepWarmTimer: NodeJS.Timeout | null = null;

    function stablePrefixFor(resume?: string, jd?: string, info?: PersonalInfo): string {
      return buildStablePrefix(resume ?? '', jd ?? '', settings.data.llm.answerLang, info);
    }

    async function doPrewarm(prefix: string, reason: string): Promise<void> {
      const apiKey = settings.getLlmApiKey();
      if (!apiKey || settings.data.llm.answerWithVision) return; // vision path ≠ DeepSeek
      lastPrefix = prefix;
      lastPrefixActivity = Date.now();
      try {
        const r = await chatOnce(
          { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
          buildPrewarmMessages(prefix),
          { maxTokens: 1 },
        );
        console.log(
          `[prewarm] ${reason}: cache_hit=${r.usage?.prompt_cache_hit_tokens ?? '?'} cache_miss=${r.usage?.prompt_cache_miss_tokens ?? '?'} prompt=${r.usage?.prompt_tokens ?? '?'}`,
        );
      } catch (e) {
        console.warn('[prewarm] failed:', (e as Error).message);
      }
    }

    ipcMain.on(
      IPC.llmPrewarm,
      (_e, payload: { resume?: string; jd?: string; personalInfo?: PersonalInfo; immediate?: boolean } = {}) => {
        const prefix = stablePrefixFor(payload.resume, payload.jd, payload.personalInfo);
        const dirty = prefix !== lastPrefix;
        const cold = Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS;
        if (!dirty && !cold) return;
        if (payload.immediate || capturing) {
          void doPrewarm(prefix, dirty ? 'dirty' : 'refresh');
        } else {
          lastPrefix = null; // mark stale; the next ▶ prewarm sees dirty and reheats
        }
      },
    );

    // last-known capture lifecycle, for the diagnostics report only
    let lastCaptureStartedAt: string | undefined;
    let lastCaptureStoppedAt: string | undefined;

    ipcMain.on(IPC.captureStarted, () => {
      console.log('[main] capture started');
      lastCaptureStartedAt = new Date().toISOString();
      capturing = true;
      refreshTray(); // 开始转写 -> 停止转写
      if (!keepWarmTimer) {
        keepWarmTimer = setInterval(() => {
          if (!capturing || !lastPrefix) return;
          if (Date.now() - lastPrefixActivity >= PREWARM_IDLE_MS) {
            void doPrewarm(lastPrefix, 'keep-warm');
          }
        }, 60_000);
      }
    });
    ipcMain.on(IPC.captureStopped, (_e, sid?: string) => {
      recordChannel('them', false, sid);
      console.log('[main] capture stopped');
      lastCaptureStoppedAt = new Date().toISOString();
      capturing = false;
      refreshTray();
      if (keepWarmTimer) {
        clearInterval(keepWarmTimer);
        keepWarmTimer = null;
      }
      asr.setCapture('them', false);
    });
    ipcMain.on(IPC.captureChannel, (_e, channel: Speaker, active: boolean, sid?: string) => {
      if ((channel === 'them' || channel === 'me') && typeof active === 'boolean') {
        asr.setCapture(channel, active, sid);
        recordChannel(channel, active, sid);
      }
    });
    ipcMain.handle(IPC.settingsGet, () => publicSettings());
    // pull-based replay: renderer asks after subscribing, so instant-ready
    // cloud engines can't race the subscription (stuck "模型加载中" bug)
    ipcMain.handle(IPC.asrReplay, () => ({ ready: asr.lastReady, status: asr.lastStatus }));
    ipcMain.handle(IPC.settingsSet, async (_e, patch: SettingsPatch) => {
      const previousWorkspace = settings.data.ui.workspace ?? 'interview';
      if (patch.ui && HOTKEYS.some((key) => patch.ui?.[key.id] !== undefined)) checkHotkeys(resolveHotkeys({ ...settings.data.ui, ...patch.ui }));
      settings.applyPatch(patch);
      if (patch.ui?.mouseX1 !== undefined || patch.ui?.mouseX2 !== undefined) {
        mouseShortcuts.configure(settings.data.ui.mouseX1, settings.data.ui.mouseX2);
      }
      if (patch.ui && HOTKEYS.some((key) => patch.ui?.[key.id] !== undefined)) {
        registerHotkeys();
      }
      if (patch.ui?.stealth !== undefined) {
        win?.setContentProtection(patch.ui.stealth);
      }
      // the tray menu is a snapshot: rebuild it in the newly chosen language
      if (patch.ui?.lang !== undefined) refreshTray();
      if (patch.ui?.autoLaunch !== undefined) applyAutoLaunch(patch.ui.autoLaunch);
      if (patch.ui?.workspace && patch.ui.workspace !== previousWorkspace) {
        await asr.stop();
        await sidecar.stop();
        asr.lastReady = null;
        asr.lastStatus = null;
        if (patch.ui.workspace === 'interview' && !setupWin && settings.data.onboarding.completed) {
          void startAsr();
        }
      }
      // backend/cloud change => rebuild the ASR worker with the new engine.
      // language alone can hot-update without a restart.
      if (
        patch.asr &&
        (patch.asr.backend !== undefined ||
          patch.asr.cloud !== undefined ||
          patch.asr.realtime !== undefined ||
          patch.asr.localRealtime !== undefined)
      ) {
        // While the wizard is up the engine must NOT be rebuilt per key save:
        // on a first run nothing is configured yet (a restart would spawn the
        // local python sidecar the user never agreed to), and in a re-run it
        // would bounce the live engine once per card. The wizard writes its
        // plan as one final patch; the restart happens exactly once after it.
        if (setupWin || !settings.data.onboarding.completed) pendingAsrRestart = true;
        else if (settings.data.ui.workspace !== 'written') void asr.stop().then(() => startAsr());
      } else if (patch.asr?.language) {
        asr.setLanguage(patch.asr.language);
      }
      return publicSettings();
    });
    // ---- first-run wizard state (settings v2) ----
    let wizardReadyLogged = false;
    ipcMain.handle(IPC.onboardingGet, (e) => {
      // one-shot boot marker: the wizard's own renderer reached main, which
      // proves setup.html loaded, its module graph ran and the setup preload
      // bridge is live. tools/packaged-smoke.mjs asserts it.
      if (!wizardReadyLogged && setupWin && e.sender === setupWin.webContents) {
        wizardReadyLogged = true;
        console.log(SETUP_READY_MARKER);
      }
      return settings.getOnboarding();
    });
    ipcMain.handle(IPC.onboardingSaveProgress, (_e, patch: OnboardingProgressPatch = {}) =>
      settings.saveOnboardingProgress(patch ?? {}),
    );
    ipcMain.handle(IPC.onboardingComplete, (_e, payload: OnboardingCompletePayload = {}) => {
      const state = settings.completeOnboarding(payload ?? {});
      // create the main window BEFORE closing the wizard: closing the last
      // window first would fire window-all-closed and quit the app mid-handover
      if (!win) {
        // startMainApp() already builds the engine from the finished settings
        startMainApp();
      } else if (pendingAsrRestart) {
        // re-run: the main window kept running, so apply the deferred rebuild
        void asr.stop().then(() => startAsr());
      }
      pendingAsrRestart = false;
      setupWin?.close();
      return state;
    });
    // main window -> "重新运行配置向导" / the upgrade notice
    ipcMain.handle(IPC.onboardingRerun, () => {
      openSetupWindow(true);
      return true;
    });

    // ---- app shell services (wizard + main window) ----
    // The renderer never navigates: window.open is denied and will-navigate is
    // prevented, so documentation links come back here to be validated.
    ipcMain.handle(IPC.externalOpen, (_e, url: unknown) => openExternalUrl(url));
    // read on an explicit paste-button click only — never polled
    ipcMain.handle(IPC.clipboardReadText, () => clipboard.readText());
    ipcMain.handle(
      IPC.appGetInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        packaged: app.isPackaged,
      }),
    );

    // ---- provider connection tests (Phase 3) ----
    // Runs ONLY on an explicit user action from the wizard or Settings. The
    // candidate key lives in a local const for the duration of one call: it is
    // never persisted here, never logged, and never travels back to the
    // renderer inside the result.
    ipcMain.handle(
      IPC.providerTest,
      async (_e, incoming: ProviderTestRequest): Promise<ProviderTestResult> => {
        const req = incoming ?? ({} as ProviderTestRequest);
        const apiKey = resolveTestApiKey(req, (slot) => settings.getApiKeyForSlot(slot));
        // the plaintext candidate stops here: everything downstream sees a
        // request without it, and the key only as a separate argument
        const request = withoutCandidateKey(req);
        const result = await runProviderTest(
          { ...request, language: request.language ?? settings.data.asr.language },
          apiKey,
        );
        // one dedicated write; applyPatch() would restart the ASR engine
        if (request.slot) {
          settings.recordVerification(request.slot, {
            lastTestAt: new Date().toISOString(),
            lastTestOk: result.ok,
            lastTestCode: result.code,
            latencyMs: result.latencyMs,
          });
        }
        if (!result.ok) {
          recordDiagnosticError(
            `provider-test/${request.capability}`,
            `${result.code} (${request.providerId} ${request.model})`,
          );
        }
        console.log(
          `[provider-test] ${request.capability} ${request.providerId} -> ${result.code} (${result.latencyMs ?? '?'}ms)`,
        );
        return result;
      },
    );

    // ---- local diagnostics (Phase 3) ----
    // Purely local: built on request, returned to the renderer for the user to
    // copy. Nothing is uploaded, nothing is written to disk, and the builder
    // never receives a key, a transcript or any knowledge-base text.
    const pythonProbe = new LocalPythonProbe(() =>
      resolvePython(pythonCandidates(getResourceRoot())),
    );

    ipcMain.handle(IPC.diagnosticsGet, (): string => {
      pythonProbe.start(); // background; 'unknown' until it settles
      const ready = asr.lastReady?.kind === 'ready' ? asr.lastReady : null;
      const status = asr.lastStatus?.kind === 'status' ? asr.lastStatus : null;
      return buildDiagnosticsReport({
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
        uiLang: osLang,
        settings: settings.data,
        weakCrypto: settings.getPublic().weakCrypto,
        knowledgeChars: knowledge.chars,
        capture: {
          active: capturing,
          lastStartedAt: lastCaptureStartedAt,
          lastStoppedAt: lastCaptureStoppedAt,
        },
        asr: {
          ready: !!ready,
          ep: ready?.ep,
          gpuSuspect: ready?.gpuSuspect,
          state: status?.state,
        },
        localPython: pythonProbe.status,
        errors: recentDiagnosticErrors(),
        generatedAt: new Date(),
      });
    });

    ipcMain.handle(IPC.logsOpenFolder, async (): Promise<boolean> => {
      // userData holds settings.json, sessions.json and knowledge.md -- the
      // exact folder a user needs when asked to check or wipe their data
      const err = await shell.openPath(app.getPath('userData'));
      if (err) console.warn('[diagnostics] could not open the data folder:', err);
      return err === '';
    });

    ipcMain.handle(IPC.knowledgeImport, async () => {
      const r = await dialog.showOpenDialog({
        title: T().kbImportTitle,
        filters: [{ name: 'Markdown/Text', extensions: ['md', 'markdown', 'txt'] }],
        properties: ['openFile'],
      });
      if (!r.canceled && r.filePaths[0]) {
        try {
          knowledge.setFromText(readFileSync(r.filePaths[0], 'utf8'));
        } catch (e) {
          console.error('[knowledge] import failed:', (e as Error).message);
        }
      }
      return { chars: knowledge.chars };
    });
    ipcMain.handle(IPC.knowledgeClear, () => {
      knowledge.clear();
      return { chars: knowledge.chars };
    });
    ipcMain.handle(IPC.knowledgePick, async (_e, slot: 'resume' | 'jd' | 'legacy' = 'resume') => {
      if (slot === 'legacy') {
        let text = knowledge.text;
        if (!text.trim()) {
          const library = interviewLibrary.get();
          if (library.resumeSource === LEGACY_GLOBAL_SOURCE) text = library.resumeText;
        }
        return { name: 'knowledge.md', text, chars: text.length };
      }
      const r = await dialog.showOpenDialog({
        title: slot === 'jd' ? T().pickJdTitle : T().pickResumeTitle,
        filters: [{ name: T().docFilter, extensions: [...DOC_EXTENSIONS] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      try {
        // deterministic parse (mammoth / pdf-parse) — no LLM in the loop;
        // '' for scanned PDFs, the renderer warns the user
        const text = await extractDocText(r.filePaths[0]);
        return { name: basename(r.filePaths[0]), text, chars: text.length };
      } catch (e) {
        console.error('[knowledge] pick failed:', (e as Error).message);
        return null;
      }
    });
    ipcMain.handle(IPC.libraryGet, () => interviewLibrary.get());
    ipcMain.handle(IPC.librarySave, (_e, value: InterviewLibraryUpdate) => interviewLibrary.save(value));
    ipcMain.handle(IPC.libraryPrepare, async (_e, payload: { requestId: string; question: string; resume?: string; jd?: string; personalInfo?: PersonalInfo }) => {
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      try {
        const generic = prepareWithoutJob(payload.question);
        const text = await interviewChat(settings, buildAnswerMessages({ mode: 'segment', question: payload.question,
          recentTranscript: [], resume: payload.resume, jd: generic ? undefined : payload.jd, personalInfo: payload.personalInfo, answerLang: 'english' }), T().noApiKeyShort, ac.signal);
        ac.signal.throwIfAborted();
        const completed = await completeBilingualAnswer(text, (messages) => interviewChat(settings, messages, T().noApiKeyShort, ac.signal));
        ac.signal.throwIfAborted();
        return parseBankAnswer(completed, generic ? generalBankKey(payload.resume, payload.personalInfo) : bankMaterialKey(payload.resume, payload.jd, payload.personalInfo));
      } finally { llmControllers.delete(payload.requestId); }
    });
    ipcMain.handle(IPC.sessionsLoad, () => sessionStore.load());
    ipcMain.handle(IPC.sessionsSave, (_e, data) => sessionStore.save(data));

    ipcMain.handle(IPC.regionPick, () => captureQuietScreenshot(getResourceRoot()));
    ipcMain.handle(IPC.stealthSet, (_e, on: boolean) => {
      settings.applyPatch({ ui: { stealth: on } });
      win?.setContentProtection(on);
      return on;
    });
    ipcMain.on(IPC.winHide, () => win?.hide());
    ipcMain.on(IPC.appQuit, () => app.quit());

    // ---- LLM (R4): streaming answers; key stays in the main process ----
    ipcMain.on(IPC.llmAsk, (_e, payload: LlmAskPayload) => {
      const sendEv = (ev: LlmEvent) => win?.webContents.send(IPC.llmEvent, ev);
      const useBank = !payload.bankChecked && !payload.rewrite && (payload.mode === 'segment' || payload.mode === 'continuous');
      const bank = useBank ? interviewLibrary.get() : undefined;
      const bankResume = payload.resume || payload.background;
      const cached = bank && matchBankAnswer(payload.question ?? '', bank, bankMaterialKey(bankResume, payload.jd, payload.personalInfo), generalBankKey(bankResume, payload.personalInfo));
      if (cached && cached.score === 1) {
        sendEv({ requestId: payload.requestId, kind: 'model', modelName: '题库 / Saved answer', bankQuestion: cached.question, visionSlot: payload.visionSlot });
        sendEv({ requestId: payload.requestId, kind: 'done', bankQuestion: cached.question, text: bankAnswerText(cached.answer, payload.answerLang ?? settings.data.llm.answerLang) });
        return;
      }
      const useVision = payload.rewrite ? !!payload.visionSlot : !!settings.data.llm.answerWithVision;
      const slots = useVision ? enabledVisionSlots(settings.getPublic().vision, 'interview') : [];
      const vision = slots.find((slot) => slot.id === (payload.mode === 'translate' ? slots[0]?.id : payload.visionSlot ?? slots[0]?.id));
      const apiKey = useVision ? vision && settings.getVisionApiKey(vision.id) : settings.getLlmApiKey();
      if (!apiKey) {
        sendEv({ requestId: payload.requestId, kind: 'error', message: useVision ? T().noVision : T().noApiKey });
        return;
      }
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      const isTranslate = payload.mode === 'translate';
      const messages = buildAnswerMessages({
        mode: payload.mode,
        rewrite: payload.rewrite,
        personalInfo: payload.personalInfo,
        question: payload.question,
        freeQuestion: payload.freeQuestion,
        recentTranscript: payload.recentTranscript,
        answerLang: payload.answerLang ?? settings.data.llm.answerLang,
        history: payload.history,
        resume: isTranslate ? undefined : payload.resume,
        jd: isTranslate ? undefined : payload.jd,
        memo: isTranslate ? undefined : payload.memo,
        background: isTranslate ? undefined : payload.background,
      });

      // "answer with multimodal": route through the vision provider (proxy-aware,
      // non-streaming). Otherwise stream from the text LLM (direct, fastest).

      // a real answer request refreshes the provider-side prefix cache itself
      if (!isTranslate && !useVision && payload.mode !== 'free') {
        lastPrefix = stablePrefixFor(payload.resume || payload.background, payload.jd, payload.personalInfo);
        lastPrefixActivity = Date.now();
      }

      const streamVision = !!vision && /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(vision.config.baseUrl!);
      const bilingual = !isTranslate && (payload.answerLang ?? settings.data.llm.answerLang) === 'english';
      const push = interviewDelta(bilingual, (text) => {
        if (!ac.signal.aborted) sendEv({ requestId: payload.requestId, kind: 'delta', text });
      });
      const generate = (input = messages, onDelta?: (text: string) => void) => vision
        ? visionChat(
            {
              baseUrl: vision.config.baseUrl!,
              model: vision.config.model!,
              apiKey,
              proxyUrl: vision.config.proxyUrl,
            },
            input, ac.signal, streamVision ? onDelta : undefined,
          ).then((text) => {
            if (!streamVision) onDelta?.(text);
            return { text };
          })
        : chatStream(
            { baseUrl: settings.data.llm.baseUrl, model: settings.data.llm.model, apiKey },
            input, { onDelta: onDelta ?? (() => {}) },
            ac.signal,
          );

      const work = (async () => {
        if (bank) {
          const saved = await semanticBankAnswer(settings, bank, payload, ac.signal);
          ac.signal.throwIfAborted();
          if (saved) {
            sendEv({ requestId: payload.requestId, kind: 'model', modelName: '题库 / Saved answer', bankQuestion: saved.question, visionSlot: payload.visionSlot });
            return { text: saved.text, bankQuestion: saved.question };
          }
        }
        sendEv({ requestId: payload.requestId, kind: 'model', modelName: vision ? vision.config.model! : settings.data.llm.model, ...(vision ? { visionSlot: vision.id } : {}) });
        const result = await generate(messages, push);
        ac.signal.throwIfAborted();
        if (bilingual) result.text = await completeBilingualAnswer(result.text, async (input) => (await generate(input)).text);
        return result;
      })();
      work
        .then((r) => {
          if (ac.signal.aborted) return;
          const u = (r as ChatResult).usage;
          if (u) {
            // prewarm acceptance signal: after a warm, hit ≈ prefix length
            console.log(
              `[llm] done mode=${payload.mode} cache_hit=${u.prompt_cache_hit_tokens ?? '?'} cache_miss=${u.prompt_cache_miss_tokens ?? '?'}`,
            );
          }
          sendEv({ requestId: payload.requestId, kind: 'done', text: r.text, ...('bankQuestion' in r ? { bankQuestion: r.bankQuestion } : {}) });
        })
        .catch((e: Error) => {
          if (ac.signal.aborted) return; // user cancelled — not an error
          const message = redactSecrets(e.message).split(apiKey).join('[redacted]');
          console.error('[llm] request failed:', message);
          sendEv({ requestId: payload.requestId, kind: 'error', message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    });
    ipcMain.on(IPC.llmCancel, (_e, requestId: string) => {
      llmControllers.get(requestId)?.abort();
      llmControllers.delete(requestId);
      win?.webContents.send(IPC.llmEvent, { requestId, kind: 'cancelled' });
    });
    ipcMain.on(IPC.llmStopAll, stopAllAnswers);

    // P1-5: fold a finished Q&A into the rolling interview memo. Async and
    // off the critical answer path — renderer serializes calls per session.
    ipcMain.handle(
      IPC.memoUpdate,
      async (_e, p: { memo: string; question: string; answer: string }): Promise<string> => {
        const ac = new AbortController();
        auxiliaryControllers.add(ac);
        try {
          return await updateInterviewMemo(settings, p.memo ?? '', p.question ?? '', p.answer ?? '', T().noApiKeyShort, ac.signal);
        } catch (e) {
          if (!ac.signal.aborted) console.warn('[memo] update failed:', redactSecrets((e as Error).message));
          return '';
        } finally {
          auxiliaryControllers.delete(ac);
        }
      },
    );

    // Inline translation follows the selected interview provider without history.
    ipcMain.handle(IPC.translateText, async (_e, text: string) => {
      const ac = new AbortController();
      auxiliaryControllers.add(ac);
      try {
        return await translateTranscript(settings, text, T().noApiKeyShort, ac.signal);
      } finally {
        auxiliaryControllers.delete(ac);
      }
    });

    // ---- R5: screenshot -> vision model. Our own window is excluded from
    // the capture automatically (content protection). ----
    ipcMain.on(
      IPC.shotAsk,
      (_e, payload: { requestId: string; question: string; background?: string; resume?: string; jd?: string; imageDataUrl?: string; sessionId?: string; visionSlot?: VisionSlot; workspace?: WorkspaceMode; answerLang?: AnswerLang; personalInfo?: PersonalInfo }) => {
      const sendEv = (ev: LlmEvent) => win?.webContents.send(IPC.llmEvent, ev);
      const workspace = payload.workspace ?? settings.data.ui.workspace ?? 'interview';
      const slot = payload.visionSlot ?? 'vision';
      if (!VISION_SLOTS.includes(slot)) {
        sendEv({ requestId: payload.requestId, kind: 'error', message: '无效的视觉接口 / Invalid vision interface' });
        return;
      }
      const vision = { ...configuredVisionSlots(settings.data.vision).find((item) => item.id === slot)!.config };
      const apiKey = settings.getVisionApiKey(slot);
      if (!vision.baseUrl || !vision.model || !apiKey) {
        sendEv({
          requestId: payload.requestId,
          kind: 'error',
          message: T().noVision,
        });
        return;
      }
      const ac = new AbortController();
      llmControllers.set(payload.requestId, ac);
      sendEv({ requestId: payload.requestId, kind: 'model', modelName: vision.model, visionSlot: slot });
      // region mode provides a pre-cropped image; else capture the full screen
      const bilingual = workspace === 'interview' && (payload.answerLang ?? settings.data.llm.answerLang) === 'english';
      const onDelta = interviewDelta(bilingual, (chunk) => sendEv({ requestId: payload.requestId, kind: 'delta', text: chunk }));
      const imgP = payload.imageDataUrl
        ? Promise.resolve(payload.imageDataUrl)
        : captureQuietScreenshot(getResourceRoot());
      imgP
        .then((dataUrl) => {
          ac.signal.throwIfAborted();
          if (!acceptScreenshot(dataUrl, payload.question, payload.background ?? '', `${payload.sessionId ?? ''}:${slot}`)) {
            ac.abort();
            sendEv({ requestId: payload.requestId, kind: 'cancelled', message: '重复截图已忽略 / Duplicate screenshot ignored' });
            return '';
          }
          return visionChat(
            { baseUrl: vision.baseUrl!, model: vision.model!, apiKey, proxyUrl: vision.proxyUrl },
            buildVisionMessages(payload.question, dataUrl, workspace === 'written' ? undefined : payload.background, workspace, payload.answerLang ?? settings.data.llm.answerLang, workspace === 'written' ? undefined : payload.personalInfo, { resume: payload.resume, jd: payload.jd }), ac.signal, workspace === 'interview' ? onDelta : undefined,
            { retryWithoutStream: true, onSend: (sentAt) => sendEv({ requestId: payload.requestId, kind: 'shot-sent', sentAt }) },
          );
        })
        .then(async (text) => {
          if (ac.signal.aborted) return;
          if (workspace === 'written') onDelta(text);
          if (bilingual) text = await completeBilingualAnswer(text, (messages) => visionChat(
            { baseUrl: vision.baseUrl!, model: vision.model!, apiKey, proxyUrl: vision.proxyUrl }, messages, ac.signal));
          if (!ac.signal.aborted) sendEv({ requestId: payload.requestId, kind: 'done', text });
        })
        .catch((e: Error) => {
          if (ac.signal.aborted) return;
          const message = redactSecrets(e.message).split(apiKey).join('[redacted]');
          console.error('[vision] request failed:', message);
          sendEv({ requestId: payload.requestId, kind: 'error', message });
        })
        .finally(() => llmControllers.delete(payload.requestId));
    });

    // ---- ASR: warm the worker at launch (PLAN §6.3) ----
    asr.onEvent((ev: AsrEvent) => {
      if (ev.kind === 'segment') {
        const e2e = ev.timings.inferEndTs - ev.timings.speechEndTs;
        console.log(`[asr] #${ev.id} (${ev.lang ?? '?'}, ${ev.audioMs}ms audio, e2e ${e2e}ms) ${ev.text}`);
      } else if (ev.kind === 'ready') {
        console.log(`[asr] ready ep=${ev.ep} load=${ev.loadMs}ms warm=${ev.warmMs}ms gpuSuspect=${ev.gpuSuspect}`);
        if (process.env.MC_E2E_QUIT_ON_ASR_READY === '1') {
          setTimeout(() => app.quit(), 250);
        }
      } else if (ev.kind === 'error') {
        console.error(`[asr] error (fatal=${ev.fatal}): ${ev.message}`);
        // only fatal events belong in the support report — a transient
        // per-segment failure would flood the 50-entry buffer
        if (ev.fatal) recordDiagnosticError('asr', ev.message);
        if (ev.fatal) {
          // engine diagnostics are deliberately English (they end up in logs
          // and in the diagnostics report); the sentence AROUND them is the
          // part the user reads, so it gets localized here
          win?.webContents.send(IPC.asrEvent, { ...ev, message: T().asrEngineFail(ev.message) });
          return;
        }
      } else if (ev.kind === 'status') {
        console.log(`[asr] status=${ev.state} queued=${ev.queuedSegments}`);
      }
      win?.webContents.send(IPC.asrEvent, ev);
    });

    // First run (or MC_FORCE_ONBOARDING=1 for testing): the wizard owns the
    // whole startup — no overlay window, no ASR worker, no sidecar spawn.
    if (process.env.MC_FORCE_ONBOARDING === '1' || !settings.data.onboarding.completed) {
      openSetupWindow();
    } else {
      startMainApp();
    }
  });

  app.on('second-instance', () => {
    const target = setupWin ?? win;
    if (target?.isMinimized()) target.restore();
    target?.show();
    target?.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    mouseShortcuts.stop();
    globalShortcut.unregisterAll();
    tray.destroy();
    void asr.stop();
    void sidecar.stop();
  });

  /**
   * Still a quit, tray or not: hiding the overlay does NOT close it, so this
   * only fires on a real teardown (app.quit() destroying the windows, or the
   * first-run wizard being closed before completion). A "close to tray" app
   * would return here instead — MeetingCopilot deliberately has no window
   * close button that leaves the app running headless without a window.
   */
  app.on('window-all-closed', () => {
    app.quit();
  });
}
