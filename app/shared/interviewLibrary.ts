import type { InterviewLibrary, StoredSession } from './protocol';

export const DEFAULT_INTERVIEW_QUESTIONS = [
  '请做一个简短的自我介绍。 / Tell me about yourself.',
  '介绍你最熟悉的项目，你具体负责什么？ / Describe your project and your own contribution.',
  '项目最大的技术难点是什么，如何解决？ / What was the hardest technical challenge?',
  '你如何衡量项目效果？ / How did you evaluate your results?',
  '如果重新做这个项目，你会改变什么？ / What would you improve?',
  '讲一次失败或犯错，以及你学到了什么。 / Tell me about a failure and what you learned.',
  '如何处理团队分歧？ / How do you handle disagreements?',
  '为什么对这家公司和岗位感兴趣？ / Why this company and role?',
  '你的优势与需要提升的地方是什么？ / What are your strengths and weaknesses?',
  '你如何快速学习不熟悉的技术？ / How do you learn an unfamiliar technology?',
  '解释 RAG 的流程，以及如何评估检索质量。 / Explain RAG and retrieval evaluation.',
  '如何减少大模型幻觉？ / How would you reduce LLM hallucinations?',
  '训练集、验证集和测试集有什么区别？ / Explain training, validation and test sets.',
  '如何排查系统延迟与性能瓶颈？ / How do you diagnose latency and performance?',
  '解释一个你熟悉的算法及时间复杂度。 / Explain an algorithm and its complexity.',
  '你的英语沟通与协作经历是什么？ / Describe your communication and collaboration experience.',
  '何时可以到岗，每周可以实习多久？ / When can you start and what is your availability?',
  '你有什么想问我们的？ / What questions do you have for us?',
];

// Older databases used this source when seeding the default directly from knowledge.md.
export const LEGACY_GLOBAL_SOURCE = '旧全局资料 / Previous global material';

export function withDefaultResume(session: StoredSession, library?: InterviewLibrary | null): StoredSession {
  if ((session.workspace ?? 'interview') !== 'interview' || !library || library.resumeSource === LEGACY_GLOBAL_SOURCE) return session;
  let result = session;
  const source = { sessionName: '默认面试资料 / Default interview materials', copiedAt: Date.now() };
  if (!session.resumeText?.trim() && !session.kbText?.trim() && library.resumeText.trim()) result = { ...result,
    resumeName: library.resumeName, resumeText: library.resumeText, materialSources: { ...result.materialSources, resume: source } };
  return result;
}
