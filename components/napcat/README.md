# NapCat component

NapCat/QQ 是 QQ Runtime 的外部依赖组件，不包含 Sunabot 业务代码。版本、镜像 digest、架构和许可证状态由 `components/component.lock.json` 管理。

OneBot v11 只在本机运行单元内使用固定回环反向 WebSocket；生成图片通过共享 workspace 的受控绝对路径交付。

