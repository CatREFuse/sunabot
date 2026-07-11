# Runtime tooling

QQ Runtime 的稳定入口：

- `validate-contract.mjs`：校验 runtime contract、component lock、Dockerfile 和单 service Compose 不变量。
- `qq-compose.mjs`：从任意 cwd 启动单容器 Docker runtime。
- `configure-napcat-client.mjs`：把固定回环 OneBot v11 客户端写入 `runtime/napcat/config`。
- `doctor.mjs`：检查唯一实例、端口和 workspace 身份。
- `build-release.mjs`：生成带 checksum 的 Native API/Web artifact。
- `export-napcat-component.mjs`：从已验证的单容器镜像导出带 checksum 的 Native NapCat 组件。
- `native.mjs`：安装、升级、回滚、启停、诊断和卸载 Native runtime。

这些工具均从自身位置解析代码根，生产数据根只接受显式 `SUNABOT_WORKSPACE` 或 runtime contract 固定路径。
