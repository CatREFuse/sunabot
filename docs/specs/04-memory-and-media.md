# 记忆、文件与图片

[返回当前系统规范索引](./index.md)

## 5. 记忆系统

### 5.1 数据边界

| 来源     | 内容                                                   | 主键和更新方式                                        |
| -------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 工作记忆 | 近期动作、变化、决定、进展、结果和待跟进事件           | 稳定 ID；完整集合替换；快照冲突保护                   |
| 长期记忆 | 对未来回复仍有价值的已发生或进行中事件                 | event key 与 fingerprint 合并；保留来源工作记忆 ID    |
| 用户画像 | 身份、能力、资源、偏好、习惯、边界、长期目标和明确称呼 | QQ 号聚合；画像中的明确称呼优先，管理员配置作为缺省值 |

一次性事件不能写入用户画像。人物属性不能写入长期记忆。工作记忆压缩、长期记忆晋升和用户画像更新在一个 SQLite 事务中提交，批次 ID 用于幂等重放。

三类记忆的 `fact` 正文统一采用当前 Agent 的第一视角，并显式参考 `SOUL.md`、`PREFERENCE.md`、`USER.md` 与 `RELATION.md`。`fact` 中的“我”始终是当前 Agent；用户自述中的“我”必须转换为角色对该用户的认知，不能保留成用户对自己的第一人称画像。正文直接描述事情怎样发生、角色有什么感受以及形成了什么看法、判断、担心、期待或打算，禁止出现“我记得”或同义的回忆提示语；主观内容必须有聊天事实、既有关系或角色人格依据，不能虚构强烈情绪。

记忆正文只保留少量概括信息。完整工作记忆通常为 3—6 条、最多 8 条；每批通常只晋升 0—2 条最核心的长期事件；长期记忆整理结果通常为 3—8 条；每位用户仍只保留一条画像记录，正文通常只含 1—3 个最影响未来相处的稳定认知。即使每条信息本身清晰，也必须主动把语义相同、相近、重复、互为因果或属于同一事件不同阶段的内容压缩为一条，正文保留原因、先后变化和最新状态；事件合并以 `occurredAt` 保留最早起点、以 `occurredEndAt` 保留最新结果或结束时间，画像的 `time` 保留依据从早到晚的关系。已经结束且不再影响未来的小事应删除。

`fact` 正文不能使用列表、字段标签、分类标题、来源说明、压缩说明或 `事实：`、`情绪：`、`认知：`、`相关用户：` 等模板化前缀。每个相关用户都必须在自然叙述中以“当前昵称或显示名（QQ 号）”出现，QQ 号与对应昵称同时存在；`userName` 必须是非空且不等于 QQ 号的当前昵称或显示名，不能用回复称呼或 QQ 号兜底。用户画像的 QQ、显示名和回复称呼继续分别保存在 `userId`、`userName` 与 `addressName`，召回上下文同时带出 `userName` 与 `userId`。严格 JSON envelope、稳定 ID、来源边界、时间字段、事件键、来源工作记忆 ID 和事务语义保持不变。

运行时只信任当前会话消息中实际观测到的昵称；Provider 返回的 `userName` 不能在缺少观测昵称时充当兜底。Provider 输出若把用户自述保留成角色记忆、使用回忆提示语、包含非法 QQ、缺少可信昵称或没有把昵称与 QQ 成对写入正文，该条事实必须失败关闭，不能进入工作记忆、长期记忆或用户画像；带引号或无引号的用户直接自述同样失败关闭，同一 QQ 在正文出现多次时每个标记都必须紧邻该 QQ 的受信昵称，额外 QQ 或真假昵称混用不能由一处正确配对掩盖。已有工作记忆非空时也不能借由非法输出清空旧快照。当前实时长期记忆由 `memory.compress-in` 的受控晋升结果在同一事务中提交；`memory.compress-out` 保留为可编辑提示词目录和旧模板迁移兼容入口，不额外触发一轮实时 Provider 调用。

既有记忆按同一正文和压缩标准一次性重整。清洗结果必须拒绝“我记得”及同义中英文回忆提示语、三类来源中的用户自述式第一人称、前置或后置的用户第一人称直接引语、缺失或伪造为 QQ 号的昵称、正文中未成对出现的昵称与 QQ，以及没有覆盖全部证据时间的事件合并；多人事实中的每个 QQ 及同一 QQ 的每次出现都必须与该证据行提供的受信昵称精确对应，正文不能增加未列入最终身份集合的 QQ，也不能由提案顺序或任意括号前缀代替。缺失昵称只能通过显式受校验的 `metadataPatch.userName` 修复，事件时间只能由证据确定性聚合，不能由提案任意改写或通过 `preserveFromBase` 覆盖。旧 signed 提案或计划不满足新合同不得继续安装，`staged-ready` 与 `installing` 在首次或下一次目录替换前都必须重读当前 plan/proposal 并失败关闭，随后重新生成、签名并刷新。维护操作必须在 Core 完全停止后创建覆盖默认 Agent 与全部其他 Agent 业务库、队列库的可恢复备份并完成校验；参数化事务只在由该恢复点创建的完整 staging 副本中替换 `memory_records`，生产侧通过可重入 data 目录 journal 安装已全量验证的数据库集合，不能修改会话、队列、请求日志或其他业务表。重整后必须核对每个 Agent、每类来源的前后数量、样本、完整 row shape、`integrity_check`、queue 不变量和恢复能力。

### 5.2 调度

记忆调度器按会话保存待处理消息、当前批次、失败次数和自上次尝试后新增的消息数。消息窗口由 `bot.memory.messageThreshold` 控制，默认值为 48，可通过管理台“记忆处理”的“压缩阈值”热更新；阈值变化后运行时必须立即按新值重新检查已排队消息。每累计一个完整消息窗口获得一次压缩尝试，不因静默时间触发不足窗口的部分批次，也不按时间自动重试失败批次。失败批次保留原消息，下一组完整窗口到达后才允许再次尝试；服务重启不额外增加尝试额度。已提交游标之前的消息不能重复入队。

`user_group` 与 `bot_group` 只把实际发送并成功落入会话记录的 Bot `assistant` 消息作为记忆锚点。调度器在按序排列的可见、可记忆消息流中，选取每个锚点自身、锚点之前至多 20 条和之后至多 20 条消息的并集；第 21 条不进入候选，重叠窗口按稳定消息标识去重。锚点后的消息在到达时逐条补入 20 条范围，没有锚点或位于全部锚点窗口外的群聊消息不进入待处理队列，也不增加压缩或失败重试额度。`private` 仍处理全部可记忆消息；`bot.memory.messageThreshold` 的完整窗口规则作用于筛选后的群聊候选，因此单个完整锚点窗口最多 41 条，在默认阈值 48 下需要等待后续锚点窗口继续累计。

升级后的旧群聊调度状态只有在调用方显式声明输入为完整 retained history 时，才能在允许 claim 前按相同锚点规则原子重建并写入新选择策略；增量历史或缺少该声明时必须保持 legacy 未调和并禁止 claim。旧 `currentBatch` 内仍符合新规则的消息继续视为已经消费过尝试额度；未提交的 failed/running 批次清除旧 batch 与失败状态后，只有不属于旧 batch 的新候选才能增加重试额度，重启不能返还已消费额度。已提交批次只完成游标结算，不能再次调用记忆 Provider，已提交的历史记忆不回溯删除。调度器只额外保留最多 41 条有界群聊选择上下文，用于跨重启补齐未来 Bot 锚点之前和之后的消息，不把该上下文本身计入候选或触发额度。畸形选择上下文必须撤销当前策略并失败关闭，直至重新以完整历史调和；合法但超限、无序或重复的上下文在加载时确定性归一化为最近 41 条。

工作记忆与用户画像的 Provider 调用使用单次 120 秒传输预算，并由 135 秒外层总预算负责取消与清理，不在同一压缩额度内启动第二次传输。超时或失败继续沿用上述批次保留和完整窗口重试规则；内部超时调整不能增加压缩尝试额度、重复提交批次或触发静默时间重试。

### 5.3 召回

当前召回使用内存 BM25，在工作记忆、长期记忆和用户画像中搜索。返回结果包含来源、事件时间、用户身份和称呼信息。SQLite 负责持久化和有序读取，后续可在不改变调用接口的情况下增加 FTS 索引。

## 6. 文件与图片

### 6.1 QQ 文件

- 支持文本、代码、PDF、图片和常见 Office 文档。
- `.docx`、`.pptx`、`.xlsx`、`.odt`、`.odp` 与 `.ods` 正文由锁定的纯 Node `officeparser` 解析；同一解析器可通过 `npm run office:read -- <path> --to=text` 在 Bash 中直接使用，不依赖 GUI、桌面 Office、Python 或 Java。
- 旧版二进制 `.doc`、`.ppt` 与 `.xls` 不再通过外部 Office 套件转换，统一提示另存为现代格式；演示文稿保留分节正文和 `officeparser` AST 暴露的幻灯片数，不生成视觉页。图片页会计入页数；完全空白且未被解析器暴露为 slide 节点的页面可能少计，不使用可选元数据推测页数。PDF 与图片继续提供视觉上下文。
- 附件 artifact manifest 保持 `version: 1`，Office 解析结果另带 `parserRevision: 2`。缺少当前 revision 的既有 `.doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.odp/.ods` `ready` 或 `partial` 缓存必须重解析；PDF、图片和文本缓存不受 Office revision 影响。
- Office 正文解析在独立 Node worker 进程组中执行，默认最多并发 2 个任务、单任务 90 秒、V8 old-space 768 MiB、IPC 1 MiB、工作目录 1 GiB、进程组 RSS 1.5 GiB；任一上限命中后固定保留首个错误并按 TERM→KILL 有界终止整个进程组。工作目录与 RSS 探针各自独立收敛，单个或两个探针失败都不能提前解除另一资源门禁或总超时；探针 callback、进程组信号和 fallback signal 抛错必须被消费并进入有界 stderr，不能产生未处理 Promise rejection。
- 原文件按内容哈希进入附件缓存。
- 文本解析流式执行，单文件最多索引 20,000,000 字符。
- 文本分块保存在每个缓存项的 `chunks.sqlite`。
- 模型上下文按查询相关性选择文本块和视觉页，并执行字符数、页数和文件大小限制。
- 原始文件、视觉文件和缓存清单按 TTL 与引用计数回收。

### 6.2 图像生成

图像生成支持尺寸、1K/2K/4K 分辨率、质量、参考图压缩、重试和 OneBot 外发。`generate_img` 与 `selfie` 的全部生图参数及聊天参考图使用意图由模型填写；历史消息中的图片以 `message:<message-id>:image:<index>` 媒体句柄提供给模型，精确句柄优先于显式 URL 和来源回退。来源回退包含 `none`、`current`、`previous_output`、`history`、`current_and_history`；群聊中的自动历史只选择当前用户的媒体，精确句柄只能解析当前会话和当前捕获序列内的媒体。异步图片任务持久化 dispatch 时的媒体映射快照，旧任务没有快照时按原捕获序列重建。历史生成图的 `/generated-images/` 路径只允许生成图片根目录下的受控 PNG 文件，并在进入模型前转为规范化 Data URL。自拍始终使用当前 Agent 的角色参考图与 `selfie_prompt_rewrite.json`；primary Plana 在新建、缺失或空白文件及渲染回退时使用普拉娜专用改写模板，所有其他 Agent 在相同路径使用只依赖当前人格与角色参考图的通用模板。当前 Agent workspace 的 `selfie/` 是最多 9 张的带备注素材库，每张图片必须具有可编辑备注；节点先读取全部 `{id,note}` 元数据，再严格选择 1—3 张。`references.json` 与目录一致的正常路径只读取所选图片并保持节点返回顺序；缺少或不一致的旧目录先执行有界内容哈希兼容扫描，管理台读取后把确定性备注持久化为清单。聊天参考图最多额外保留 1 张，并紧接已选择的 1—3 张自拍素材追加为实际最后一项，不填充空槽位；单次生图总参考数仍不超过 4。节点空选、未知、重复或超量 ID 时不得截断、随机回退或继续生图。管理台可在图像页上传、预览、编辑备注和删除素材；列表只读取展示图和低清占位图，打开预览时才读取原图。生成文件保存在忽略的运行目录，图片历史元数据保存在主 SQLite 数据库。

出站媒体必须先通过生成图片根目录、直接子文件、PNG 文件名、常规文件和大小校验，再读取为 OneBot `base64://` 内联数据。Native Core 与 Docker Core 使用同一传输方式，NapCat 不读取 Core workspace，不接受共享绝对路径。超过 OneBot 内联预算的文件必须使用独立、鉴权、限流、可过期的传输协议；不能用容器路径或宿主路径作为降级。

每个 Agent 的表情图库最多保留 64 个 key，内置的 11 个预设 key 只作为管理台生成入口，不代表图片已经存在。key 必须先在原始 Unicode 上拒绝 C0/C1 控制字符、方括号、斜杠、反斜杠、replacement character 和孤立代理项，再执行 trim 与 NFC；结果要求 1—24 个 Unicode code point、最多 64 UTF-8 字节。上传只接受最大 8 MiB 的 PNG、JPEG 或 WebP；一键生成在调用 Provider 前必须取得当前 Agent 至少 1 张有效自拍参考图，最多使用 3 张，零张或不可读时返回可重试结果并保持 Provider、文件与数据库零写。上传与生图结果统一旋转、裁切并规范化为 1024×1024 内容寻址 PNG，文件名固定为 `emoji-<sha256>.png`，规范化文件最多 16 MiB；SQLite `emojis` 行保存 key、文件名、来源、字节数、尺寸和时间。

提示词 key 列表只执行 SQLite 字段、内容寻址文件名、普通非符号链接文件与记录字节数的廉价候选检查，不同步读取或哈希最多 64 张图片；未被本轮选中的损坏文件不能阻断回复。API 列表、内容读取和本轮实际命中的唯一资产使用最多并发 2、最多等待 2 的异步完整性门禁，以 `O_NOFOLLOW` 打开同一文件句柄，复验完整父目录身份、fstat、大小、PNG 结构、1024×1024 解码、流式 SHA-256 与读后身份；dev、ino、size、mtime、ctime 未变时复用有界缓存，指纹变化必须重验。无效记录在列表中隐藏，命中无效资产时在 durable outbox 前失败关闭；延迟 OneBot 投递再次核对内容寻址摘要。

生成门禁按 Agent 最多并行 2 个 key，同 key 在途返回 409，容量耗尽返回 429；上传与生成的规范化门禁按 Agent 最多并行 2 个且不排队，admission 必须早于上传 Base64 解析或生成文件读取，容量耗尽返回 429。409/429 均提供明确状态，429 携带 `Retry-After`，所有 slot 在成功或异常的 finally 中释放。目录创建与最终内容寻址文件发布使用 parent-bound 操作；父目录、最终目标或 worker 绑定后发生替换时，外部路径和 SQLite 都保持零写。

NapCat 上报的 QQ 文件优先通过 OneBot action 返回的受控 URL 进入 Core；统一启动器固定开启 `get_file` Base64 回退。仅返回 NapCat 容器内路径时不能由 Core 直接打开，也不能为兼容该路径而挂载业务 workspace；超过现有 action 预算的文件使用后续明确的流式协议。

### 6.3 Agent workbench 文本文件

每个 Agent 的 `workbench/` 是 `read_file`、`write_file` 与 Bash 共用的私有文件边界。文件工具只处理 well-formed UTF-16、NFC 规范化的 POSIX 相对路径，路径最长 1024 UTF-8 字节，单段最长 255 字节；绝对路径、反斜杠、空段、`.`、`..`、lone surrogate、NFD、C0/C1 控制字符、符号链接、非普通文件、多个硬链接和跨 Agent 路径全部拒绝。大小写与 Unicode replacement character 不折叠或替换。读取上限为 1 MiB，并另以 262,144 个 JavaScript 字符限制模型输出；UTF-8 使用 fatal decoder，文件开头的三字节 BOM 保留为正文首字符 `U+FEFF` 并计入 `byteLength`，无 BOM 正文不变。读取使用 `O_NOFOLLOW` 的同一描述符，在读前、读后及路径复验之间核对根目录、父链、设备、inode、ctime、mtime、大小和链接数，文件在检查后增长时最多读取上限加一个字节后拒绝。

`write_file` 不创建父目录，只能在已经存在且身份稳定的安全目录中发布完整文本。正文先拒绝 lone surrogate 并执行字符与 UTF-8 字节预算校验，不改变正文的 Unicode normalization form；随后写入同目录随机 0600 临时文件，循环写完并 fsync，再从同一描述符冻结设备、inode、ctime、mtime、大小、权限、链接数、SHA-256 与实际正文。`afterTempSynced` 和 `beforePublish` 检查点都位于最终复验之前；发布前重新以 `O_RDONLY | O_NOFOLLOW` 打开临时文件，用同一描述符有界读取并核对路径身份、完整冻结快照、摘要和正文。无覆盖创建通过硬链接发布保证目标不存在，覆盖通过同文件系统 rename 原子替换，随后再次 fsync 目录，并从目标描述符复验安全身份、摘要和正文。失败时清理自身临时路径，错误响应和请求日志只保留稳定错误码、相对路径及大小，不包含正文、宿主绝对路径或文件系统错误元数据。

五种 Provider 协议写入模型请求日志前，必须对日志副本执行 action-aware copy-on-write 投影，实际 SDK request 对象与 fetch JSON 字节保持不变。Responses、Codex Responses、Chat Completions、Anthropic Messages 与 Gemini generateContent 的 `read_file`/`write_file` call 参数只记录 canonical 相对路径或 `[invalid]`；写入参数另记录 `overwrite`、UTF-8 `contentByteLength` 与固定 `[REDACTED]`，不记录正文、额外字段、宿主路径或无密钥摘要。`read_file` result 只保留安全的 `ok`、路径、字节数和固定正文占位，无法解析的结果整块替换为固定占位；`write_file` result 不记录正文。投影只识别各协议真实 call/result lineage，普通 user 与 assistant 文本即使形似工具 JSON 也保持原文。日志入口必须先在不读取 accessor 的前提下生成 inert plain-data 副本；任一 getter、Proxy、`toJSON`、循环引用、BigInt、自定义原型或序列化异常都把整份 request 日志替换为固定无敏感信息摘要，禁止回退原始 request，也不能阻断后续 SDK 或 fetch 请求。

### 6.4 会话文件、图片与语音外发

`send_file` 只向管理员触发工具调用的当前单聊或群聊发送当前 Agent `workbench/` 中的文件，不接收 QQ 号、群号或账号参数。管理员可在私聊或群聊使用；普通私聊用户、普通群成员和伪造调用不能获得 Provider port，运行时 queue 必须在文件解析前再次拒绝并保持零 outbox。真实 OneBot parser 保留既有 `transport` 缺省值，只有显式 `web` transport 被拒绝；持久目标始终规范化为 `onebot`。调用保留当前 `account_id`，缺省账号必须冻结并传递为显式 `primary`，禁止 OneBot 回退到唯一 secondary socket；群聊不能转成私聊，单聊不能改投其他用户。durable path 统一使用 POSIX `/`，queue 与 decoder 均拒绝反斜杠、绝对路径、空段、`.`、`..`。发送前必须拒绝符号链接、多个硬链接、非常规文件、非法文件名和超过 32 MiB 内联预算的内容。helper 返回后立即冻结 workbench 的 canonical path、dev、ino 与高精度 ctime；outbox 只持久化不含路径的十进制 dev/ino/ctime 身份并纳入 fingerprint。delivery 构造、路径解析、descriptor open 和读取前后都必须确认根仍是同一常规目录，不能用后续 `realpath` 结果重新确定可信根；同机 SQLite 重启可继续投递，跨文件系统迁移、root inode 或 ctime 变化均安全拒绝并要求重新排队。写入 outbox 前还必须重新确认 helper 结果相对冻结根仍是安全相对路径。路径链预检后必须以 `O_RDONLY | O_NOFOLLOW` 打开文件描述符，以初始 `fstat.size` 分配有界 Buffer，循环读取不超过该大小并额外探测一字节；读取前后用 `fstat` 和当前路径的 dev、ino、大小复验，整个读取使用同一 FileHandle。根目录、叶子或中间目录发生替换，即使随后换回，或读取期间文件增长，都一律拒绝且不得生成 Base64。任何可识别且 `code` 匹配 `E*` 的 filesystem error，无论是否带 `path`、`dest`、`syscall` 或 `errno`，都必须转换为稳定的 `SEND_FILE_SOURCE_*` 或 `SEND_FILE_ROOT_CHANGED` 错误；仅在 message 中泄露绝对路径的错误，以及 FileHandle 的 open、read、close 错误，也执行相同归一化。工具输出、请求日志和 outbox 错误不能包含 Agent workspace、workbench 或宿主绝对路径。outbox 投递还要复验文件内容摘要，避免排队期间文件被替换。

`conversation_asset` 是无历史兼容负担的新 durable kind，只接受 `schemaVersion: 2` 的 `runtime.conversation_asset` envelope，未版本化裸 payload 一律拒绝。envelope、payload、target、asset、root identity 与 `replyGate` 全部使用 exact-key decoder，未知、缺失或非法字段在 workbench 读取前安全拒绝。`replyGate` 必须存在，`generation` 为有界非空值，`scope` 与 `conversationId` 必须匹配冻结入站目标，两个 epoch 必须是非负安全整数；缺失或非法时禁止捕获当前 gate 作为回退。payload 只保留严格目标、不可变 origin identity 的 SHA-256 fingerprint、文件元数据、根身份、tool/log 标识和 gate，不复制正文、sender、quote、inline data、shared file、附件路径、视觉路径或其他入站快照。origin fingerprint 只规范化 OneBot transport、目标、messageId、selfId 与 time，允许入站事件落盘后 preparation 补充 sender、引用、媒体和附件而不改变授权身份。投递在任何 workbench 读取前重新读取 canonical outbox，并要求 `sessionId`、`originTurnId`、`kind`、`deliveryPartition`、完整 payload 和 envelope 字段均和当前记录一致；origin turn/event 必须属于同一 session，来源只允许 `incoming_reply` 或 `tool_completion`，并从该权威事件重算 fingerprint、管理员权限、目标和 gate。

冻结目标绑定显式 `onebot` transport、当前 Agent、显式账号、scope、user/group、message、self 与 conversation。envelope 的 `conversationId` 必须同时等于 session 和冻结目标，`correlationId` 必须等于 `logRunId`，顶层 `idempotencyKey` 和 payload `incomingFingerprint` 都只使用版本化 canonical identity 的 SHA-256，不嵌入原始正文或 URL。普通 outbox dedupe key 使用 `turn-outbox:<originEventId>:<ordinal>:<fingerprint>`，fingerprint 覆盖完整 payload、目标、根身份以及 `path`、`kind`、`name`、`byteLength`、`sha256`。operator 明确 `confirmedNotSent` 后允许重放 `delivery_unknown` 资产，重放行固定使用 `outbox-replay:<previousId>:<fingerprint>`；同一层重复调用在 replay 为 pending、sending 或 sent 时都返回同一行，不能产生第二副本。若 replay 自身再次进入 `delivery_unknown`，delivery 必须逐层加载上一 canonical row，每层都要求上一行仍为 `delivery_unknown`、没有 uncertain settle step，并交叉验证 session、origin turn、kind、partition、完整 payload 与可复算 replay fingerprint。lineage 记录 visited ID、最多回溯 8 层，最终必须唯一落到 `turn-outbox` root，再使用 root 的 event、ordinal、fingerprint 与 origin turn/event 完成全部 provenance 校验。循环、过深、伪造 key、任一中间行状态或内容变化均保持零文件读取、零远端 action。远端已经成功进入 settle 阶段后仍执行 canonical provenance 校验，但不重新执行会随配置变化的管理员、sender 和 gate send-phase 门禁，使本地 settle 可在管理员配置变化后完成且远端保持 exactly once。

自动模式根据真实文件类型把图片作为 OneBot `image` 消息段发送，其余内容作为文件发送；显式图片模式必须识别为图片。群文件与私聊文件分别使用 `upload_group_file` 和 `upload_private_file`，图片使用当前会话对应的消息 action。Core 只向 NapCat 发送 `base64://` 内联数据，不传递 Agent workspace、Core 容器或宿主绝对路径。OneBot adapter 必须再次强制执行 32 MiB 原始字节上限，先由 metadata `byteLength` 得到唯一编码长度与 padding，再线性校验字符和末尾 padding bits；校验过程不得通过 `Buffer.from(encoded, "base64")` 分配第二份大体积 decode Buffer。

`send_voice_message` 使用当前 Agent 的 Voice Profile 与本地 MOSS-TTS-Nano 服务，把模型 Function Call 中的同源可读正文合成为 WAV，再作为独立 OneBot `record` 消息段发送。Voice Profile 只接受 `zh`、`en`、`ja` 三个语言槽位；每个槽位最多保存一份不超过 8 MiB 的受识别参考音频、对应参考台词、原始文件名、MIME、字节数、SHA-256、更新时间和可选 HTTPS 来源。启用 Profile 时默认语言必须已有参考音频；运行时合成前重新读取并复验普通非符号链接文件、大小、MIME 和 SHA-256，配置或文件漂移时失败关闭。参考音频只作为字节提交给合成服务，不能向模型、NapCat 或 OneBot 暴露 Agent 路径。

MOSS 客户端对同一服务地址保持单并发，固定提交 `cpu_threads=4`，请求文本最多 300 字符，参考音频最多 8 MiB，响应最多解码为 32 MiB 的有效 WAV；超时、HTTP、非法 JSON、非规范 Base64、超限或非 WAV 响应均不得写入 outbox。合法结果按 SHA-256 写入当前 Agent `workbench/.voice-cache/voice-<sha256>.wav`，随后复用 `conversation_asset` schema v2、当前冻结目标、origin fingerprint、reply gate、文件身份与内容摘要门禁；OneBot adapter 只接收复验后的 `base64://` 字节并映射为 `record`，不接收参考音频、Core 路径或 MOSS 输出路径。

同源文字和语音各自拥有独立的准备与 durable outbox 记录。普通正文或 `assistant_text` 与合成并行启动，完成准备的一项立即自然入队；任一失败不撤销另一项。deferred tool 的 acknowledgement 与任务先原子持久化，语音生成完成后通过绑定该 turn 的 deferred emitter 追加；如果合成更早完成，只等待 handoff 已提交后追加。durable outbox 只保证各记录自身的幂等、重试和恢复，文字与语音没有人为先后屏障，远端观察顺序取决于各自完成和队列状态。
