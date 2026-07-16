# 记忆、文件与图片

[返回当前系统规范索引](./index.md)

## 5. 记忆系统

### 5.1 数据边界

| 来源 | 内容 | 主键和更新方式 |
| --- | --- | --- |
| 工作记忆 | 近期动作、变化、决定、进展、结果和待跟进事件 | 稳定 ID；完整集合替换；快照冲突保护 |
| 长期记忆 | 对未来回复仍有价值的已发生或进行中事件 | event key 与 fingerprint 合并；保留来源工作记忆 ID |
| 用户画像 | 身份、能力、资源、偏好、习惯、边界、长期目标和明确称呼 | QQ 号聚合；画像中的明确称呼优先，管理员配置作为缺省值 |

一次性事件不能写入用户画像。人物属性不能写入长期记忆。工作记忆压缩、长期记忆晋升和用户画像更新在一个 SQLite 事务中提交，批次 ID 用于幂等重放。

### 5.2 调度

记忆调度器按会话保存待处理消息、当前批次、失败次数和自上次尝试后新增的消息数。消息窗口由 `bot.memory.messageThreshold` 控制，默认值为 48，可通过管理台“记忆处理”的“压缩阈值”热更新；阈值变化后运行时必须立即按新值重新检查已排队消息。每累计一个完整消息窗口获得一次压缩尝试，不因静默时间触发不足窗口的部分批次，也不按时间自动重试失败批次。失败批次保留原消息，下一组完整窗口到达后才允许再次尝试；服务重启不额外增加尝试额度。已提交游标之前的消息不能重复入队。

### 5.3 召回

当前召回使用内存 BM25，在工作记忆、长期记忆和用户画像中搜索。返回结果包含来源、事件时间、用户身份和称呼信息。SQLite 负责持久化和有序读取，后续可在不改变调用接口的情况下增加 FTS 索引。

## 6. 文件与图片

### 6.1 QQ 文件

- 支持文本、代码、PDF、图片和常见 Office 文档。
- 原文件按内容哈希进入附件缓存。
- 文本解析流式执行，单文件最多索引 20,000,000 字符。
- 文本分块保存在每个缓存项的 `chunks.sqlite`。
- 模型上下文按查询相关性选择文本块和视觉页，并执行字符数、页数和文件大小限制。
- 原始文件、视觉文件和缓存清单按 TTL 与引用计数回收。

### 6.2 图像生成

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图压缩、重试和 OneBot 外发。`generate_img` 与 `selfie` 的全部生图参数及聊天参考图使用意图由模型填写；历史消息中的图片以 `message:<message-id>:image:<index>` 媒体句柄提供给模型，精确句柄优先于显式 URL 和来源回退。来源回退包含 `none`、`current`、`previous_output`、`history`、`current_and_history`；群聊中的自动历史只选择当前用户的媒体，精确句柄只能解析当前会话和当前捕获序列内的媒体。异步图片任务持久化 dispatch 时的媒体映射快照，旧任务没有快照时按原捕获序列重建。历史生成图的 `/generated-images/` 路径只允许生成图片根目录下的受控 PNG 文件，并在进入模型前转为规范化 Data URL。自拍始终使用当前 Agent 的角色参考图与 `selfie_prompt_rewrite.json`；运行时从当前 Agent workspace 的 `selfie/` 目录读取最多 3 张参考图，并为模型选定的聊天参考图保留第 4 个参考位。管理台可在图像页上传、预览和删除这 3 张图片，列表只读取展示图和低清占位图，打开预览时才读取原图。生成文件保存在忽略的运行目录，图片历史元数据保存在主 SQLite 数据库。

出站媒体必须先通过生成图片根目录、直接子文件、PNG 文件名、常规文件和大小校验，再读取为 OneBot `base64://` 内联数据。Native Core 与 Docker Core 使用同一传输方式，NapCat 不读取 Core workspace，不接受共享绝对路径。超过 OneBot 内联预算的文件必须使用独立、鉴权、限流、可过期的传输协议；不能用容器路径或宿主路径作为降级。

NapCat 上报的 QQ 文件优先通过 OneBot action 返回的受控 URL 进入 Core；统一启动器固定开启 `get_file` Base64 回退。仅返回 NapCat 容器内路径时不能由 Core 直接打开，也不能为兼容该路径而挂载业务 workspace；超过现有 action 预算的文件使用后续明确的流式协议。

### 6.3 Agent workbench 文本文件

每个 Agent 的 `workbench/` 是 `read_file`、`write_file` 与 Bash 共用的私有文件边界。文件工具只处理 well-formed UTF-16、NFC 规范化的 POSIX 相对路径，路径最长 1024 UTF-8 字节，单段最长 255 字节；绝对路径、反斜杠、空段、`.`、`..`、lone surrogate、NFD、C0/C1 控制字符、符号链接、非普通文件、多个硬链接和跨 Agent 路径全部拒绝。大小写与 Unicode replacement character 不折叠或替换。读取上限为 1 MiB，并另以 262,144 个 JavaScript 字符限制模型输出；UTF-8 使用 fatal decoder，文件开头的三字节 BOM 保留为正文首字符 `U+FEFF` 并计入 `byteLength`，无 BOM 正文不变。读取使用 `O_NOFOLLOW` 的同一描述符，在读前、读后及路径复验之间核对根目录、父链、设备、inode、ctime、mtime、大小和链接数，文件在检查后增长时最多读取上限加一个字节后拒绝。

`write_file` 不创建父目录，只能在已经存在且身份稳定的安全目录中发布完整文本。正文先拒绝 lone surrogate 并执行字符与 UTF-8 字节预算校验，不改变正文的 Unicode normalization form；随后写入同目录随机 0600 临时文件，循环写完并 fsync，再从同一描述符冻结设备、inode、ctime、mtime、大小、权限、链接数、SHA-256 与实际正文。`afterTempSynced` 和 `beforePublish` 检查点都位于最终复验之前；发布前重新以 `O_RDONLY | O_NOFOLLOW` 打开临时文件，用同一描述符有界读取并核对路径身份、完整冻结快照、摘要和正文。无覆盖创建通过硬链接发布保证目标不存在，覆盖通过同文件系统 rename 原子替换，随后再次 fsync 目录，并从目标描述符复验安全身份、摘要和正文。失败时清理自身临时路径，错误响应和请求日志只保留稳定错误码、相对路径及大小，不包含正文、宿主绝对路径或文件系统错误元数据。

五种 Provider 协议写入模型请求日志前，必须对日志副本执行 action-aware copy-on-write 投影，实际 SDK request 对象与 fetch JSON 字节保持不变。Responses、Codex Responses、Chat Completions、Anthropic Messages 与 Gemini generateContent 的 `read_file`/`write_file` call 参数只记录 canonical 相对路径或 `[invalid]`；写入参数另记录 `overwrite`、UTF-8 `contentByteLength` 与固定 `[REDACTED]`，不记录正文、额外字段、宿主路径或无密钥摘要。`read_file` result 只保留安全的 `ok`、路径、字节数和固定正文占位，无法解析的结果整块替换为固定占位；`write_file` result 不记录正文。投影只识别各协议真实 call/result lineage，普通 user 与 assistant 文本即使形似工具 JSON 也保持原文。日志入口必须先在不读取 accessor 的前提下生成 inert plain-data 副本；任一 getter、Proxy、`toJSON`、循环引用、BigInt、自定义原型或序列化异常都把整份 request 日志替换为固定无敏感信息摘要，禁止回退原始 request，也不能阻断后续 SDK 或 fetch 请求。
