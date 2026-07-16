# Runtime smoke tests

这里验证真实运行时冒烟工具的安全闸门、密钥脱敏、NapCat client 隔离、容器可达 advertised host 限制和 OneBot action 回包校验。测试本身不访问模型，也不发送 QQ 消息。

```bash
npm run test:runtime-smoke
```
