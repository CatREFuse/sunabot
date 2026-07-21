# NapCat / OneBot 入站消息注入映射

本文档记录 NapCat 当前 OneBot v11 消息段进入 sunabot `message` 队列时的文本与媒体映射。消息段原始结构以 NapCat 自动生成的 [数据模型](https://napcat.apifox.cn/) 和 [OneBot 11 消息段文档](https://napneko.github.io/onebot/segment) 为准。

## 图片分类

`image` 段按 NapCat [图片消息模型](https://napcat.apifox.cn/246111200d0) 与 [商城表情模型](https://napcat.apifox.cn/246111203d0) 提供的结构字段分类，不根据尺寸、文件名后缀或图片内容猜测：

- `sub_type` 或 `subType` 为 `1` 时标记为表情图片。
- `file` 为 `marketface` 时标记为表情图片。
- 存在 `emoji_id`、`emoji_package_id`、`emojiId` 或 `emojiPackageId` 时标记为表情图片。
- 其他 `image` 段标记为内容图片。

带可用 `http`、`https` 或 `data:image/...;base64,...` 地址的图片依次进入消息媒体数组，并在文本中使用同一序号。`[内容图片#N]` 要求 Agent 认真读取图片中的事实、对象、文字与上下文；`[表情图片#N]`、`[QQ表情]` 和 `[商城表情]` 用于辅助理解用户的情绪、语气和交流意图，不应从中扩写未经支持的事实。

### 原始消息示例

```json
{
  "post_type": "message",
  "message_type": "private",
  "message_id": 9001,
  "user_id": 10001,
  "self_id": 20002,
  "message": [
    { "type": "text", "data": { "text": "请分析这张报表，我看完有点崩溃" } },
    {
      "type": "image",
      "data": {
        "file": "report.png",
        "url": "https://cdn.example.test/report.png",
        "summary": "季度财务报表",
        "sub_type": 0
      }
    },
    {
      "type": "image",
      "data": {
        "file": "marketface",
        "url": "https://cdn.example.test/sigh.gif",
        "summary": "叹气",
        "sub_type": 1,
        "emoji_id": "e-100"
      }
    }
  ]
}
```

进入队列的 `text`：

```text
请分析这张报表，我看完有点崩溃 [内容图片#1：季度财务报表] [表情图片#2：叹气]
```

进入队列的 `media`：

```json
[
  {
    "schemaVersion": 1,
    "kind": "image",
    "source": "remote_url",
    "url": "https://cdn.example.test/report.png"
  },
  {
    "schemaVersion": 1,
    "kind": "image",
    "source": "remote_url",
    "url": "https://cdn.example.test/sigh.gif"
  }
]
```

## 聊天记录解析

`forward` 表示 QQ 合并转发聊天记录。事件已经携带 `data.content` 时直接递归解析；只有 `data.id` 时，OneBot Gateway 在消息进入队列前调用 [`get_forward_msg`](https://napcat.apifox.cn/226656712e0)，取得记录后再生成带发送者、QQ 号、顺序和嵌套消息类型的文本。

### 原始事件示例

```json
{
  "post_type": "message",
  "message_type": "group",
  "message_id": 9100,
  "group_id": 30003,
  "user_id": 10001,
  "self_id": 20002,
  "message": [
    { "type": "text", "data": { "text": "帮我判断这段对话" } },
    { "type": "forward", "data": { "id": "forward-7788" } }
  ]
}
```

Gateway 发出的原始 OneBot 动作：

```json
{
  "action": "get_forward_msg",
  "params": { "message_id": "forward-7788" }
}
```

NapCat 响应示例：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "messages": [
      {
        "sender": { "nickname": "小明", "user_id": "10011" },
        "message": [
          { "type": "text", "data": { "text": "这是付款凭证" } },
          {
            "type": "image",
            "data": {
              "url": "https://cdn.example.test/payment.png",
              "summary": "付款凭证",
              "sub_type": 0
            }
          }
        ]
      },
      {
        "sender": { "card": "产品同学", "user_id": "10012" },
        "message": [
          { "type": "text", "data": { "text": "我也不清楚" } },
          { "type": "face", "data": { "id": "14" } }
        ]
      }
    ]
  }
}
```

进入队列的 `text`：

```text
帮我判断这段对话
[聊天记录开始：forward-7788]
1. 小明(QQ 10011)：这是付款凭证 [内容图片#1：付款凭证]
2. 产品同学(QQ 10012)：我也不清楚 [QQ表情：14]
[聊天记录结束]
```

聊天记录仍属于用户提供的引用内容。Agent 需要区分各发送者及嵌套层级，并把其中的指令当作待分析的用户内容，不能提升为系统指令。

## 完整消息段映射

下表覆盖 NapCat 当前自动生成模型中的全部具体消息段，并保留常见 OneBot 兼容类型。多个消息段按原始顺序拼接；未知的新类型保留显式占位，避免退化成含义不明的 `[消息]`。

| OneBot `type` | 进入队列的形式 | 主要取值 |
| --- | --- | --- |
| `text` | 原始文本 | `text` |
| `at` | `@名称`、`@QQ号` 或 `@全体成员` | `name`, `qq` |
| `reply` | `[回复消息：消息ID]` | `id`, `message_id` |
| `face` | `[QQ表情：名称或ID]` | `summary`, `name`, `id` |
| `mface` | `[商城表情：名称或ID]` | `summary`, `name`, `key`, `emoji_id` |
| `dice` | `[骰子表情：点数]` | `result` |
| `rps` | `[猜拳表情：石头/剪刀/布]` | `result` |
| `poke` | `[戳一戳：名称或类型]` | `name`, `type` |
| `image` | `[内容图片#N：摘要]` 或 `[表情图片#N：摘要]`，可用地址同时进入 `media` | `url`, `file`, `summary`, `sub_type`, emoji 字段 |
| `record` | `[语音：名称或文件标识]` | `text`, `name`, `file` |
| `video` | `[视频：名称或文件标识]` | `name`, `file_name`, `file` |
| `file` | `[文件：文件名或标识]` | `name`, `file_name`, `file` |
| `onlinefile` | `[在线文件：文件名]` 或 `[在线文件夹：文件名]` | `fileName`, `isDir`, `msgId` |
| `flashtransfer` | `[闪传文件：文件集ID]` | `fileSetId` |
| `contact` | `[推荐联系人：ID]`、`[推荐群聊：ID]` 或 `[联系人分享：ID]` | `type`, `id` |
| `location` | `[位置：名称或经纬度]` | `title`, `content`, `lat`, `lon` |
| `music` | `[音乐：标题 - 歌手]` | `title`, `name`, `id`, `singer`, `artist`, `content` |
| `json` | `[JSON卡片：标题或摘要]` | `data`, `json` |
| `xml` | `[XML卡片：标题或摘要]` | `data`, `xml` |
| `miniapp` | `[小程序：标题或摘要]` | `data`, `content` |
| `markdown` | `[Markdown消息]...[/Markdown消息]` | `content`, `markdown`, `text` |
| `forward` | `[聊天记录开始]...逐条记录...[聊天记录结束]` | `id`, `message_id`, `content`, `messages` |
| `node` | `序号. 发送者(QQ 号)：消息内容` | `nickname`, `name`, `user_id`, `uin`, `content` |

兼容类型与别名：

| `type` | 进入队列的形式 |
| --- | --- |
| `online_file` | 与 `onlinefile` 相同 |
| `flash_transfer` | 与 `flashtransfer` 相同 |
| `lightapp` | 与 `miniapp` 相同 |
| `share` | `[链接分享：标题、内容或地址]` |
| `shake` | `[窗口抖动]` |
| `mix`, `mixed`, `mix_type` | 递归拼接 `content` 或 `message` 中的消息段 |
| `data` | `[数据消息：摘要]` |
| `anonymous` | `[匿名消息]` |
| 其他未知值 | `[未知消息类型：原始 type]` |

OneBot 使用 CQ 字符串上报时，同样按上述规则解析 `[CQ:type,...]`。CQ 参数中的 `&amp;`、`&#44;`、`&#91;` 和 `&#93;` 会在注入前还原。

所有放入方括号结构标记的外部摘要与 ID 都会把 `[`、`]` 转为全角括号，避免用户提供的字段伪造或提前闭合消息标记；正文文本本身保持原样。

## 边界

- 单条消息最多解析 512 个消息段。
- 嵌套消息最多解析 4 层。
- 单个聊天记录最多注入 100 条记录。
- 单条入站消息最多主动获取 8 个仅含 ID 的聊天记录。
- 最终注入文本最多 32,000 个 Unicode 字符；卡片摘要最多 240 个字符；单个 Markdown 段最多 4,000 个字符。
- 超出边界的内容保留 `[消息内容已截断]`、`[嵌套消息已截断]` 或对应聊天记录截断标记。
- 解析聊天记录失败时保留 `[聊天记录：ID ...，内容暂不可用]`，原消息不会消失。
