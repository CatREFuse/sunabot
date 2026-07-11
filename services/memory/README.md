# Memory service

其他模块只从 `public.ts` 使用记忆能力。

- `domain/`：无 I/O 的规范化、事件合并、画像合并和公开条目映射。
- `application/`：CRUD、批次事务、查询和 repository 编排。
- `recall/`：保持现有语义的 BM25 召回与 Prompt 格式化。
- `adapters/`：Agent 文件和旧 JSONL 读取兼容层。
- `persistence.ts`：repository port 与组合根注入点。
- `memoryService.ts`：旧深层 import 的临时兼容入口，不承载业务逻辑。
