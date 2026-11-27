# 简历、岗位与面试题库

负责默认简历、本场岗位 JD、确认信息、题库准备和复用，以及专业知识参考。

面试材料从哪里来、不同岗位能否复用答案、旧会话资料如何恢复，归这里。

## 源码入口

- [app/src/components/InterviewLibraryPanel.tsx](../../app/src/components/InterviewLibraryPanel.tsx)
- [app/electron/interviewLibrary.ts](../../app/electron/interviewLibrary.ts)
- [app/shared/interviewBank.ts](../../app/shared/interviewBank.ts)
- [app/shared/sessionMaterials.ts](../../app/shared/sessionMaterials.ts)
- [app/shared/technicalKnowledge.ts](../../app/shared/technicalKnowledge.ts)

## 验收

用一份合成简历和两份不同的 JD 建立两场面试，核对资料隔离、同题复用和重新打开后的内容。

- [app/test/interviewBank.spec.ts](../../app/test/interviewBank.spec.ts)
- [app/test/sessionMaterials.spec.ts](../../app/test/sessionMaterials.spec.ts)
- [app/tools/interview-bank-smoke.cjs](../../app/tools/interview-bank-smoke.cjs)

[返回功能分工](../../README.md#功能分工)
