# 非 primary 会话账号恢复

## 用户目标与环境

管理员群聊，Linux/WSL Native Core 与独立 NapCat。管理员打开一个历史非 primary 群聊，消息详情与发送者身份查询始终使用该群所属 QQ，不依赖 primary 在线。

## 输入与验证

隔离 SQLite 保存 `account:secondary:group:20002` 会话，省略历史 `accountId` 字段，保留已有消息、开关与消息计数。加载会话后核对账号为 secondary，原始数据库在只读加载时不发生修改；保存再加载应保留账号。额外验证显式账号不被改写，传统 `private:10001` 与 Web Chat 不被赋予 secondary 账号。通过管理台创建非 primary 会话开关记录时也必须保存从会话 ID 解析的账号。

## 预期工具与输出

无需模型工具或外部 Provider。后台消息与身份查询使用恢复后的账号上下文，不向 primary 查询阿罗娜的记录，不删除消息或改变会话开关。

## 质量标准与验收边界

以隔离数据库回归测试验证账号恢复、保留数据和无加载写回。生产验收检查后台补查错误及真实 NapCat 入站与 SQLite 消息时间；QQ Worker 的原生崩溃与停止收消息必须单独诊断，不能以本项通过宣称已根治。Provider harness 不覆盖旧会话加载，因此使用确定性 SQLite 回归。
