# NapCat component

NapCat/QQ 是 QQ Runtime 的外部依赖组件，不包含 Sunabot 业务代码。版本、镜像 digest、QQ 版本、架构、smoke 命令和许可证状态由 `components/component.lock.json` 管理。

OneBot v11 只在本机运行单元内使用固定回环反向 WebSocket；生成图片通过共享 workspace 的受控绝对路径交付。

Dockerfile 使用锁定 digest 组合本机镜像；Native 组件只能由 `tooling/runtime/export-napcat-component.mjs` 从该镜像导出，不能从用户主目录复制未知安装。NapCat/QQ 许可证审查完成前，组合产物只用于本机自托管，不得发布。
