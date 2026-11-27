import { answerHistory, clearSessionAnswers, restoreReadingTurn, setQuestionTranslation, stopAnswers, updateAnswers } from '../shared/answerState';
import { measuredMs, transcriptLatency } from '../shared/latency';
import { enabledVisionSlots } from '../shared/visionSlots';
import { withDefaultResume } from '../shared/interviewLibrary';
import { sessionWorkspace } from '../shared/workspaces';
import { flushSync } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnswerLang,
  AsrEvent,
  LlmAskPayload,
  PublicSettings,
  PersonalInfo,
  InterviewLibrary,
  InterviewTraceEvent,
  RewriteStyle,
  StoredSession,
  WorkspaceMode,
  VisionSlot,
} from '../shared/protocol';
import {
  appendSegment,
  nextSegmentId,
  percentile,
  reindexSegments,
  type TranscriptSegment,
} from '../shared/transcript';
import { actualTranscript, advanceQuestion, autoQuestion, emptyQuestion, isDuplicateFinal, markQuestionHandled, QUESTION_SETTLE_MS, questionKey, startsSeparateQuestion, type InterviewQuestionState } from '../shared/interviewQuestion';
import { captureKindForPlatform } from '../shared/platform';
import { deriveServiceHealth } from '../shared/healthState';
import { LoopbackCapture } from './audio/loopbackCapture';
import { MicCapture, listMics } from './audio/micCapture';
import { TranscriptPanel } from './components/TranscriptPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { InterviewLibraryPanel } from './components/InterviewLibraryPanel';
import { ServiceHealthPanel } from './components/ServiceHealthPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HelpPanel } from './components/HelpPanel';
import { StatusBar } from './components/StatusBar';
import { AnswerSession, type AnswerTurn } from './components/AnswerSession';
import { WrittenSession } from './components/WrittenSession';
import { I18nProvider, getDict, type Dict } from './i18n';

export interface AsrUiState {
  phase: 'loading' | 'ready' | 'error';
  ep?: string;
  gpuSuspect?: boolean;
  workerState: 'loading' | 'listening' | 'speech' | 'transcribing' | 'stopped';
  lastError?: string;
}

export interface HudStats {
  lastE2eMs?: number;
  lastInferMs?: number;
  lastAsrFirstMs?: number;
  lastAnswerFirstMs?: number;
  lastAnswerCompleteMs?: number;
  p50?: number;
  p95?: number;
  count: number;
}

const MAX_TURNS = 200;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

function newSession(name: string, workspace: WorkspaceMode = 'interview'): StoredSession {
  return { id: uid('s'), name, workspace, createdAt: Date.now(), turns: [], segments: [] };
}

/** legacy single-slot KB → resume slot (dual-slot material, P0-2) */
function migrateKbSlots(s: StoredSession, fallbackName: string): StoredSession {
  if (!s.kbText || s.resumeText != null) return s;
  const { kbName, kbText, ...rest } = s;
  return { ...rest, resumeName: kbName ?? fallbackName, resumeText: kbText };
}

/** first-question topic → a short session title */
function deriveName(text: string, fallback: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 14 ? t.slice(0, 14) + '…' : t;
}

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [asr, setAsr] = useState<AsrUiState>({ phase: 'loading', workerState: 'loading' });
  const [capturing, setCapturing] = useState(false);
  const [library, setLibrary] = useState<InterviewLibrary | null>(null);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [showLibrary, setShowLibrary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showHud, setShowHud] = useState(true);
  const [hud, setHud] = useState<HudStats>({ count: 0 });
  const [continuous, setContinuous] = useState(false);
  const continuousRef = useRef(continuous);
  continuousRef.current = continuous;
  const [questions, setQuestions] = useState<Record<string, InterviewQuestionState>>({});
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const updateQuestion = useCallback((sid: string, state: InterviewQuestionState) => {
    questionsRef.current = { ...questionsRef.current, [sid]: state };
    setQuestions(questionsRef.current);
  }, []);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [micActive, setMicActive] = useState(false);
  const [partials, setPartials] = useState<{ them?: string; me?: string }>({});
  const candidatePartialSession = useRef<string | undefined>(undefined);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [kbNotice, setKbNotice] = useState<string | null>(null);

  const loopbackRef = useRef<LoopbackCapture | null>(null);
  const themInputRef = useRef<MicCapture | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const settingsRef = useRef<PublicSettings | null>(null);
  const e2eSamples = useRef<number[]>([]);
  const sessionsRef = useRef<StoredSession[]>([]);
  const currentIdRef = useRef<string>('');
  const answerLangRef = useRef<AnswerLang>('chinese');
  const loaded = useRef(false);
  const [restoreError, setRestoreError] = useState('');
  const captureGeneration = useRef(0);
  const lastCaptureAt = useRef(-Infinity);

  // UI language: settings-driven; ref mirror so stable callbacks stay fresh
  const t = getDict(settings?.ui.lang);
  const workspace = settings?.ui.workspace ?? 'interview';
  const tRef = useRef<Dict>(t);
  tRef.current = t;

  if (!loopbackRef.current) loopbackRef.current = new LoopbackCapture();
  if (!themInputRef.current) themInputRef.current = new MicCapture();
  if (!micRef.current) micRef.current = new MicCapture();
  settingsRef.current = settings;
  sessionsRef.current = sessions;
  currentIdRef.current = currentId;

  const current = useMemo(
    () => sessions.find((s) => s.id === currentId && sessionWorkspace(s) === workspace) ?? null,
    [sessions, currentId, workspace],
  );
  const segments = current?.segments ?? [];
  useEffect(() => {
    if (!settings || !loaded.current || current) return;
    const existing = sessions.find((session) => sessionWorkspace(session) === workspace);
    if (existing) setCurrentId(existing.id);
    else {
      const session = withDefaultResume(newSession(workspace === 'written' ? (t.uiLang === 'zh' ? '笔试 1' : 'Written 1') : t.app.sessionN(1), workspace), libraryRef.current);
      setSessions((list) => [...list, session]);
      setCurrentId(session.id);
    }
  }, [settings, sessions, current, workspace, t]);

  const patchSession = useCallback((id: string, fn: (s: StoredSession) => StoredSession) => {
    setSessions((list) => list.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const recordTrace = useCallback((sid: string, event: InterviewTraceEvent) => {
    patchSession(sid, (session) => ({ ...session, interviewTrace: [...(session.interviewTrace ?? []).slice(-4095), event] }));
  }, [patchSession]);

  const appendTurn = useCallback(
    (sessionId: string, turn: AnswerTurn) => {
      patchSession(sessionId, (s) => {
        const turns = [...s.turns, turn];
        return { ...s, turns: turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns };
      });
    },
    [patchSession],
  );

  const buildHistory = useCallback((visionSlot?: VisionSlot): { role: 'user' | 'assistant'; content: string }[] => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    if (!s) return [];
    return answerHistory(s.turns, visionSlot);
  }, []);

  /** current session's dual-slot material (resume / JD / rolling memo) */
  const currentMaterial = useCallback((): { resume?: string; jd?: string; memo?: string; personalInfo?: PersonalInfo } => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    return {
      resume: s?.resumeText || undefined,
      jd: s?.jdText || undefined,
      memo: s?.memo || undefined,
      personalInfo: s?.personalInfo,
    };
  }, []);

  /** P1-6: ask main to warm the DeepSeek prefix cache for the current material */
  const prewarm = useCallback(
    (immediate: boolean) => {
      if (settingsRef.current?.ui.workspace === 'written') return;
      const m = currentMaterial();
      window.mc.prewarm({ resume: m.resume, jd: m.jd, personalInfo: m.personalInfo, immediate });
    },
    [currentMaterial],
  );

  // P1-5: rolling memo — fold each finished Q&A in asynchronously, one update
  // at a time per session (promise chain), never on the answer critical path
  const memoChain = useRef(new Map<string, Promise<void>>());
  const enqueueMemoUpdate = useCallback(
    (sid: string, question: string, answer: string) => {
      if (!question.trim() || !answer.trim()) return;
      const prev = memoChain.current.get(sid) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const old = sessionsRef.current.find((x) => x.id === sid)?.memo ?? '';
          const memo = await window.mc.memoUpdate({ memo: old, question, answer });
          if (memo) patchSession(sid, (s) => ({ ...s, memo }));
        })
        .catch(() => {});
      memoChain.current.set(sid, next);
    },
    [patchSession],
  );

  /** auto-name a session from its first real question (once) */
  const maybeTitle = useCallback(
    (sid: string, text?: string) => {
      if (!text?.trim()) return;
      patchSession(sid, (s) =>
        s.titled ? s : { ...s, name: deriveName(text, tRef.current.app.newSession), titled: true },
      );
    },
    [patchSession],
  );

  const translatingQuestions = useRef(new Set<string>());
  const translateQuestion = useCallback((sid: string, batchId: string, question: string) => {
    const key = `${sid}:${batchId}`;
    if (!question.trim() || translatingQuestions.current.has(key)) return;
    translatingQuestions.current.add(key);
    patchSession(sid, (session) => setQuestionTranslation(session, batchId, { questionTranslating: true, questionTranslationError: undefined }));
    // Independent request: answer generation never awaits a translation.
    void window.mc.translate(question).then((text) => {
      if (!text.trim()) throw new Error(tRef.current.uiLang === 'zh' ? '服务返回空释义，请重试' : 'Empty translation; retry');
      patchSession(sid, (session) => setQuestionTranslation(session, batchId, { questionTranslation: text, questionTranslating: false }));
    }).catch(() => {
      patchSession(sid, (session) => setQuestionTranslation(session, batchId, { questionTranslating: false,
        questionTranslationError: tRef.current.uiLang === 'zh' ? '释义失败或已停止；回答不受影响' : 'Gloss failed or stopped; answer is unaffected' }));
    }).finally(() => translatingQuestions.current.delete(key));
  }, [patchSession]);

  const remainingModels = useRef(new Map<string, () => void>());
  const askLlm = useCallback(
    (mode: 'segment' | 'continuous' | 'free' | 'translate', text?: string, source?: TranscriptSegment) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const triggeredAt = Date.now();
      const requestId = uid('req');
      const segs = sessionsRef.current.find((x) => x.id === sid)?.segments ?? [];
      const qState = questionsRef.current[sid];
      const question = text ?? (qState?.editedText ?? qState?.block?.text);
      if (qState && question && (mode === 'continuous' || (mode === 'segment' && question === (qState.editedText ?? qState.block?.text)))) {
        updateQuestion(sid, markQuestionHandled(qState, question));
      }

      const label = question ?? (mode === 'continuous' ? tRef.current.app.latestRemark : '');
      if (mode === 'segment' || mode === 'free') maybeTitle(sid, text);
      const material = mode === 'translate' ? {} : currentMaterial();
      const payload: LlmAskPayload = {
        requestId,
        mode,
        question: mode === 'free' ? undefined : question,
        freeQuestion: mode === 'free' ? text : undefined,
        recentTranscript: actualTranscript(segs),
        answerLang: answerLangRef.current,
        history: mode === 'translate' ? undefined : buildHistory(),
        ...material,
      };
      const config = settingsRef.current;
      const targets = config?.llm.answerWithVision && mode !== 'translate'
        ? enabledVisionSlots(config.vision, 'interview')
        : [{ id: undefined, config: undefined }];
      if (mode === 'continuous' || mode === 'segment') {
        recordTrace(sid, { kind: 'trigger', at: triggeredAt, source: mode === 'continuous' ? 'auto' : 'manual',
          batchId: requestId, speechStartTs: source?.startTs, speechEndTs: source?.endTs });
      }
      const requests = targets.map((target, i) => ({ target, id: i === 0 ? requestId : uid('req'), history: mode === 'translate' ? undefined : buildHistory(target.id) }));
      const start = ({ target, id, history }: typeof requests[number], bankChecked = false) => {
        appendTurn(sid, { id, kind: mode, label, text: '', status: 'streaming', requestStartedAt: Date.now(),
          modelName: target.config?.model, visionSlot: target.id, batchId: requestId, answerLang: answerLangRef.current });
        window.mc.llmAsk({ ...payload, requestId: id, visionSlot: target.id, history, bankChecked });
      };
      if ((mode === 'segment' || mode === 'continuous') && requests.length > 1) {
        remainingModels.current.set(requestId, () => requests.slice(1).forEach((request) => start(request, true)));
        start(requests[0]);
      } else {
        requests.forEach((request) => start(request));
      }
      if (mode !== 'translate' && sessionsRef.current.find((session) => session.id === sid)?.showChineseQuestion && targets.length) {
        translateQuestion(sid, requestId, label);
      }
    },
    [appendTurn, buildHistory, currentMaterial, maybeTitle, updateQuestion, translateQuestion, recordTrace],
  );

  const askShot = useCallback(
    (question: string, imageDataUrl: string, captureStartedAt: number, imageReadyAt: number) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const config = settingsRef.current;
      if (!config) return;
      const mode = config.ui.workspace ?? 'interview';
      if (!sessionsRef.current.some((session) => session.id === sid && sessionWorkspace(session) === mode)) return;
      const targets = enabledVisionSlots(config.vision, mode);
      const batchId = uid('capture');
      maybeTitle(sid, question || tRef.current.app.shotQuestion);
      const m = currentMaterial();
      const background = mode === 'written' ? undefined : [m.resume, m.jd].filter(Boolean).join('\n\n') || undefined;
      for (const { id, config: vision } of targets) {
        const requestId = uid('shot');
        appendTurn(sid, { id: requestId, kind: 'vision', label: question || tRef.current.app.readShot,
          text: '', status: 'streaming', captureStartedAt, imageReadyAt, modelName: vision.model, visionSlot: id, batchId, answerLang: answerLangRef.current });
        window.mc.shotAsk({ requestId, question, background, resume: mode === 'interview' ? m.resume : undefined, jd: mode === 'interview' ? m.jd : undefined, imageDataUrl, sessionId: sid, visionSlot: id, workspace: mode, answerLang: answerLangRef.current, personalInfo: mode === 'interview' ? m.personalInfo : undefined });
      }
      if (mode === 'interview' && sessionsRef.current.find((session) => session.id === sid)?.showChineseQuestion && targets.length && question.trim()) {
        translateQuestion(sid, batchId, question);
      }
    },
    [appendTurn, currentMaterial, maybeTitle, translateQuestion],
  );

  const rewriteAnswer = useCallback((source: AnswerTurn, style: RewriteStyle) => {
    const sid = currentIdRef.current;
    const session = sessionsRef.current.find((s) => s.id === sid);
    if (!session || source.status !== 'done' || !source.text.trim() || source.kind === 'translate') return;
    const id = uid('rewrite');
    const answerLang = source.answerLang ?? answerLangRef.current;
    appendTurn(sid, { id, kind: 'segment', label: source.label, text: '', status: 'streaming', requestStartedAt: Date.now(),
      modelName: source.modelName, visionSlot: source.visionSlot, answerLang, rewriteOf: source.id, rewriteStyle: style,
      batchId: id, questionTranslation: source.questionTranslation });
    window.mc.llmAsk({ requestId: id, mode: 'segment', question: source.label, visionSlot: source.visionSlot,
      answerLang, rewrite: { style, question: source.label, answer: source.text },
      recentTranscript: actualTranscript(session.segments ?? []), ...currentMaterial() });
    if (session.showChineseQuestion && !source.questionTranslation) translateQuestion(sid, id, source.label);
  }, [appendTurn, currentMaterial, translateQuestion]);

  const showQuestionGloss = useCallback((show: boolean) => {
    const sid = currentIdRef.current;
    patchSession(sid, (session) => ({ ...session, showChineseQuestion: show }));
    if (!show) return;
    // Translate only the latest group; old questions can be requested individually.
    const latest = sessionsRef.current.find((session) => session.id === sid)?.turns.filter((turn) => turn.kind !== 'translate').at(-1);
    if (latest && !latest.questionTranslation) translateQuestion(sid, latest.batchId ?? latest.id, latest.label);
  }, [patchSession, translateQuestion]);

  /** Silent screenshot flow shared by the button and global shortcut. */
  const doRegionShot = useCallback(async (question = '') => {
    const config = settingsRef.current;
    if (!config || enabledVisionSlots(config.vision, config.ui.workspace ?? 'interview').length === 0) return;
    const now = Date.now();
    if (now - lastCaptureAt.current < 700) return;
    lastCaptureAt.current = now;
    const generation = captureGeneration.current;
    const sid = currentIdRef.current;
    try {
      const img = await window.mc.pickRegion();
      if (img && generation === captureGeneration.current && sid === currentIdRef.current) askShot(question, img, now, Date.now());
    } catch (error) {
      if (generation === captureGeneration.current) setKbNotice((error as Error).message);
    }
  }, [askShot]);

  // ---- boot: load settings + sessions ----
  useEffect(() => {
    // Initialize together: a settings-only render must not create a new session
    // while an existing session file is still being restored.
    void Promise.all([window.mc.getSettings(), window.mc.loadSessions(), window.mc.getLibrary()]).then(([s, f, savedLibrary]) => {
      libraryRef.current = savedLibrary;
      setLibrary(savedLibrary);
      setSettings(s);
      answerLangRef.current = s.llm.answerLang;
      if (f.sessions.length) {
        // heal legacy duplicate segment ids (worker counter used to reset per
        // engine rebuild — translations then landed on multiple bubbles)
        setSessions(
          f.sessions.map((s) =>
            migrateKbSlots(
              { ...s, segments: reindexSegments(s.segments ?? []), turns: s.turns.map(restoreReadingTurn) },
              tRef.current.app.legacyKbName,
            ),
          ),
        );
        setCurrentId(f.currentId && f.sessions.some((s) => s.id === f.currentId) ? f.currentId : f.sessions[0].id);
      } else {
        const s = withDefaultResume(newSession(tRef.current.app.sessionN(1)), libraryRef.current);
        setSessions([s]);
        setCurrentId(s.id);
      }
      loaded.current = true;
    }).catch((error: Error) => setRestoreError(error.message));

    const handleAsrEvent = (ev: AsrEvent) => {
      if (settingsRef.current?.ui.workspace === 'written') return;
      const sid = currentIdRef.current;
      if (ev.kind === 'partial' || ev.kind === 'segment') {
        if (ev.speaker === 'me') candidatePartialSession.current = ev.kind === 'partial' && ev.text ? sid : undefined;
        else if (continuousRef.current && candidatePartialSession.current !== sid) {
          const pending = questionsRef.current[sid];
          const start = ev.kind === 'partial' ? ev.speechStartTs : ev.timings.speechStartTs;
          if (pending?.block && autoQuestion(pending) && startsSeparateQuestion(pending.block, ev.text, start)) {
            // Both finals may arrive together. Dispatch the settled question before replacing it.
            askLlm('continuous', pending.block.text, pending.block);
          }
        }
      }
      if (ev.kind === 'ready') {
        setAsr((s) => ({ ...s, phase: 'ready', ep: ev.ep, gpuSuspect: ev.gpuSuspect, workerState: 'listening' }));
      } else if (ev.kind === 'status') {
        setAsr((s) => ({ ...s, workerState: ev.state }));
      } else if (ev.kind === 'error') {
        setAsr((s) => ({ ...s, phase: ev.fatal ? 'error' : s.phase, lastError: ev.message }));
      } else if (ev.kind === 'partial') {
        setHud((old) => ({ ...old, lastAsrFirstMs: measuredMs(ev.firstTextTs, ev.speechStartTs) }));
        setPartials((p) => ({ ...p, [ev.speaker]: ev.text }));
      } else if (ev.kind === 'segment') {
        setPartials((p) => ({ ...p, [ev.speaker]: undefined })); // final replaces the live partial
        const q = questionsRef.current[sid] ?? emptyQuestion();
        const finalSegment: TranscriptSegment = { id: ev.id, text: ev.text, speaker: ev.speaker,
          startTs: Number.isFinite(ev.timings.speechStartTs) ? ev.timings.speechStartTs : Date.now(), endTs: Number.isFinite(ev.timings.speechEndTs) ? ev.timings.speechEndTs : Date.now() };
        if (isDuplicateFinal(q, finalSegment)) return;
        const nextQuestion = advanceQuestion(q, finalSegment);
        updateQuestion(sid, nextQuestion);
        recordTrace(sid, { kind: 'final', at: Date.now(), speaker: ev.speaker ?? 'them',
          speechStartTs: finalSegment.startTs, speechEndTs: finalSegment.endTs, continuous: continuousRef.current,
          pendingQuestionStartTs: autoQuestion(nextQuestion) ? nextQuestion.block?.startTs : undefined });
        const superseded = (sessionsRef.current.find((s) => s.id === sid)?.turns ?? []).filter((turn) =>
          turn.kind === 'continuous' && turn.status === 'streaming' && turn.label === q.block?.text &&
          nextQuestion.block?.startTs === q.block?.startTs && !!autoQuestion(nextQuestion) &&
          nextQuestion.block?.text !== q.block?.text);
        for (const turn of superseded) { remainingModels.current.delete(turn.id); window.mc.llmCancel(turn.id); }
        const { finalMs: e2eMs, inferMs, firstMs } = transcriptLatency(ev.timings, Date.now());
        if (e2eMs !== undefined) e2eSamples.current.push(e2eMs);
        if (e2eSamples.current.length > 200) e2eSamples.current.shift();
        setHud({
          lastE2eMs: e2eMs,
          lastInferMs: inferMs,
          lastAsrFirstMs: firstMs,
          p50: percentile(e2eSamples.current, 50),
          p95: percentile(e2eSamples.current, 95),
          count: e2eSamples.current.length,
        });
        setSessions((list) =>
          list.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  turns: s.turns.map((turn) => superseded.some((old) => old.id === turn.id) ? { ...turn, status: 'cancelled' as const } : turn),
                  segments: appendSegment(s.segments ?? [], {
                    // NOT ev.id: the worker counter resets per engine rebuild,
                    // duplicating ids inside a persisted session
                    id: nextSegmentId(s.segments ?? []),
                    text: ev.text,
                    lang: ev.lang,
                    speaker: ev.speaker,
                    startTs: finalSegment.startTs,
                    endTs: finalSegment.endTs,
                    e2eMs,
                    firstTextMs: firstMs,
                    inferMs,
                  }),
                }
              : s,
          ),
        );
      }
    };
    const off = window.mc.onAsrEvent(handleAsrEvent);
    const offTrace = window.mc.onCaptureTrace(recordTrace);
    // instant-ready cloud engines emit ready/status BEFORE this subscription
    // exists — pull the last ones so the UI never sticks at "模型加载中"
    void window.mc.asrReplay().then(({ ready, status }) => {
      if (ready) handleAsrEvent(ready);
      if (status) handleAsrEvent(status);
    });

    const offLlm = window.mc.onLlmEvent((ev) => {
      const rest = remainingModels.current.get(ev.requestId);
      if (rest && ev.kind !== 'delta') {
        remainingModels.current.delete(ev.requestId);
        if ((ev.kind === 'model' && !ev.bankQuestion) || ev.kind === 'error') rest();
      }
      setSessions((list) => updateAnswers(list, ev));
      // fold finished ANSWER turns into the session memo (async, off-path);
      // translate/vision turns are not interview Q&A
      if (ev.kind === 'done') {
        const s = sessionsRef.current.find((x) => x.turns.some((t) => t.id === ev.requestId));
        const t = s?.turns.find((x) => x.id === ev.requestId);
        // Summarize one selected answer per question, keeping memo API usage unchanged.
        const memoSource = !t?.visionSlot || (settingsRef.current && enabledVisionSlots(settingsRef.current.vision, 'interview')[0]?.id === t.visionSlot);
        if (s && t && !ev.bankQuestion && !t.bankQuestion && memoSource && t.status !== 'cancelled' && !t.rewriteOf && (t.kind === 'segment' || t.kind === 'continuous' || t.kind === 'free')) {
          enqueueMemoUpdate(s.id, t.label, ev.text || t.text);
        }
      }
    });

    const offShot = window.mc.onShotHotkey(() => void doRegionShot());

    window.__mcAutoStart = () => void startCapture();
    // visual-QA hooks (MC_MAIN_SHOT in electron/main.ts): open a panel from the
    // main process so it can be screenshotted
    window.__mcOpenSettings = () => setShowSettings(true);
    window.__mcOpenHelp = () => setShowHelp(true);
    return () => {
      off();
      offTrace();
      offLlm();
      offShot();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist sessions (debounced) ----
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => window.mc.saveSessions({ sessions, currentId }).catch((error) => setKbNotice(String(error))), 400);
    return () => clearTimeout(t);
  }, [sessions, currentId]);

  // ---- apply UI theme + answer font scale to the document root ----
  useEffect(() => {
    const ui = settings?.ui;
    if (!ui) return;
    document.documentElement.dataset.fontScale = ui.fontScale ?? 'medium';
    const apply = () => {
      const mode = ui.theme ?? 'dark';
      const dark =
        mode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if ((ui.theme ?? 'dark') !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  // auto-dismiss the KB parse notice
  useEffect(() => {
    if (!kbNotice) return;
    const t = setTimeout(() => setKbNotice(null), 8000);
    return () => clearTimeout(t);
  }, [kbNotice]);

  // switching sessions swaps the material → prefix dirty (reheats if capturing)
  useEffect(() => {
    if (!loaded.current || !currentId) return;
    prewarm(false);
  }, [currentId, prewarm]);

  // Dispatch only confirmed questions; a following partial gets a bounded grace period.
  const questionState = questions[currentId] ?? emptyQuestion();
  const interviewerSpeaking = !!partials.them;
  const candidateSpeaking = !!partials.me;
  const pendingDeadline = useRef<{ sid: string; startTs: number; at: number } | null>(null);
  useEffect(() => {
    const question = autoQuestion(questionState);
    const block = questionState.block;
    if (!continuous || workspace !== 'interview' || !question || !block) {
      pendingDeadline.current = null;
      return;
    }
    const sid = currentId;
    // Candidate partials hold dispatch while the interviewer's question continues to settle.
    if (pendingDeadline.current?.sid !== sid || pendingDeadline.current.startTs !== block.startTs) {
      pendingDeadline.current = { sid, startTs: block.startTs, at: performance.now() + QUESTION_SETTLE_MS };
    }
    if (candidateSpeaking) {
      recordTrace(sid, { kind: 'candidate-speaking', at: Date.now(), speechStartTs: block.startTs });
      return;
    }
    // A new partial may keep changing for seconds after a complete question.
    // Give it a brief chance to finalize, without starving the confirmed question.
    const at = pendingDeadline.current.at + (interviewerSpeaking ? QUESTION_SETTLE_MS : 0);
    const timer = setTimeout(() => {
      if (currentIdRef.current === sid && autoQuestion(questionsRef.current[sid] ?? emptyQuestion()) === question) {
        askLlm('continuous', question, block);
      }
    }, Math.max(0, at - performance.now()));
    return () => clearTimeout(timer);
  }, [continuous, workspace, currentId, questionState, interviewerSpeaking, candidateSpeaking, askLlm, recordTrace]);

  useEffect(() => {
    setContinuous(false);
    setPartials({});
    candidatePartialSession.current = undefined;
    setShowLibrary(false);
  }, [currentId]);


  // Windows: Electron system loopback. macOS/Linux: selected ordinary input
  // (typically a virtual audio device for meeting/system audio).
  const startCapture = useCallback(async () => {
    if (settingsRef.current?.ui.workspace === 'written') return;
    const inputMode = captureKindForPlatform(window.mc.platform) === 'input';
    const cap = inputMode ? themInputRef.current! : loopbackRef.current!;
    if (cap.running) return;
    try {
      window.mc.captureChannel('them', true, currentIdRef.current);
      if (inputMode) {
        await themInputRef.current!.start(
          settingsRef.current?.audio.themDeviceId,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them', currentIdRef.current),
          { audioProcessing: false },
        );
        void listMics().then(setMics).catch(() => undefined);
      } else {
        await loopbackRef.current!.start((buf, ts) => window.mc.sendPcm(buf, ts, 'them', currentIdRef.current));
      }
      window.mc.captureStarted();
      setCapturing(true);
      prewarm(true); // ▶ = the meeting starts — build the KV prefix cache now
    } catch (e) {
      window.mc.captureChannel('them', false, currentIdRef.current);
      setAsr((s) => ({ ...s, lastError: tRef.current.app.captureStartFail((e as Error).message) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCapture = useCallback(async () => {
    const cap =
      captureKindForPlatform(window.mc.platform) === 'input'
        ? themInputRef.current!
        : loopbackRef.current!;
    await cap.stop();
    window.mc.captureStopped(currentIdRef.current);
    setCapturing(false);
  }, []);

  // 🎤 独立麦克风采集：只转麦克风(我)，与系统声音互不影响，按钮直接控制起停
  const toggleMicCapture = useCallback(async () => {
    const mic = micRef.current!;
    if (mic.running) {
      await mic.stop();
      window.mc.captureChannel('me', false, currentIdRef.current);
      setMicActive(false);
      return;
    }
    try {
      window.mc.captureChannel('me', true, currentIdRef.current);
      await mic.start(settings?.audio.micDeviceId, (buf, ts) => window.mc.sendPcm(buf, ts, 'me', currentIdRef.current));
      setMicActive(true);
      if (mics.length === 0) void listMics().then(setMics);
    } catch (e) {
      window.mc.captureChannel('me', false, currentIdRef.current);
      setAsr((s) => ({ ...s, lastError: tRef.current.app.micStartFail((e as Error).message) }));
    }
  }, [settings, mics]);

  const translateSegment = useCallback(
    (seg: TranscriptSegment) => {
      if (seg.translating) return; // re-translating an already-translated bubble is allowed
      const sid = currentIdRef.current;
      const update = (patch: Partial<TranscriptSegment>) => patchSession(sid, (session) => ({
        ...session,
        segments: session.segments?.map((item) =>
          item.id === seg.id && item.startTs === seg.startTs && item.text === seg.text ? { ...item, ...patch } : item),
      }));
      update({ translating: true });
      window.mc
        .translate(seg.text)
        .then((zh) => update({ translation: zh, translating: false }))
        .catch(() => update({ translation: tRef.current.app.translateFail, translating: false }));
    },
    [patchSession],
  );

  const toggleStealth = useCallback(async () => {
    if (!settings) return;
    const on = await window.mc.setStealth(!settings.ui.stealth);
    setSettings({ ...settings, ui: { ...settings.ui, stealth: on } });
  }, [settings]);

  const toggleAnswerLang = useCallback(async () => {
    if (!settings) return;
    const next: AnswerLang = settings.llm.answerLang === 'chinese' ? 'english' : 'chinese';
    answerLangRef.current = next;
    const updated = await window.mc.setSettings({ llm: { answerLang: next } });
    setSettings(updated);
    answerLangRef.current = updated.llm.answerLang;
    prewarm(false); // lang is part of the stable prefix → mark dirty / reheat
  }, [settings, prewarm]);

  const toggleAnswerModel = useCallback(async () => {
    if (!settings) return;
    const updated = await window.mc.setSettings({ llm: { answerWithVision: !settings.llm.answerWithVision } });
    setSettings(updated);
  }, [settings]);

  const selectMic = useCallback(
    async (deviceId: string) => {
      const updated = await window.mc.setSettings({ audio: { micDeviceId: deviceId || undefined } });
      setSettings(updated);
      // if the mic is currently on, restart it on the newly chosen device
      const mic = micRef.current!;
      if (mic.running) {
        await mic.stop();
        window.mc.captureChannel('me', false, currentIdRef.current);
        window.mc.captureChannel('me', true, currentIdRef.current);
        await mic
          .start(deviceId || undefined, (buf, ts) => window.mc.sendPcm(buf, ts, 'me', currentIdRef.current))
          .catch(() => { window.mc.captureChannel('me', false, currentIdRef.current); setMicActive(false); });
      }
    },
    [],
  );

  const selectThemInput = useCallback(async (deviceId: string) => {
    const updated = await window.mc.setSettings({ audio: { themDeviceId: deviceId || undefined } });
    setSettings(updated);
    settingsRef.current = updated;
    const input = themInputRef.current!;
    if (input.running) {
      await input.stop();
      window.mc.captureChannel('them', false, currentIdRef.current);
      window.mc.captureChannel('them', true, currentIdRef.current);
      await input
        .start(
          deviceId || undefined,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them', currentIdRef.current),
          { audioProcessing: false },
        )
        .catch((e) => {
          window.mc.captureStopped(currentIdRef.current);
          setCapturing(false);
          setAsr((s) => ({ ...s, lastError: tRef.current.app.themInputSwitchFail((e as Error).message) }));
        });
    }
  }, []);

  const clearTranscript = useCallback(() => {
    updateQuestion(currentIdRef.current, emptyQuestion());
    patchSession(currentIdRef.current, (s) => ({ ...s, segments: [] }));
  }, [patchSession, updateQuestion]);

  const clearAnswers = useCallback(() => {
    for (const turn of sessionsRef.current.find((s) => s.id === currentIdRef.current)?.turns ?? []) remainingModels.current.delete(turn.id);
    patchSession(currentIdRef.current, clearSessionAnswers);
  }, [patchSession]);
  const cancelTurn = useCallback(
    (id: string) => {
      remainingModels.current.delete(id);
      window.mc.llmCancel(id);
      patchSession(currentIdRef.current, (s) => ({
        ...s,
        turns: s.turns.map((t) => (t.id === id && t.status === 'streaming' ? { ...t, status: 'cancelled' } : t)),
      }));
    },
    [patchSession],
  );

  const createSession = useCallback(() => {
    const mode = settingsRef.current?.ui.workspace ?? 'interview';
    const count = sessionsRef.current.filter((session) => sessionWorkspace(session) === mode).length + 1;
    const name = mode === 'written' ? `${tRef.current.uiLang === 'zh' ? '笔试' : 'Written'} ${count}` : tRef.current.app.sessionN(count);
    const s = withDefaultResume(newSession(name, mode), libraryRef.current);
    setSessions((list) => [...list, s]);
    setCurrentId(s.id);
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions((list) => {
      const next = list.filter((s) => s.id !== id);
      if (next.length === 0) {
        const s = withDefaultResume(newSession(tRef.current.app.sessionN(1)), libraryRef.current);
        setCurrentId(s.id);
        return [s];
      }
      setCurrentId((cur) => (cur === id ? next[0].id : cur));
      return next;
    });
  }, []);

  const renameSession = useCallback(
    (id: string, name: string) => {
      patchSession(id, (s) => ({ ...s, name: name.trim() || s.name, titled: true }));
    },
    [patchSession],
  );

  /** the overlays are mutually exclusive: one panel at a time, never stacked */
  const closePanels = useCallback(() => {
    setShowLibrary(false);
    setShowSettings(false);
    setShowHealth(false);
    setShowDiagnostics(false);
    setShowHelp(false);
  }, []);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const switchWorkspace = async (next: WorkspaceMode) => {
    if (next === workspace || switchingWorkspace) return;
    setSwitchingWorkspace(true);
    captureGeneration.current++;
    lastCaptureAt.current = -Infinity;
    try {
      if (next === 'written') {
        await stopCapture();
        await micRef.current!.stop();
        window.mc.captureChannel('me', false, currentIdRef.current);
        setMicActive(false);
        setContinuous(false);
        setPartials({});
        candidatePartialSession.current = undefined;
      }
      if (next === 'interview') setAsr({ phase: 'loading', workerState: 'loading' });
      const updated = await window.mc.setSettings({ ui: { workspace: next } });
      settingsRef.current = updated;
      setSettings(updated);
      closePanels();
    } catch (error) { setKbNotice((error as Error).message); }
    finally { setSwitchingWorkspace(false); }
  };

  /**
   * Tray menu -> renderer (Phase 4 §A). Main only forwards what it cannot do
   * itself, and it has already made the window visible. 开始/停止转写
   * deliberately runs the SAME code path as the title-bar button, readiness
   * gate included, so the two can never disagree. Re-subscribed whenever that
   * state changes — cheaper and less error-prone than a fistful of refs.
   */
  useEffect(() => {
    return window.mc.onTrayCommand(({ command }) => {
      switch (command) {
        case 'toggle-capture':
          if (capturing) void stopCapture();
          else if (asr.phase === 'ready') void startCapture();
          return;
        case 'clear-answers':
          clearAnswers();
          return;
        case 'stop-all-answers':
          { const sid = currentIdRef.current; const q = questionsRef.current[sid];
            if (q) updateQuestion(sid, { ...q, handledKey: questionKey(q) }); }
          captureGeneration.current++;
          lastCaptureAt.current = -Infinity;
          setSessions(stopAnswers);
          return;
        case 'new-session':
          createSession();
          return;
        case 'open-settings':
          closePanels();
          setShowSettings(true);
          return;
        case 'open-health':
          closePanels();
          setShowHealth(true);
          return;
        case 'open-help':
          closePanels();
          setShowHelp(true);
          return;
      }
    });
  }, [capturing, asr.phase, startCapture, stopCapture, createSession, closePanels, clearAnswers]);

  /** the v1 -> v2 migration marks hand-configured profiles; show the notice
   * once until the user dismisses it (persisted in onboarding state) */
  const showUpgradeNotice =
    !!settings &&
    settings.version === 2 &&
    settings.onboarding.completed &&
    !!settings.onboarding.migratedFromV1 &&
    !settings.onboarding.dismissedUpgradePrompt;

  const dismissUpgradeNotice = async () => {
    const onboarding = await window.mc.saveOnboardingProgress({ dismissedUpgradePrompt: true });
    setSettings((s) => (s ? { ...s, onboarding } : s));
  };

  const visionReady =
    !!settings?.llm.answerWithVision &&
    enabledVisionSlots(settings.vision, 'interview').length > 0;

  /**
   * One derivation for the status chips, the health panel and the answer
   * gating (shared/healthState.ts). A missing LLM key disables the answer
   * buttons with an explanation instead of letting every click produce the
   * same main-process error turn — but it never blocks transcription.
   */
  const health = useMemo(
    () => (settings ? deriveServiceHealth({ settings, asr, capturing }) : null),
    [settings, asr, capturing],
  );
  const answersReady = health?.answersAvailable ?? true;

  if (restoreError) return <main role="alert"><p>{restoreError}</p><p>请修复数据或恢复读取权限后重启。 / Restore the data or read access, then restart.</p></main>;

  return (
    <I18nProvider lang={settings?.ui.lang}>
    <div className={`app workspace-${workspace}`}>
      <header className="titlebar">
        <span className="brand">MeetingCopilot</span>
        <div className="titlebar-actions">
          {workspace === 'interview' && <>
          <button
            className={capturing ? 'btn btn-live' : 'btn btn-primary'}
            onClick={() => (capturing ? void stopCapture() : void startCapture())}
            disabled={asr.phase !== 'ready'}
            title={
              captureKindForPlatform(window.mc.platform) === 'loopback'
                ? capturing
                  ? t.titlebar.stopTitle
                  : t.titlebar.startTitle
                : capturing
                  ? t.titlebar.stopInputTitle
                  : t.titlebar.startInputTitle
            }
          >
            {capturing ? t.titlebar.stop : t.titlebar.start}
          </button>
          {captureKindForPlatform(window.mc.platform) === 'input' && mics.length > 0 && (
            <select
              className="mic-select"
              value={settings?.audio.themDeviceId ?? ''}
              onChange={(e) => void selectThemInput(e.target.value)}
              title={t.titlebar.themDeviceTitle}
            >
              <option value="">{t.titlebar.themDeviceDefault}</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {(m.label || t.titlebar.themDeviceDefault).slice(0, 14)}
                </option>
              ))}
            </select>
          )}
          <button
            className={continuous ? 'btn btn-on' : 'btn'}
            onClick={() => setContinuous((v) => !v)}
            title={t.titlebar.continuousTitle}
          >
            {t.titlebar.continuous}
          </button>
          <button
            className={settings?.llm.answerWithVision ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleAnswerModel()}
            title={t.titlebar.modelTitle}
          >
            {settings?.llm.answerWithVision ? t.titlebar.vision : t.titlebar.textOnly}
          </button>
          <button className="btn" onClick={() => void toggleAnswerLang()} title={t.titlebar.answerLangTitle}>
            {t.titlebar.answerLang(settings?.llm.answerLang === 'english')}
          </button>
          <button
            className={micActive ? 'btn btn-live' : 'btn'}
            onClick={() => void toggleMicCapture()}
            title={t.titlebar.micTitle}
          >
            {micActive ? t.titlebar.micOn : t.titlebar.micOff}
          </button>
          {micActive && mics.length > 0 && (
            <select
              className="mic-select"
              value={settings?.audio.micDeviceId ?? ''}
              onChange={(e) => void selectMic(e.target.value)}
              title={t.titlebar.micDeviceTitle}
            >
              <option value="">{t.titlebar.micDefault}</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {(m.label || t.titlebar.micDefault).slice(0, 10)}
                </option>
              ))}
            </select>
          )}
          <button
            className={settings?.ui.stealth ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleStealth()}
            title={
              window.mc.platform === 'darwin'
                ? t.titlebar.stealthMacTitle
                : t.titlebar.stealthTitle
            }
          >
            {t.titlebar.stealth(!!settings?.ui.stealth)}
          </button>
          <button className="btn" onClick={() => setShowHud((v) => !v)} title={t.titlebar.hudTitle}>
            HUD
          </button>
          </>}
          <button className="btn" onClick={() => setShowSettings((v) => !v)} title={t.titlebar.settingsTitle}>
            ⚙
          </button>
          <button className="btn" onClick={() => window.mc.hide()} title={t.titlebar.hideTitle}>
            —
          </button>
          <button className="btn btn-close" onClick={() => window.mc.quit()} title={t.titlebar.quitTitle}>
            ✕
          </button>
        </div>
      </header>

      <nav className="workspace-tabs" role="tablist" aria-label={t.uiLang === 'zh' ? '工作界面' : 'Workspace'}>
        <button className={`btn ${workspace === 'interview' ? 'btn-on' : ''}`} role="tab" aria-selected={workspace === 'interview'} disabled={switchingWorkspace || !settings} onClick={() => void switchWorkspace('interview')}>{t.uiLang === 'zh' ? '面试' : 'Interview'}</button>
        <button className={`btn ${workspace === 'written' ? 'btn-on' : ''}`} role="tab" aria-selected={workspace === 'written'} disabled={switchingWorkspace || !settings} onClick={() => void switchWorkspace('written')}>{t.uiLang === 'zh' ? '笔试' : 'Written test'}</button>
        {workspace === 'interview' && <button className="btn" onClick={() => setShowHealth(true)}>{t.uiLang === 'zh' ? '会前检查' : 'Pre-interview check'}</button>}
      </nav>

      {/* grandfathered users (settings.json predates the wizard) get one
          dismissible pointer at the new wizard; wizard-created profiles never
          carry onboarding.migratedFromV1, so they never see it */}
      {workspace === 'interview' && showUpgradeNotice && (
        <div className="upgrade-banner">
          <span>{t.app.upgradeNotice}</span>
          <button className="btn btn-sm btn-primary" onClick={() => void window.mc.rerunOnboarding()}>
            {t.app.upgradeCheck}
          </button>
          <button className="btn btn-sm" onClick={() => void dismissUpgradeNotice()}>
            {t.app.upgradeSkip}
          </button>
        </div>
      )}

      {showLibrary && library && workspace === 'interview' && <InterviewLibraryPanel key={currentId} library={library} current={current} hasLegacyFile={!!settings?.knowledge.chars}
        sessions={sessions.filter((session) => sessionWorkspace(session) === 'interview')}
        onClose={() => setShowLibrary(false)}
        onSave={async (value) => { const saved = await window.mc.saveLibrary(value); libraryRef.current = saved; setLibrary(saved); }}
        onApply={async (value, personalInfo) => { flushSync(() => patchSession(currentId, (session) => ({ ...session, resumeName: value.resumeName, resumeText: value.resumeText,
          jdName: value.jdName, jdText: value.jdText, personalInfo,
          materialSources: { ...session.materialSources, resume: { sessionName: '默认面试资料', copiedAt: Date.now() }, jd: value.jdText ? { sessionName: value.jdSource || '本场岗位 JD', copiedAt: Date.now() } : undefined, personalInfo: session.materialSources?.personalInfo ? { ...session.materialSources.personalInfo, edited: true } : undefined } })));
          await window.mc.saveSessions({ sessions: sessionsRef.current, currentId: currentIdRef.current });
          window.mc.prewarm({ resume: value.resumeText, jd: value.jdText, personalInfo, immediate: true }); }}
        />}

      {showHealth && settings && health && (
        <ServiceHealthPanel
          settings={settings}
          health={health}
          material={workspace === 'interview' ? current ?? undefined : undefined}
          onClose={() => setShowHealth(false)}
          onOpenSettings={() => {
            setShowHealth(false);
            setShowSettings(true);
          }}
          onOpenDiagnostics={() => {
            setShowHealth(false);
            setShowDiagnostics(true);
          }}
          onSettingsRefreshed={setSettings}
        />
      )}

      {showDiagnostics && <DiagnosticsPanel onClose={() => setShowDiagnostics(false)} />}

      {showHelp && (
        <HelpPanel
          onClose={() => setShowHelp(false)}
          onOpenSettings={() => {
            setShowHelp(false);
            setShowSettings(true);
          }}
          onOpenDiagnostics={() => {
            setShowHelp(false);
            setShowDiagnostics(true);
          }}
        />
      )}

      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onSaved={(s) => {
            setSettings(s);
            answerLangRef.current = s.llm.answerLang;
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
          onRerunWizard={() => {
            setShowSettings(false);
            void window.mc.rerunOnboarding();
          }}
          onOpenDiagnostics={() => {
            setShowSettings(false);
            setShowDiagnostics(true);
          }}
          onOpenHelp={() => {
            setShowSettings(false);
            setShowHelp(true);
          }}
        />
      )}

      {workspace === 'written' && settings ? <WrittenSession
        settings={settings}
        sessions={sessions.filter((session) => sessionWorkspace(session) === 'written')}
        current={current}
        notice={kbNotice}
        onSwitch={setCurrentId}
        onNew={createSession}
        onShot={doRegionShot}
        onClear={clearAnswers}
        onCancel={cancelTurn}
        onStop={() => window.mc.stopAllAnswers()}
        onSettings={() => setShowSettings(true)}
      /> : <div className="panes">
        <TranscriptPanel
          segments={segments}
          partials={partials}
          answersReady={answersReady}
          answersHint={t.health.answersDisabled}
          onAsk={(text, segment) => askLlm('segment', text, segment)}
          onTranslate={translateSegment}
          onClear={clearTranscript}
        />
        <AnswerSession
          sessions={sessions.filter((session) => sessionWorkspace(session) === 'interview')}
          currentId={currentId}
          turns={current?.turns ?? []}
          scripts={current?.scripts ?? []}
          onOpenLibrary={() => { closePanels(); setShowLibrary(true); }}
          showChineseQuestion={!!current?.showChineseQuestion}
          onShowChineseQuestion={showQuestionGloss}
          onTranslateQuestion={(turn) => translateQuestion(currentId, turn.batchId ?? turn.id, turn.label)}
          onRewrite={rewriteAnswer}
          onPinTurn={(turn) => patchSession(currentId, (session) => session.scripts?.some((script) => script.sourceTurnId === turn.id) ? session : ({ ...session,
            scripts: [...(session.scripts ?? []), { id: uid('script'), title: turn.label, text: turn.text, sourceTurnId: turn.id }] }))}
          onAddScript={(title, text) => patchSession(currentId, (session) => ({ ...session, scripts: [...(session.scripts ?? []), { id: uid('script'), title, text }] }))}
          onToggleScript={(id) => patchSession(currentId, (session) => ({ ...session, scripts: session.scripts?.map((script) => script.id === id ? { ...script, collapsed: !script.collapsed } : script) }))}
          onRemoveScript={(id) => patchSession(currentId, (session) => ({ ...session, scripts: session.scripts?.filter((script) => script.id !== id) }))}
          currentQuestion={questionState.editedText ?? questionState.block?.text ?? ''}
          questionEditing={questionState.editedText !== undefined}
          onEditQuestion={(text) => updateQuestion(currentId, { ...questionState, editedText: text })}
          onAnswerQuestion={() => askLlm('segment', questionState.editedText ?? questionState.block?.text, questionState.block)}
          resumeChars={current?.resumeText?.length ?? 0}
          notice={kbNotice}
          visionReady={visionReady}
          answersReady={answersReady}
          answersHint={t.health.answersDisabled}
          onSwitch={setCurrentId}
          onNew={createSession}
          onDelete={deleteSession}
          onRename={renameSession}
          onCancel={cancelTurn}
          clearShortcut={settings?.ui.hotkeyClear ?? 'Control+Alt+Backspace'}
          stopShortcut={settings?.ui.hotkeyStop ?? 'Control+Alt+S'}
          onClear={clearAnswers}
          onFreeAsk={(q) => askLlm('free', q)}
          onShotAsk={doRegionShot}
        />
      </div>}

      {workspace === 'interview' && <StatusBar
        asr={asr}
        capturing={capturing}
        hud={showHud ? { ...hud, lastAnswerFirstMs: current?.turns.at(-1)?.firstTokenMs, lastAnswerCompleteMs: current?.turns.at(-1)?.completedMs } : undefined}
        health={health ?? undefined}
        onOpenHealth={() => setShowHealth((v) => !v)}
      />}
    </div>
    </I18nProvider>
  );
}
