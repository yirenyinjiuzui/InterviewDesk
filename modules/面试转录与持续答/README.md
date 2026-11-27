# 面试转录与持续答

从系统声音和麦克风采集双方发言，识别问题、处理简短应声，按需触发手动或自动回答。

听写缺字、连续发问、错过追问、录音断线和说完到答案可读的耗时归这里。答案已经到达后如何排版，交给「面试答案与双语阅读」。

## 源码入口

- [app/src/App.tsx](../../app/src/App.tsx)
- [app/src/audio/](../../app/src/audio/)
- [app/electron/asr/](../../app/electron/asr/)
- [app/shared/interviewQuestion.ts](../../app/shared/interviewQuestion.ts)

## 验收

用同一段双声道录音比较版本，主问题只答一次，补充信息并入原题，独立追问另起一题。分别计量主问题和追问从说完到完整首句可读的时间。

2026 年 11 月 27 日的同录音对照包含改动前后的结果和计时方法。[持续答回放验收](回放验收.md)

- [app/test/interviewQuestion.spec.ts](../../app/test/interviewQuestion.spec.ts)
- [app/test/asrCloudUpload.spec.ts](../../app/test/asrCloudUpload.spec.ts)
- [app/tools/interview-question-smoke.cjs](../../app/tools/interview-question-smoke.cjs)

[返回功能分工](../../README.md#功能分工)
