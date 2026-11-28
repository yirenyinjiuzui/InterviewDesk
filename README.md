# InterviewDesk

InterviewDesk 是 Windows 面试与笔试辅助工具。面试时可以转录双方发言，结合简历和岗位要求逐题生成答案；笔试时可以框选题目，让多个视觉模型分别作答。

**[下载 Windows x64 便携版](https://github.com/yirenyinjiuzui/InterviewDesk/releases/latest)** · [版本说明](docs/releases/0.3.18.md)

## 开始使用

1. 打开 Release，下载文件名以 `-win-x64-portable.exe` 结尾的程序并运行。首次启动保留了 MeetingCopilot 的应用名称，已有用户可继续使用原配置。
2. 在设置中选择语音识别服务和答题模型，按所选服务填写自己的 API Key，用连接测试确认可用。
3. 在面试页选择系统声音和麦克风，点击「持续答」开始监听。笔试截图答题需要先配置支持图像输入的模型。

## 功能分工

五个模块共用一份源码和同一套版本号。每个模块页列出负责范围、源码入口和验收方法。

| 模块 | 负责什么 |
| --- | --- |
| [面试转录与持续答](modules/面试转录与持续答/README.md) | 双路收音、问题边界、追问和首句延迟 |
| [面试答案与双语阅读](modules/面试答案与双语阅读/README.md) | 逐句显示、双语对照、改写和回看 |
| [简历、岗位与面试题库](modules/简历、岗位与面试题库/README.md) | 简历和 JD、题库、资料隔离和复用 |
| [笔试截图与多模型答题](modules/笔试截图与多模型答题/README.md) | 截图提问、模型并发和答案对照 |
| [设置、快捷键与诊断](modules/设置、快捷键与诊断/README.md) | 服务配置、连接测试、快捷键和故障诊断 |

## 数据与隐私

应用沿用 Windows 用户资料目录 `%APPDATA%\MeetingCopilot` 保存配置与会话。便携版可以直接运行，也会在本机留下使用记录。选择云端语音识别时，录音会发送到所选服务；请求模型回答时，用于该题的转录、简历或岗位上下文、所选截图也可能发送到对应模型服务。仓库内的示例文档和持续答回放用于测试。

## 从源码运行

在 Windows x64 安装 Node.js 22、npm 和 Python 3.11。原生截图与鼠标辅助程序使用 Windows 的 .NET Framework 4.x C# 编译器。在仓库根目录运行：

```powershell
.\build.cmd
cd app
npm ci
npm run dev
```

在 `app` 目录验证并生成便携版：

```powershell
npm run verify
npm run test:python
npm run verify:patched
npx --no-install electron-builder --win portable --x64 --publish never
```

输出目录为 `app/release/`。发布流程依据根目录 `VERSION`，在 Windows 上构建并将便携版和 SHA-256 校验文件上传至 Release。[发布流程](.github/workflows/release.yml)

## 许可证

基于 JWM0203 的 MeetingCopilot，采用 Apache License 2.0。[上游与改动](app/UPSTREAM.md) · [许可证](LICENSE)
