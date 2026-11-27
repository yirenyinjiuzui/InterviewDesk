# 设置、快捷键与诊断

负责首次向导、模型与代理配置、服务连接测试、会前检查、全局快捷键和鼠标侧键。

启动后如何配通、键位冲突、模型连不上时如何定位，归这里。连接正常后的语音或作答问题交给对应功能对话。

## 源码入口

- [app/src/onboarding/](../../app/src/onboarding/)
- [app/src/components/SettingsPanel.tsx](../../app/src/components/SettingsPanel.tsx)
- [app/src/components/ServiceHealthPanel.tsx](../../app/src/components/ServiceHealthPanel.tsx)
- [app/src/components/DiagnosticsPanel.tsx](../../app/src/components/DiagnosticsPanel.tsx)
- [app/electron/settings.ts](../../app/electron/settings.ts)
- [app/shared/hotkeys.ts](../../app/shared/hotkeys.ts)

## 验收

在独立测试配置中走一次首次设置和会前检查，模拟不可达接口与冲突快捷键，再保存并重开确认设置。

- [app/test/settings.spec.ts](../../app/test/settings.spec.ts)
- [app/test/providerTest.spec.ts](../../app/test/providerTest.spec.ts)
- [app/test/mouseShortcuts.spec.ts](../../app/test/mouseShortcuts.spec.ts)

[返回功能分工](../../README.md#功能分工)
