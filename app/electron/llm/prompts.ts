import { technicalReference } from '../../shared/technicalKnowledge';

/**
 * Prompt construction for meeting/interview answering (pure logic, TDD).
 * R4: (a) manual — answer THIS sentence; (b) continuous — advise on recent
 * speech; (c) free — ask over the conversation; (d) translate — translate a
 * line to Chinese. Answer language (zh/en) is a runtime prompt hook.
 *
 * v2 (2026-07-10): cache-friendly three-layer layout —
 *   stable prefix  = persona + 【简历】 + 【岗位JD】 + lang directive
 *                    (BYTE-STABLE across requests → DeepSeek prefix cache)
 *   slow state     = 【面试备忘】memo (updated every few turns)
 *   fast context   = history turns + recent transcript + this question + hint
 */
import type { ChatMessage } from './adapter';
import type { LlmAskPayload, PersonalInfo, WorkspaceMode } from '../../shared/protocol';
import { personalInfoContext } from '../../shared/sessionMaterials';
import { classifyQuestion, isLikelyQuestion, type QuestionKind } from '../../shared/textHeuristics';

export { isLikelyQuestion, classifyQuestion };

export const MAX_CONTEXT_CHARS = 2400;

export type AnswerLang = 'chinese' | 'english';

/** The prompt hook that steers DeepSeek's reply language (R: 模式选择). */
export function langDirective(lang: AnswerLang): string {
  return lang === 'english'
    ? '- 用【英文】输出我要念的完整答案，然后空一行，以「中文翻译：」开头给出该英文答案的完整简体中文翻译。严格只输出英文答案和对应中文翻译，不输出中文备注、提示、建议、分析或额外说明。中文必须忠实翻译英文，不增加英文没有的内容。'
    : '- 用【中文】输出。';
}

const WRITTEN_ANSWER_STYLE = "只输出最终答案，不输出思考过程、解题步骤、分析、题干复述、开场白或结束语。选择题只输出题号（如有）、选项字母和对应内容；填空题、计算题只输出结果；问答题直接作答，用最少的文字保留必要信息，通常不超过三句；代码题只输出所需代码。信息不足或图片不清楚时，用一句话说明缺少什么，不猜答案。";
const INTERVIEW_ANSWER_STYLE = [
  '- 英文普通口语回答优先简短，参考 60 至 100 个英文单词；复杂技术题和代码按需要完整输出，不强制截断。',
  '- 回答使用自然口语，描述个人情况时用第一人称「我」，让我可以直接照着念；',
  '- 第一句先给结论或直接回应，再展开 2-3 个短要点，通常控制在 30-60 秒内可念完；',
  '- 行为/经历类问题按 STAR 展开：情境→任务→行动→结果；',
  '- 技术类问题先一句话讲思路，再给关键点，必要时给复杂度或对比结论；代码题可给出所需代码；',
  '- 不用 Markdown 标题、加粗或多余的格式，不输出内部思考过程；',
  '- 本场已确认个人信息优先于旧简历、岗位资料和 AI 建议。待确认信息不得写成事实；回答必需的个人事实缺失时要求澄清。公司／岗位要求不是个人经历，不推测职位名称、技能熟练度或到岗日期。',
  '- 个人经历只能依据提供的真实资料，绝不编造公司、项目或数字；信息不足或图片不清楚时说明缺少什么，不猜答案。',
].join('\n');
/** teleprompter persona: the output IS what the user reads aloud, verbatim */
const PERSONA = [
  "你是我的实时面试提词器，根据问题直接给出我可以照着念的回答。",
  INTERVIEW_ANSWER_STYLE,
];

/** total injected background budget; keeps prompts bounded regardless of size */
export const MAX_BACKGROUND_CHARS = 8000;
/** when both slots are present the resume gets the bigger share */
export const RESUME_BUDGET = 5000;
export const JD_BUDGET = MAX_BACKGROUND_CHARS - RESUME_BUDGET;

/** resume: keep project/work-experience sections when over budget */
export const RESUME_PRIORITY =
  /(项目|经历|经验|工作|实习|成果|职责|Project|Experience|Work|Achievement)/i;
/** JD: keep responsibilities/requirements sections when over budget */
export const JD_PRIORITY =
  /(职责|要求|责任|任职|资格|技能|优先|加分|Responsibilit|Requirement|Qualification|Skill)/i;

/**
 * Deterministic budget clip that prefers paragraphs matching `priority`
 * (e.g. a resume's project experience, a JD's requirements) instead of a
 * blind head-truncation. Output order stays the original document order.
 */
export function smartClip(text: string, budget: number, priority: RegExp): string {
  const t = text.trim();
  if (t.length <= budget) return t;
  const paras = t.split(/\n{2,}/);
  const picked = new Set<number>();
  let used = 0;
  const tryTake = (i: number) => {
    if (picked.has(i)) return;
    const cost = paras[i].length + 2; // + join separator
    if (used + cost > budget) return;
    picked.add(i);
    used += cost;
  };
  for (let i = 0; i < paras.length; i++) if (priority.test(paras[i])) tryTake(i);
  for (let i = 0; i < paras.length; i++) tryTake(i);
  if (picked.size === 0) return t.slice(0, budget); // one giant paragraph
  return paras
    .map((p, i) => (picked.has(i) ? p : null))
    .filter((p): p is string => p !== null)
    .join('\n\n');
}

/**
 * The BYTE-STABLE system prompt: persona + resume + JD + language directive.
 * Same inputs MUST yield the identical string (no timestamps / randomness) —
 * the LLM prewarm request and every real request share this prefix so the
 * provider's prefix cache (DeepSeek 0.1x pricing + faster prefill) hits.
 */
function materialSections(resume: string, jd: string, info?: PersonalInfo): string[] {
  const parts: string[] = [];
  const r = resume.trim(), j = jd.trim();
  const personal = personalInfoContext(info);
  const budget = MAX_BACKGROUND_CHARS - personal.length;
  const resumeBudget = Math.floor(budget * RESUME_BUDGET / MAX_BACKGROUND_CHARS);
  const jdBudget = budget - resumeBudget;
  if (personal) parts.push(personal);
  if (r) parts.push('【简历】（用户提供资料；与本场已确认信息冲突时，以本场确认信息为准）',
    smartClip(r, j ? Math.max(resumeBudget, budget - j.length) : budget, RESUME_PRIORITY), '【简历结束】');
  if (j) parts.push('【岗位JD】（公司／岗位参考，不是用户经历；按当前问题结合岗位要求说明方案或匹配点；未确认职位名称不得推测）',
    smartClip(j, r ? Math.max(jdBudget, budget - r.length) : budget, JD_PRIORITY), '【岗位JD结束】');
  return parts;
}

export function buildStablePrefix(resume: string, jd: string, lang: AnswerLang, info?: PersonalInfo): string {
  return [...PERSONA, ...materialSections(resume, jd, info), '', langDirective(lang)].join('\n');
}

/** one advisory line appended to the user message; '' when unknown */
export function questionHint(kind: QuestionKind): string {
  switch (kind) {
    case 'behavioral':
      return '（题型：行为/经历题——用 STAR 结构，讲真实资料里的经历）';
    case 'technical':
      return '（题型：技术题——先一句话思路，再关键点，必要时给复杂度）';
    case 'smalltalk':
      return '（题型：寒暄/暖场——一两句自然简短的回应即可，不用展开）';
    default:
      return '';
  }
}

// ---------- P1-5: rolling interview memo (consistency > compression) ----------

/** hard bound on the stored memo (prompt asks for ≤800, clamp defends) */
export const MAX_MEMO_CHARS = 1000;

export function clampMemo(text: string): string {
  const t = text.trim();
  return t.length > MAX_MEMO_CHARS ? t.slice(0, MAX_MEMO_CHARS) : t;
}

/**
 * Fold one finished Q&A into the rolling memo (async, off the critical path).
 * The memo keeps the interview self-consistent: what was asked, what I have
 * claimed as fact, what the interviewer cares about.
 */
export function buildMemoUpdateMessages(oldMemo: string, question: string, answer: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是面试会话的备忘维护器。把新一轮问答合并进备忘，输出更新后的完整备忘。',
        '备忘不超过 800 字，固定四节（无内容的节保留标题写「无」）：',
        '【已问问题】每题一行，最新在最后',
        '【AI 建议（未确认说出）】仅概括模型草稿；不能作为候选人实际经历、数字或立场',
        '新一轮的答是 AI 建议，不是候选人实际发言。旧备忘中所谓已声称的事实也可能来自旧 AI 草稿，一律按未确认建议处理。',
        '【面试官关注点】从提问推断',
        '【注意事项】答得不稳的点、需要圆回来的坑',
        '合并去重；超长时优先丢最旧的已问问题。只输出备忘本身，不要任何解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `【当前备忘】\n${oldMemo.trim() || '（空）'}\n\n【新一轮问题与 AI 建议】\n问：${question.trim()}\nAI 建议（未实际说出）：${answer.trim()}`,
    },
  ];
}

// ---------- P1-6: prefix-cache prewarm ----------

/**
 * The prewarm request: system prompt byte-identical to real answer requests
 * (that's the whole point — DeepSeek caches the common token prefix), plus a
 * constant one-word user turn; max_tokens=1 upstream, reply discarded.
 */
export function buildPrewarmMessages(stablePrefix: string): ChatMessage[] {
  return [
    { role: 'system', content: stablePrefix },
    { role: 'user', content: 'ok' },
  ];
}

export interface AnswerPromptInput {
  personalInfo?: PersonalInfo;
  rewrite?: LlmAskPayload['rewrite'];
  /** the sentence to answer (segment/continuous) or the text to translate */
  question?: string;
  /** recent transcript lines, oldest first */
  recentTranscript: string[];
  mode: 'segment' | 'continuous' | 'free' | 'translate';
  /** free-form user question (mode === 'free') */
  freeQuestion?: string;
  /** reply language for segment/continuous/free (default chinese) */
  answerLang?: AnswerLang;
  /** prior Q&A turns for a coherent session (oldest first) */
  history?: ChatMessage[];
  /** resume slot (双槽资料); falls back to `background` */
  resume?: string;
  /** job-description slot (双槽资料) */
  jd?: string;
  /** explicitly supplied legacy single-slot material */
  background?: string;
  /** rolling interview memo (P1) — slow-changing block, its own message */
  memo?: string;
}

/** Keep the most recent lines within the char budget (oldest dropped first). */
export function clampTranscript(lines: string[], maxChars = MAX_CONTEXT_CHARS): string[] {
  const out: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + 1;
    if (total + len > maxChars) break;
    out.unshift(lines[i]);
    total += len;
  }
  return out;
}

/**
 * Translate a transcript line to Chinese (R: 翻译功能). Fixed target = 中文,
 * output only the translation. If the text is already Chinese the model
 * simply echoes it.
 */
export function buildTranslateMessages(text: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是翻译引擎。把用户给的整段文本翻译成【简体中文】。只输出译文本身，不要加引号、不要解释、不要复述原文；若原文已是中文则原样返回。',
    },
    { role: 'user', content: text.trim() },
  ];
}

/** R5: screenshot Q&A — one multimodal user message for a vision model. */
export function buildVisionMessages(
  question: string,
  imageDataUrl: string,
  background?: string,
  workspace: WorkspaceMode = 'interview',
  answerLang: AnswerLang = 'chinese',
  info?: PersonalInfo,
  materials?: { resume?: string; jd?: string },
): ChatMessage[] {
  const bg = (background ?? '').trim();
  const written = workspace === 'written';
  const structured = !written && !!(materials?.resume || materials?.jd);
  const personal = written || structured ? '' : personalInfoContext(info);
  const sys =
    (written ? '根据截图回答用户的问题，用中文输出。' + WRITTEN_ANSWER_STYLE : PERSONA.join('\n') + '\n' + langDirective(answerLang)) +
    (structured ? '\n\n' + materialSections(materials!.resume ?? '', materials!.jd ?? '', info).join('\n') : bg
      ? `\n\n===== 本人资料与知识库（作答时优先采用） =====\n${bg.slice(0, MAX_BACKGROUND_CHARS - personal.length)}\n===== 资料结束 =====`
      : '') + (personal ? `\n\n${personal}` : '');
  return [
    {
      role: 'system',
      content: written ? sys : [sys,
        '分析代码截图时，先简短引用可辨认的代码行。对 Python，比较块头和关键语句的行首，说明哪些行左对齐、哪一行比哪个块头缩进更深，无需估算空格数。与块头左对齐的语句不属于该块的主体；检查所述归属与对齐关系一致，再按执行顺序解释控制流。由括号划分代码块时，按配对括号判断归属。关键行或层级看不清时，指出需要放大或裁剪的区域，等看清后再判断。',
        technicalReference(question)].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: question.trim() || (written
          ? '请直接给出截图中问题的最终答案。若包含多题，按题号逐行输出。'
          : '请根据截图中的问题或内容，给出我在面试中可以直接照着念的回答。') },
      ],
    },
  ];
}

const CONTEXT_SOURCES = '双方实际发言以带说话人标签的转录为准。没有标签的旧转录说话人未知，不推测归属。历史回答与备忘都是 AI 建议，不代表候选人实际说过或做过。追问应结合上一题、双方实际发言；实际发言与建议冲突时，以实际发言和用户确认资料为准。缺少个人事实时澄清，不自行补齐。';

function suggestionHistory(history: ChatMessage[] | undefined): ChatMessage[] {
  if (!history?.length) return [];
  return [{ role: 'user', content: '【此前问题与 AI 建议（未确认实际说出）】\n' + history.map((m) =>
    `${m.role === 'assistant' ? 'AI 建议（未实际说出）' : '此前问题／手动输入'}：${m.content}`).join('\n') }];
}

export function buildAnswerMessages(input: AnswerPromptInput): ChatMessage[] {
  if (input.mode === 'translate') {
    return buildTranslateMessages(input.question ?? '');
  }

  const lang: AnswerLang = input.answerLang ?? 'chinese';
  const context = clampTranscript(input.recentTranscript);
  const resume = (input.resume ?? '').trim() || (input.background ?? '').trim();
  const jd = (input.jd ?? '').trim();

  const question = (input.rewrite?.question || input.freeQuestion || input.question || '').trim();
  const followUp = /^(?:why|how so|can you elaborate|tell me more|为什么|举个例子|具体一点|展开讲)[?？.!。\s]*$/i.test(question);
  const previous = input.history?.filter((turn) => turn.role === 'user').at(-1)?.content ?? '';
  const roleQuestion = /岗位|胜任|职位|适合.{0,6}角色|this (?:role|position|job)|job requirements|good fit/i.test(question);
  const reference = technicalReference(question)
    || (followUp ? technicalReference(typeof previous === 'string' && previous ? previous : context.slice(-3).join(' ')) : '')
    || (roleQuestion ? technicalReference(jd) : '');
  if (input.rewrite) {
    const instructions = {
      shorter: '更短：保留直接结论与必要信息；英文口语参考 60 至 100 词，原文更短时不要凑字数。技术代码保持完整，不强制截断。',
      expand: '展开：在原答案基础上补充解释、依据或例子，技术题可补充推理、边界与复杂度。不要编造个人经历、成果或数字。',
      rephrase: '换个说法：保持原意和事实，改为更自然、易读的口语表达，不增加未经确认的经历。',
    };
    return [
      { role: 'system', content: buildStablePrefix(resume, jd, lang, input.personalInfo) },
      { role: 'user', content: `${CONTEXT_SOURCES}\n${reference}\n${context.join('\n')}\n\n【需要改写的问题】\n${input.rewrite.question}\n\n【原 AI 建议（未实际说出）】\n${input.rewrite.answer}\n\n${instructions[input.rewrite.style]}\n只输出这条答案的新版本，遵循回答语言。` },
    ];
  }

  // Free "随便问": raw pass-through — NO meeting-assistant persona, so identity
  // / "which model are you" questions get the model's truthful answer. The
  // transcript + KB are offered only as optional reference.
  if (input.mode === 'free') {
    const refs: string[] = [];
    refs.push(...materialSections(resume, jd, input.personalInfo));
    if (reference) refs.push(reference);
    if (context.length) refs.push(`【最近的对话转录】\n${context.join('\n')}`);
    const msgs: ChatMessage[] = [{ role: 'system', content: INTERVIEW_ANSWER_STYLE + '\n' + langDirective(lang) + '\n' + CONTEXT_SOURCES }];
    if (refs.length) {
      msgs.push({ role: 'system', content: `以下资料供参考（可用可不用）：\n\n${refs.join('\n\n')}` });
    }
    msgs.push(...suggestionHistory(input.history));
    msgs.push({ role: 'user', content: (input.freeQuestion ?? '').trim() });
    return msgs;
  }

  // segment / continuous: teleprompter with the stable prefix
  const msgs: ChatMessage[] = [{ role: 'system', content: buildStablePrefix(resume, jd, lang, input.personalInfo) }];

  const memo = (input.memo ?? '').trim();
  if (memo) {
    // slow-changing block sits BETWEEN the stable prefix and the fast history,
    // so a memo refresh only invalidates the cache from this point on
    msgs.push({ role: 'user', content: `【面试进行备忘】（历史 AI 建议摘要，未确认实际说出；不能作为个人事实）\n${memo}` });
    msgs.push({ role: 'assistant', content: '收到，我会保持一致。' });
  }

  msgs.push(...suggestionHistory(input.history));

  const contextBlock = context.length
    ? `【最近的对话转录】\n${context.join('\n')}`
    : '【最近的对话转录】（暂无）';
  const q = (input.question ?? '').trim();
  const hint = q ? questionHint(classifyQuestion(q)) : '';
  const ask = q
    ? `当前待答问题（识别／手动修正）：\n“${q}”\n${hint ? hint + '\n' : ''}请直接给出我可以照着念的回答。`
    : '基于上面最近的转录，面试官最新的话需要我回应。请直接给出我可以照着念的回答。';

  msgs.push({ role: 'user', content: `${CONTEXT_SOURCES}\n\n${contextBlock}\n\n${reference ? reference + '\n\n' : ''}${ask}` });
  return msgs;
}
