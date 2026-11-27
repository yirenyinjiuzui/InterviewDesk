import { useEffect, useRef, useState } from 'react';
import type { InterviewBankAnswer, InterviewLibrary, InterviewLibraryUpdate, PersonalInfo, PersonalInfoCategory, StoredSession } from '../../shared/protocol';
import { LEGACY_GLOBAL_SOURCE } from '../../shared/interviewLibrary';
import { PERSONAL_INFO_CATEGORIES } from '../../shared/sessionMaterials';
import { answerForMaterial, bankMaterialKey, generalBankKey, validAnswerLanguages, parseBankAnswer, bankAnswerText } from '../../shared/interviewBank';
import { technicalKnowledge } from '../../shared/technicalKnowledge';
import { useT } from '../i18n';

export function InterviewLibraryPanel({ library, sessions, current, hasLegacyFile, onSave, onApply, onClose }: {
  library: InterviewLibrary; sessions: StoredSession[]; current?: StoredSession | null; hasLegacyFile: boolean;
  onSave: (value: InterviewLibraryUpdate) => Promise<void>;
  onApply: (value: InterviewLibrary, personalInfo: PersonalInfo) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT(), zh = t.uiLang === 'zh';
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const [tab, setTab] = useState('materials');
  const [sessionResume] = useState(() => current ? {
    resumeName: current.resumeName ?? '', resumeText: current.resumeText ?? '',
    resumeSource: current.materialSources?.resume?.sessionName ?? '',
  } : library);
  const [draft, setDraft] = useState(() => ({ ...library, resumeName: sessionResume.resumeName,
    resumeText: sessionResume.resumeText, resumeSource: sessionResume.resumeSource, jdName: current?.jdName ?? '', jdText: current?.jdText ?? '', jdSource: current?.materialSources?.jd?.sessionName ?? '' }));
  const [info, setInfo] = useState<PersonalInfo>(() => structuredClone(current?.personalInfo ?? {}));
  const [questionText, setQuestionText] = useState(library.questions.join('\n'));
  const [search, setSearch] = useState('');
  const [answers, setAnswers] = useState<Record<string, InterviewBankAnswer>>(library.answers ?? {});
  const preparing = useRef(false);
  const preparationId = useRef('');
  useEffect(() => () => { preparing.current = false; if (preparationId.current) window.mc.llmCancel(preparationId.current); }, []);
  const materialKey = bankMaterialKey(draft.resumeText, draft.jdText, info);
  const generalKey = generalBankKey(draft.resumeText, info);
  const currentAnswer = (question: string, drafts = answers) =>
    answerForMaterial({ answers: drafts, answerHistory: library.answerHistory }, question, materialKey, generalKey);
  const questions = [...new Set(questionText.split('\n').map((q) => q.trim()).filter(Boolean))];
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const importFile = async (slot: 'resume' | 'jd' | 'legacy') => {
    try {
      const result = await window.mc.pickKnowledge(slot);
      if (!result) return;
      if (!result.text.trim()) { setMessage(zh ? '文件没有可读取的文字，请换用文本文件。' : 'No readable text in this file.'); return; }
      setDraft((old) => slot !== 'jd' ? { ...old, resumeName: result.name, resumeText: result.text, resumeSource: result.name }
        : { ...old, jdName: result.name, jdText: result.text, jdSource: result.name });
    } catch (e) { setMessage((e as Error).message); }
  };
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      const savedAnswers = { ...answers };
      for (const question of questions) {
        const answer = answers[question];
        const original = library.answers?.[question];
        if (answer?.english.trim() && answer.chinese.trim() && (answer.english !== original?.english || answer.chinese !== original?.chinese)) {
          savedAnswers[question] = parseBankAnswer(bankAnswerText(answer, 'english'), answer.materialKey);
        }
      }
      const value = { ...draft, questions, answers: savedAnswers };
      const publishResume = draft.resumeText !== sessionResume.resumeText || draft.resumeName !== sessionResume.resumeName
        || (library.resumeSource === LEGACY_GLOBAL_SOURCE && draft.resumeSource === 'knowledge.md');
      await onApply(value, info);
      const bank = { questions, answers: savedAnswers };
      await onSave(publishResume ? { ...library, ...bank,
        resumeName: draft.resumeName, resumeText: draft.resumeText, resumeSource: draft.resumeSource,
      } : bank);
      onClose();
    }
    catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  };
  const editAnswer = (question: string, field: 'english' | 'chinese', text: string) => setAnswers((old) => ({ ...old,
    [question]: { english: currentAnswer(question, old)?.english ?? '', chinese: currentAnswer(question, old)?.chinese ?? '', [field]: text, materialKey } }));
  const prepareAll = async () => {
    preparing.current = true; setBusy(true); setMessage('');
    const next = { ...answers };
    let completed = 0;
    try {
      for (const question of questions) {
        if (!preparing.current) break;
        const prepared = currentAnswer(question, next);
        if (!prepared || !validAnswerLanguages(prepared.english, prepared.chinese)) {
          preparationId.current = `prepare-${Date.now()}-${completed}`;
          setMessage(zh ? `正在准备 ${completed + 1} / ${questions.length}` : `Preparing ${completed + 1} / ${questions.length}`);
          const answer = await window.mc.prepareBankAnswer({ requestId: preparationId.current, question,
            resume: draft.resumeText, jd: draft.jdText, personalInfo: info });
          if (!preparing.current) break;
          next[question] = answer;
          await onSave({ mode: 'prepare', questions: [question], answers: { [question]: answer } });
          setAnswers({ ...next });
        }
        completed++;
      }
      if (preparing.current) setMessage(zh ? `已准备 ${completed} 道答案。可展开核对，点击“保存并用于本场”后自动匹配。` : `Prepared ${completed} answers. Review, then save and use for this session.`);
    } catch (e) { if (preparing.current) setMessage((e as Error).message); }
    finally { preparing.current = false; preparationId.current = ''; setBusy(false); }
  };
  const stopPreparation = () => { preparing.current = false; if (preparationId.current) window.mc.llmCancel(preparationId.current); setMessage(zh ? '已停止，已完成的答案已保存。' : 'Stopped. Completed answers are saved.'); };
  const useSession = (s: StoredSession) => setDraft((old) => ({ ...old, resumeName: s.resumeName ?? s.kbName ?? '',
    resumeText: s.resumeText ?? s.kbText ?? '', resumeSource: s.name, jdName: s.jdName || '', jdText: s.jdText || '', jdSource: s.name }));
  return <dialog ref={dialog} className="material-dialog" aria-label={zh ? '面试资料' : 'Interview materials'} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <section className="settings library-panel">
      <div className="material-panel-head"><h2>{zh ? '面试资料' : 'Interview materials'}</h2><button className="btn btn-sm" onClick={onClose}>{zh ? '关闭' : 'Close'}</button></div>
      <div className="material-tabs">{[['materials', zh ? '简历与岗位' : 'Resume & job'], ['questions', zh ? '题库' : 'Questions']].map(([id, label]) => <button key={id} className={`btn btn-sm ${tab === id ? 'btn-on' : ''}`} onClick={() => setTab(id)}>{label}</button>)}</div>
      <fieldset disabled={busy} className="library-material-fields" hidden={tab !== 'materials'}>
        <p className="settings-hint">{zh ? '简历可用于本场和以后的新面试。岗位 JD 仅用于本场，新建面试时可粘贴或导入新的 JD。' : 'The resume applies to this and future interviews. Paste or import a separate job description for each session.'}</p>
        {current && <p className="settings-hint">{zh ? '本场：' : 'This session: '}{current.resumeName || (zh ? '无简历' : 'No resume')} · {current.jdName || (current.jdText ? (zh ? '已填写本场 JD' : 'Session JD provided') : (zh ? '无岗位资料' : 'No job material'))}</p>}
        <details className="material-help"><summary>{zh ? '从已有会话导入' : 'Import from a saved session'}</summary>
          <select className="session-select" aria-label={zh ? '从已有会话导入' : 'Import saved materials'} value="" onChange={(e) => {
            const source = e.target.value;
            if (source === 'legacy-global-resume') void importFile('legacy');
            else if (source === 'legacy-default-jd') setDraft({ ...draft, jdName: library.jdName ?? '', jdText: library.jdText ?? '', jdSource: library.jdSource ?? '' });
            else { const session = sessions.find((s) => s.id === source); if (session) useSession(session); }
          }}>
            <option value="">{zh ? '选择会话' : 'Select session'}</option>
            {(hasLegacyFile || library.resumeSource === LEGACY_GLOBAL_SOURCE) && <option value="legacy-global-resume">{zh ? '导入旧版全局资料（简历）' : 'Import previous global resume'}</option>}
            {library.jdText && <option value="legacy-default-jd">{zh ? '导入旧版默认 JD' : 'Import previous default JD'}</option>}
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </details>
        <div className="library-actions"><strong>{zh ? '简历' : 'Resume'}</strong><button className="btn btn-sm" onClick={() => void importFile('resume')}>{zh ? '导入简历' : 'Import resume'}</button></div>
        <input data-library="name" aria-label={zh ? '简历名称' : 'Resume name'} placeholder={zh ? '简历名称' : 'Resume name'} value={draft.resumeName} onChange={(e) => setDraft({ ...draft, resumeName: e.target.value })} />
        <textarea rows={4} data-library="resume" aria-label={zh ? '简历内容' : 'Resume text'} value={draft.resumeText} onChange={(e) => setDraft({ ...draft, resumeText: e.target.value, resumeSource: zh ? '手动编辑' : 'Manual entry' })} />
        <div className="library-actions"><strong>{zh ? '岗位 JD' : 'Job description'}</strong><button className="btn btn-sm" onClick={() => void importFile('jd')}>{zh ? '导入 JD' : 'Import JD'}</button></div>
        <input data-library="jd-name" aria-label={zh ? '岗位资料名称' : 'Job material name'} placeholder={zh ? '岗位资料名称' : 'Job material name'} value={draft.jdName ?? ''} onChange={(e) => setDraft({ ...draft, jdName: e.target.value })} />
        <textarea rows={4} data-library="jd" aria-label={zh ? '岗位 JD 内容' : 'Job description text'} value={draft.jdText ?? ''} onChange={(e) => setDraft({ ...draft, jdText: e.target.value, jdSource: zh ? '手动编辑' : 'Manual entry' })} />
        {current && <details className="session-supplement personal-info">
          <summary>{zh ? '本场补充信息（可选）' : 'Session details (optional)'}</summary>
          <p className="settings-hint">{zh ? '补充到岗安排或纠正简历中的旧信息，仅用于本场。待确认内容不会当作事实。' : 'Add availability or correct outdated resume details for this session. Pending items are not treated as facts.'}</p>
          {(Object.keys(PERSONAL_INFO_CATEGORIES) as PersonalInfoCategory[]).map((key) => <details className="personal-category" key={key}>
            <summary>{PERSONAL_INFO_CATEGORIES[key][zh ? 0 : 1]}<span>{info[key]?.pending.trim() ? (zh ? '待确认' : 'Pending') : info[key]?.confirmed.trim() ? (zh ? '已填写' : 'Filled') : (zh ? '未填写' : 'Empty')}</span></summary>
            {(['confirmed', 'pending'] as const).map((field) => <label key={field}>{field === 'confirmed' ? (zh ? '已确认' : 'Confirmed') : (zh ? '待确认' : 'Pending')}<textarea rows={2} data-fact={key + '-' + field} value={info[key]?.[field] ?? ''} onChange={(e) => setInfo((old) => ({ ...old, [key]: { confirmed: old[key]?.confirmed ?? '', pending: old[key]?.pending ?? '', [field]: e.target.value } }))} /></label>)}
          </details>)}
        </details>}
      </fieldset>
      <div hidden={tab !== 'questions'}>
        <p className="settings-hint">{zh ? '所有已保存问答自动参与匹配，无需选用。开启持续答后，命中题库直接显示答案；未命中则生成新答案。' : 'All saved answers are matched automatically. Enable continuous answers to reuse matches; other questions generate normally.'}</p>
        <p className="settings-hint">{zh ? '内置专业知识自动参考。可在面试前准备个人答案；更换 JD 后，标记为“需重新准备”的答案可重新准备。' : 'Technical references are used automatically. Optionally prepare personal answers before the interview and refresh outdated ones after changing the JD.'}</p>
        <div className="library-actions"><button className="btn btn-sm" disabled={busy || !questions.length} onClick={() => void prepareAll()}>{zh ? '准备全部答案' : 'Prepare all answers'}</button>{busy && <button className="btn btn-sm" onClick={stopPreparation}>{zh ? '停止准备' : 'Stop preparation'}</button>}</div>
        <input data-library="search" placeholder={zh ? '搜索题目' : 'Search questions'} value={search} onChange={(e) => setSearch(e.target.value)} />
        <details className="material-help"><summary>{zh ? '内置专业知识' : 'Built-in technical reference'} ({technicalKnowledge.length})</summary>
          {technicalKnowledge.filter((entry) => [entry.title, entry.note, ...entry.terms].join(' ').toLowerCase().includes(search.trim().toLowerCase())).map((entry) =>
            <p key={entry.title}><strong>{entry.title}</strong><br />{entry.note}</p>)}
        </details>
        <div className="library-questions">{questions.filter((q) => q.toLowerCase().includes(search.toLowerCase())).map((question) => {
          const answer = currentAnswer(question);
          return <details className="bank-entry" key={question}>
          <summary>{question}<span>{answer && validAnswerLanguages(answer.english, answer.chinese) ? (zh ? '已准备' : 'Ready') : answers[question] ? (zh ? '需重新准备' : 'Outdated') : (zh ? '待准备' : 'Not ready')}</span></summary>
          <label>{zh ? '英文答案' : 'English answer'}<textarea rows={4} data-bank-english={question} disabled={busy} value={answer?.english ?? ''} onChange={(e) => editAnswer(question, 'english', e.target.value)} /></label>
          <label>{zh ? '中文翻译' : 'Chinese translation'}<textarea rows={4} data-bank-chinese={question} disabled={busy} value={answer?.chinese ?? ''} onChange={(e) => editAnswer(question, 'chinese', e.target.value)} /></label>
        </details>; })}</div>
        <details className="material-help"><summary>{zh ? '编辑题目（每行一道，中英文或等价问法可用 / 分隔）' : 'Edit questions (one per line; separate equivalent aliases with /)'}</summary><textarea disabled={busy} rows={6} data-library="questions" aria-label={zh ? '题库内容' : 'Question bank'} value={questionText} onChange={(e) => setQuestionText(e.target.value)} /></details>
      </div>
      {message && <div role="status" className="conn-hint">{message}</div>}
      <div className="settings-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{zh ? '保存并用于本场' : 'Save and use for this session'}</button></div>
    </section>
  </dialog>;
}
