# 本地克隆语音部署

## 1. 选型与适用边界

Sunabot 的本地克隆语音服务固定采用 [OpenMOSS/MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)，安装脚本锁定提交 [`9b1d3eadd5a72436fcaa9568351266f154db49a2`](https://github.com/OpenMOSS/MOSS-TTS-Nano/commit/9b1d3eadd5a72436fcaa9568351266f154db49a2)。官方 [README_zh](https://github.com/OpenMOSS/MOSS-TTS-Nano/blob/main/README_zh.md) 明确说明模型为 0.1B、支持 CPU 推理、4 核 CPU 可实时流式推理；官方 ONNX 路径不依赖 PyTorch 推理，并保留语音克隆能力。Sunabot 使用官方 [`app_onnx.py`](https://github.com/OpenMOSS/MOSS-TTS-Nano/blob/main/app_onnx.py) 的 `GET /health` 与 `POST /api/generate`，提交 `text`、`prompt_audio` 和 `cpu_threads=4`，接收 Base64 WAV。

Intel N100 可用性是基于官方 4 核 CPU 陈述作出的工程推断，不能用官方说明代替实机结果。验收固定为单并发、4 线程，冷启动完成后连续执行至少 3 次约 10 秒日语暖合成；目标为 warm RTF ≤ 1.5，硬门槛为 warm RTF ≤ 2、进程组峰值 RSS ≤ 4 GiB、10 秒日语在 20 秒内完成且连续 3 次成功。8 GiB 是最低验收内存，16 GiB 是建议配置；任一硬门槛未达成时，该平台的语音能力保持未通过。

## 2. 组件边界

MOSS-TTS-Nano 是 Core 与 NapCat 之外的独立本地服务。Native Core 默认通过 `http://127.0.0.1:18083` 访问；Docker helper 只把服务发布到宿主回环，同时接入当前 Sunabot Compose 私有网络并提供 `sunabot-moss-tts-nano` 别名，不发布到局域网或公网。Core 只通过 HTTP 发送有界文本和参考音频字节，MOSS 不读取 Agent workspace；Core 校验返回 WAV 后写入当前 Agent 的内容寻址缓存，再通过 durable outbox 和 OneBot `base64://` `record` 段交给 NapCat。三个组件不得共享绝对路径。

Docker Core 不能使用容器内 `127.0.0.1` 访问宿主 MOSS。默认 Compose 配置通过 `http://sunabot-moss-tts-nano:18083` 访问同一私有网络内的语音容器；显式覆盖地址时仍须保证端点不暴露到局域网或公网。管理 API 不挂载 Docker socket，检查、启动和关闭请求通过 workspace 内的请求/结果桥交给宿主 account runtime daemon；宿主只操作带 `io.sunabot.component=voice` 和当前 workspace identity 标签的固定容器，同名异主容器必须拒绝。

`./sunabot.sh up|start|restart` 的清空后启动流程会在删除当前 workspace runtime network 前断开 owned MOSS endpoint，创建新网络后再以 `sunabot-moss-tts-nano` 别名接入。该流程不停止或重建 MOSS 容器，不重复下载权重，也不丢失已加载模型；`down` 完成后独立 MOSS 容器可以继续通过宿主回环端口运行，并在下一次完整启动时恢复私网连接。标签不匹配、断开失败或重新接入失败时根入口必须报错，不能强制删除其他实例的容器或网络。

## 3. 安装与启动

推荐在 N100、Linux、WSL2 和无法稳定启动 Conda Python 的 macOS 上使用固定镜像路径：

```bash
tools/build_moss_tts_nano_image.sh
tools/start_moss_tts_nano_docker.sh --detach
```

镜像以固定摘要的 Miniforge 为基础，检出固定 MOSS revision，安装 `pynini=2.1.6.post1` 与官方依赖，并应用仓库内可审阅的 `moss-tts-nano-api-low-memory.patch`。该模式只加载 Sunabot 使用的非流式 `/api/generate` 会话，关闭 ONNX Runtime CPU arena、memory pattern、后台 warmup 和 WeText FST 预加载；客户端明确关闭 WeText，继续使用 MOSS 自带的轻量文本规范化。MOSS 的浏览器流式接口不属于该镜像的运行合同。

首次启动会在 ignored 的 `workspace/runtime/voice/models` 中按固定 Hugging Face revision 确定性补全两个官方 ONNX 仓，并写入含 revision 的完成标记；下载中断后重启会继续补全，不能把仅存在 TTS 目录视为 codec 已就绪。参考音频上传、规范化缓存和生成输出分别挂载到独立 ignored 目录，容器使用当前宿主 UID/GID，服务只发布到 `127.0.0.1`。

Native 安装机需要 Git、Conda 和网络；Kivo 参考音频转换另需 FFmpeg。默认安装目录是 ignored 的 `workspace/runtime/voice/MOSS-TTS-Nano`，默认 Conda 环境是 `sunabot-moss-tts-nano`：

```bash
tools/install_moss_tts_nano.sh
```

安装器校验官方 origin、拒绝修改过的 checkout、切换到固定提交，创建 Python 3.12 环境并安装 `pynini=2.1.6.post1`、官方 requirements 和本地包。首次启动可能需要从官方配置的模型来源下载 ONNX 权重；离线部署应预先准备模型目录，并通过 `SUNABOT_MOSS_TTS_NANO_MODEL_DIR` 显式指定。

启动回环服务：

```bash
tools/start_moss_tts_nano.sh
```

支持的环境变量：

| 变量                                | 默认值                                                  | 用途                        |
| ----------------------------------- | ------------------------------------------------------- | --------------------------- |
| `SUNABOT_MOSS_TTS_NANO_DIR`         | `workspace/runtime/voice/MOSS-TTS-Nano`                 | Native 官方 checkout        |
| `SUNABOT_MOSS_TTS_NANO_CONDA_ENV`   | `sunabot-moss-tts-nano`                                 | Native Conda 环境名         |
| `SUNABOT_MOSS_TTS_NANO_IMAGE`       | `sunabot-moss-tts-nano:9b1d3eadd5a7`                    | Docker 镜像                 |
| `SUNABOT_MOSS_TTS_NANO_CONTAINER`   | `sunabot-moss-tts-nano`                                 | Docker 容器名               |
| `SUNABOT_MOSS_TTS_NANO_PORT`        | `18083`                                                 | 回环服务端口                |
| `SUNABOT_MOSS_TTS_NANO_CPU_THREADS` | `4`                                                     | ONNX CPU 线程数             |
| `SUNABOT_MOSS_TTS_NANO_OUTPUT_DIR`  | `workspace/runtime/voice/generated`                     | 服务自身输出目录            |
| `SUNABOT_MOSS_TTS_NANO_MODEL_DIR`   | Docker 为 `workspace/runtime/voice/models`，Native 为空 | ONNX 模型目录               |
| `SUNABOT_MOSS_TTS_NANO_CACHE_DIR`   | `workspace/runtime/voice/cache`                         | Docker 文本规范化缓存       |
| `SUNABOT_MOSS_TTS_NANO_UPLOAD_DIR`  | `workspace/runtime/voice/uploads`                       | Docker 临时参考音频上传目录 |
| `SUNABOT_MOSS_TTS_NANO_URL`         | `http://127.0.0.1:18083`                                | Core 访问地址               |

`SUNABOT_MOSS_TTS_NANO_URL` 供 Core 使用，其他启动变量供 MOSS helper 使用。生产地址不得包含用户信息、查询或片段；Native 模式保持回环，Docker 模式使用受控私网地址。

## 4. 配置参考音频

管理台“语音”页面可以检测、启动和关闭 MOSS-TTS-Nano；关闭前需要确认，镜像未安装、Docker 不可用、私有网络缺失或同名容器归属冲突时会显示对应结果。服务控制是全局操作，Voice Profile 仍按 Agent 配置启用状态、默认语言和中文、English、日本語三份独立参考音频。每份参考音频不超过 8 MiB，并填写与音频逐字对应的参考台词；默认语言已有参考音频后才能启用 Voice Profile。服务显示可用后，在 Agent 工具目录启用 `send_voice_message`。

小春、普拉娜、阿罗娜的日语样本可以从 [Kivo](https://kivo.wiki/) 在本机准备。下载器只接受固定 Kivo API 与 `static.kivo.wiki/voices/` HTTPS 音频，确定性选择含日语假名的适中台词，转换为 48 kHz、双声道、16-bit PCM WAV，并合并对应 Agent 的 `voice/profile.json`：

```bash
python3 tools/download_kivo_voice_references.py --agent koharu --dry-run
python3 tools/download_kivo_voice_references.py --agent koharu
python3 tools/download_kivo_voice_references.py --agent plana
python3 tools/download_kivo_voice_references.py --agent arona
```

脚本支持中断后重跑，同一内容收敛到同一 SHA-256 文件，并保留既有 `zh`、`en` 槽位。Kivo 音频、Voice Profile、来源台词和生成缓存只留在 ignored workspace，不进入 Git、发行包或 Agent 配置文件夹导入载荷；使用和分发仍需遵守素材来源的权利与授权要求。

## 5. 合成与外发验收

服务与 Profile 就绪后，分别运行三 Agent 的真实合成检查：

```bash
node tools/check_voice_synthesis.mjs --agent koharu
node tools/check_voice_synthesis.mjs --agent plana
node tools/check_voice_synthesis.mjs --agent arona
```

检查器复验 Profile、参考文件大小与 SHA-256、服务健康、生成接口、响应大小、Base64 和 WAV 结构，并输出合成耗时、输出字节数与摘要。N100 现地验收还需记录输出音频时长、RTF 和 MOSS 进程组峰值 RSS，并按第 1 节的目标与硬门槛判定。

2026-07-19 的 macOS ARM64 + 4 vCPU Docker 冒烟已完成三个日语 Profile 的真实合成：小春 6.80 秒 WAV 用时 4.238 秒、RTF 0.623；普拉娜 4.56 秒 WAV 用时 3.332 秒、RTF 0.731；阿罗娜 10.16 秒 WAV 用时 6.442 秒、RTF 0.634。连续暖请求采样峰值约 1.34—1.75 GiB，结束后空闲约 1.29 GiB，容器保持 `OOMKilled=false`。这些数据证明当前 API-only 镜像在该机器上满足项目内存与 RTF 门槛，不能替代 Intel N100、Linux/WSL、Docker Core 私网和真实 QQ 的现地验收。

真实 QQ 验收至少覆盖三个 Agent 的私聊与群聊、primary 与 secondary 账号、早安、晚安、喜爱或亲密表达、强烈情绪、害羞和重要里程碑，并确认普通事实、任务进度、错误、代码、命令、URL 与长内容没有语音。每份语音必须由 `send_voice_message` Function Call 触发，正文与同一 response 的可见 text、`assistant_text.text` 或 deferred `dispatch_message` 完全一致，表情标记不读出。

文字与语音各自在准备完成的瞬间自然进入 durable outbox，验收不规定固定先后顺序；语音合成失败时文字仍发送，文字准备失败时已成功的语音仍可入队。deferred acknowledgement 与任务必须原子落盘，合成完成后只追加一份语音；断线、重连、重启和 outbox 重试不得重复文字、任务或语音。Docker Core 还需验证私网 MOSS 端点、无共享路径、真实 `record` 外发和服务恢复。

完整自动化与人工矩阵见 [验证标准与已知限制](../specs/08-validation.md)。
