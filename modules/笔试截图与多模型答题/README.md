# 笔试截图与多模型答题

负责笔试界面的截图提问、去重、多模型响应、答案对照、停止生成和窄窗口布局。

一次截图发给哪些已选模型、不同模型何时显示答案，归这里。接口配置和快捷键注册归「设置、快捷键与诊断」。

## 源码入口

- [app/src/components/WrittenSession.tsx](../../app/src/components/WrittenSession.tsx)
- [app/electron/screenshot.ts](../../app/electron/screenshot.ts)
- [app/electron/llm/vision.ts](../../app/electron/llm/vision.ts)
- [app/shared/visionSlots.ts](../../app/shared/visionSlots.ts)
- [src/QuietCapture.cs](../../src/QuietCapture.cs)

## 验收

用虚构题图测试两路模型，让一路延迟或失败，核对另一张答案卡能独立显示、停止后不会写入迟到内容。

- [app/test/visionSlots.spec.ts](../../app/test/visionSlots.spec.ts)
- [app/test/visionTransport.spec.ts](../../app/test/visionTransport.spec.ts)

[返回功能分工](../../README.md#功能分工)
