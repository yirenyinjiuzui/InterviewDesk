# 面试答案与双语阅读

负责面试答案的展示和改写，包括问题释义、中英双语、固定讲稿、流式阅读和回看。

答案文字已返回但看不清、滚动跳位、译文或改写对错题，归这里。

## 源码入口

- [app/src/components/AnswerSession.tsx](../../app/src/components/AnswerSession.tsx)
- [app/src/components/TranscriptPanel.tsx](../../app/src/components/TranscriptPanel.tsx)
- [app/shared/answerState.ts](../../app/shared/answerState.ts)
- [app/electron/llm/prompts.ts](../../app/electron/llm/prompts.ts)

## 验收

同一题显示原文与译文，改写能追溯到所选答案。长答案生成期间可向上回看，回到最新位置后继续跟随。

- [app/test/interviewReading.spec.ts](../../app/test/interviewReading.spec.ts)
- [app/tools/interview-reading-smoke.cjs](../../app/tools/interview-reading-smoke.cjs)

[返回功能分工](../../README.md#功能分工)
