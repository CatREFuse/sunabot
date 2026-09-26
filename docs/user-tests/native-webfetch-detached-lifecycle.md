# Linux Renderer 启动后持续运行

用户目标：`./sunabot.sh up` 命令结束后，管理台、OneBot 和动态 WebFetch 仍可使用。

环境：Linux 或 WSL2 源码安装，Lightpanda、Bubblewrap 与默认 Provider 已配置；Core 和 NapCat 在启动前已停止。

输入：执行 `./sunabot.sh up`，等待命令退出，再从新的终端执行 `./sunabot.sh status` 和 `./sunabot.sh doctor`。

预期：Renderer 的 `127.0.0.1:8790` 仍在监听；`status` 报告 `Liveness: live` 和 `Readiness: ready`，`doctor` 的 `webfetch-dynamic-renderer` 为 `pass`。短时 Bubblewrap 隔离探针继续随启动器退出，长期运行的 Renderer 由已验证的进程组在 `down` 时停止。

拒绝条件：不得通过关闭 Bubblewrap 隔离、扩大监听地址或让启动器保持常驻来维持 Renderer 健康。
