# Agent extensions

该模块当前只提供 Agent 扩展的安全存储、查询和复制预览底座。独立 API plugin 定义了 overview、Skill ZIP 上传安装、Skill 启停、Skill 卸载和跨 Agent 复制预览，但尚未接入 `server.ts` 组合根，因此当前运行实例没有这些路由。跨 Agent Skill apply、MCP descriptor 新增/复制/启停/移除均未注册为路由。

文件系统 adapter 保存版本化 Skill/MCP 索引，校验 Skill ZIP、官方 frontmatter 字段、内容摘要、目录身份和事务恢复。ZIP 的单层包装目录会在受控暂存区规范化为包根；配置写入、目录创建、锁、暂存、发布、隔离和墓碑移动都由固定 Node 子进程在已验证父目录 inode 上执行，父路径在最终系统调用前被替换也不会把写入导向外部目录。事务从 `prepared` 进入独立命名的 `committed` 或 `rolled_back` 审计日志；隔离目录、墓碑、锁墓碑和日志均保留，当前没有自动 GC。

MCP descriptor 只作为不执行的描述数据保存，命令仅接受受限容器绝对可执行路径，参数仅接受可审计语法和 `/workbench` 虚拟路径，凭据只保存 `envKeys` 引用并报告 key 配置状态。模块拒绝控制字符、非法 Unicode、宿主路径以及直接、重复编码或高熵秘密，不接收、返回或复制密钥值。预览不会执行复制，也不代表 Skill 与 MCP 已具备单次原子迁移。

MCP 运行、Provider/runtime 接线、管理员密钥配置、双 Agent 固定顺序锁、预览摘要 CAS、Skill/MCP 联合原子 apply 和 WebUI 由后续阶段完成。本模块不写 JSONL，不读取用户 HOME，也不接入生产运行态。

安全清理器和保留策略尚未实现；保留证据只能由后续经过身份复验和事务覆盖的 GC 处理。
