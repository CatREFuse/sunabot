# 在线语音合成

## 1. 协议选择

语音合成市场没有覆盖全部供应商的统一克隆、注册与合成协议。Sunabot 的首个在线适配协议采用 OpenAI Audio 兼容接口：鉴权使用 Bearer API Key，健康检测读取 `GET /v1/models/{model}`，合成调用 `POST /v1/audio/speech`，提交 `model`、`input`、`voice`、`response_format=wav` 与 `stream_format=audio`，接收 WAV 字节。OpenAI 的 `voice` 同时接受内置音色字符串与 `{id}` 自定义音色；Sunabot 对 `voice_` 前缀的 ID 使用自定义音色对象，其他值作为兼容接口的音色字符串发送。

选用该协议的原因是请求字段、Bearer 鉴权、模型 ID 和二进制音频响应已形成可复用的兼容形态。音色注册仍是供应商专有能力：OpenAI 使用 `/v1/audio/voices` 并要求 consent；ElevenLabs 把 `voice_id` 放在 `/v1/text-to-speech/{voice_id}` 路径并使用 `xi-api-key`；Fish Audio 使用 `/v1/tts` 的 `reference_id` 或内联 references；MiniMax 需要文件上传与 `/v1/voice_clone`；CosyVoice 先调用声音复刻定制接口取得 voice ID。上述协议不能伪装成同一请求模板，后续接入应新增显式 adapter，不能允许浏览器配置任意 Header、路径模板或响应解析代码。

官方协议参考：

- [OpenAI Create speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)
- [OpenAI Create voice](https://developers.openai.com/api/reference/resources/audio/subresources/voices/methods/create)
- [ElevenLabs Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Fish Audio Text to Speech](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
- [MiniMax Voice Clone](https://platform.minimaxi.com/docs/api-reference/voice-cloning-clone)
- [Alibaba CosyVoice Voice Clone](https://help.aliyun.com/en/model-studio/cosyvoice-clone-api-reference)

## 2. 配置与 Agent 隔离

管理台“语音”页面按当前 Agent 保存 schemaVersion 1 Voice Profile。在线 Provider 配置包含固定 `protocol=openai-audio`、Base URL、API Key 环境变量名、模型 ID，以及中文、English、日本語三项音色 ID。API Key 值只从 Core 进程环境读取，不写入 Profile、管理 API 响应、浏览器存储、日志或 Git。生产 Base URL 必须使用无凭据 HTTPS；开发测试只允许回环 HTTP，地址不得包含 query 或 fragment。

在线检测状态固定为“可用”“未配置”或“不可用”。API Key 环境变量为空时返回“未配置”和固定提示“API Key 未配置”；只有已配置凭据后的连接、鉴权或供应商错误才显示“不可用”。管理 API 不返回凭据值或供应商响应正文。

逐语言音色 ID 决定合成语言和音色。`send_voice_message` Function Call 只提供待朗读正文，模型不能提交语言、音色 ID、服务地址、账号或目标。运行时从当前 Agent Voice Profile 读取默认语言和对应音色 ID，因此主会话语言与语音设置相互独立。启用语音前必须为默认语言配置音色 ID；参考音频与台词保留为可选音色资料，不参与当前在线合成请求，也不阻止替换或删除。

旧 schemaVersion 1 Profile 缺少 `provider` 时按默认 OpenAI Audio 配置读取，不修改原文件；由于逐语言音色 ID 为空，旧 Profile 不会向 Provider 暴露语音工具。管理员保存在线设置并重新启用后恢复能力。旧 MOSS 模型、镜像、容器和 `workspace/runtime/voice` 资产不再属于运行合同，Core 和管理台不安装、启动、探测或连接本地语音服务。升级后的 launcher 在清空运行时阶段只会停止并移除带当前 workspace 旧 Voice 标签的遗留容器，避免其 endpoint 阻塞 runtime network 删除；归属标签冲突时失败关闭，清理完成后不再创建或接入该容器。

## 3. 合成与外发

客户端把 1—300 字正文发送到当前 Agent 配置的在线端点，固定请求 WAV，响应上限 32 MiB。客户端拒绝重定向、超时、非成功 HTTP、无响应体、超限数据和非 WAV 内容；公开错误不包含供应商响应正文、API Key、正文、服务地址或宿主路径。合法结果按 SHA-256 写入当前 Agent `workbench/.voice-cache/voice-<sha256>.wav`，经 `conversation_asset` schema v2、冻结目标、reply gate、文件身份和摘要门禁转为 OneBot `record` 的 `base64://` 字节。

同源文字与语音并行准备，各自在准备完成时自然进入 durable outbox，不设置固定先后顺序。文字失败不取消已成功语音，合成失败不取消文字；deferred `dispatch_message` 的任务与 acknowledgement 先原子落盘，语音合成完成后通过绑定 turn 的 emitter 追加一次。断线、重连、重启和 outbox 重试不能重复文字、任务或语音。

## 4. 验证

自动化至少覆盖：

- Provider 配置 exact schema、HTTPS/回环地址、环境变量名、模型与逐语言音色 ID；
- 内置音色字符串、自定义 `{id}` 音色、Bearer 鉴权、模型探针、WAV、超时、HTTP、超限和无效响应；
- Profile 启用门禁、旧 Profile 兼容、Agent 隔离与切换迟到响应；
- WebUI 保存、连接检测、缺少 API Key、桌面与移动端 light/dark；
- 五种 Provider 协议中的 `send_voice_message` 终止 companion、同源正文与文字/语音自然独立入队；
- Linux/WSL 与 macOS 源码形态的 Native Core 使用同一在线协议；NapCat 保持每账号独立 Docker 容器，语音合成不依赖本地语音进程、额外语音容器、网络别名或共享文件路径。

真实验收需使用已获授权的在线账号、模型和音色 ID，分别完成至少两个 Agent 的日语合成与 QQ 私聊/群聊 `record` 外发。供应商限额、地区、模型权限、音色授权与数据处理条款由部署者确认；自动化 fixture 不能替代真实在线合成和真实 QQ 发送。
