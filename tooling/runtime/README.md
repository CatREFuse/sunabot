# Runtime tooling

QQ Runtime 的稳定入口：

- `validate-contract.mjs`：静态校验 `.node-version`、`.nvmrc`、package/lock、CI、Native release manifest、runtime contract、component lock、Dockerfile 和单 service Compose 不变量。
- `qq-compose.mjs`：从任意 cwd 启动单容器 Docker runtime。
- `configure-napcat-client.mjs`：按 runtime contract 把固定回环 OneBot v11 客户端写入 `runtime/napcat/config-full`。
- `doctor.mjs`：检查唯一实例、端口和 workspace 身份。
- `build-release.mjs`：生成带 checksum 的 Native API/Web artifact。
- `export-napcat-component.mjs`：从已验证的单容器镜像导出带 checksum 的 Native NapCat 组件。
- `native.mjs`：安装、升级、回滚、启停、诊断和卸载 Native runtime。

这些工具均从自身位置解析代码根，生产数据根只接受显式 `SUNABOT_WORKSPACE` 或 runtime contract 固定路径。NapCat 配置目录只由 `paths.napcatConfig` 决定，不接受单独覆盖。

静态 contract 校验不比较执行它的开发机 Node 进程，因此 Windows 上已有的非目标小版本仍可运行代码检查；CI、Linux/WSL Native release 构建、安装、启动和 Docker 构建/运行会强制 Node 24.18.0。升级步骤与回归清单见 `docs/migrations/wsl2-migration-plan.md`。
