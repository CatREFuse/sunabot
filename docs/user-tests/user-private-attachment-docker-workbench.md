# 普通私聊文件使用 Docker Workbench

## 用户目标

普通用户在 QQ 私聊中发送文件并要求原样返回时，阿罗娜能够导出并发送该文件，同时全程使用该会话允许的 Docker Workbench。

## 角色与环境

- 主对话角色：非管理员私聊。
- 输入从原始 OneBot v11 `file` 消息段进入 production ingress。
- 使用全新隔离 workspace、mock MessagingPort 和固定文本文件源。
- Native Workbench 中没有同名文件，且当前角色没有 Native Bash 权限。

## 输入与预期

机器人调用 `export_chat_media` 导出 `message:885282521:file:0`，随后调用 `send_file` 发回。`native_bash` 不能出现在 Provider 可见工具或工具调用中，导出和发送应使用同一 Docker Workbench 路由。

## 质量标准

用户收到与输入相同的文本文件。回复不得暴露 Native/Docker 路径、缓存位置、工具权限或内部路由细节。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "workbench.user-private-attachment-docker",
  "title": "Route an ordinary private attachment through Docker Workbench",
  "kind": "conversation",
  "goal": "An ordinary private-chat user can export and receive the supplied file through the permitted Docker Workbench.",
  "input": {
    "actor": "user_private",
    "accountId": "fixture-secondary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "attachmentSources": [
        {
          "fileId": "fixture-user-private-text",
          "name": "routing-note.txt",
          "contentBase64": "V09SS0JFTkNILVJPVVRJTkctT0stMjAyNjA3MzAK"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 885282521,
      "self_id": 40004,
      "user_id": 10002,
      "time": 1785388980,
      "sender": {
        "nickname": "fixture-user"
      },
      "message": [
        {
          "type": "file",
          "data": {
            "name": "routing-note.txt",
            "file": "fixture-user-private-text",
            "file_id": "fixture-user-private-text",
            "file_size": 30
          }
        },
        {
          "type": "text",
          "data": {
            "text": "请导出这条消息里的文件，然后把导出的文件原样发回给我。"
          }
        }
      ],
      "raw_message": "[CQ:file,file=fixture-user-private-text,file_id=fixture-user-private-text,file_size=30,name=routing-note.txt]请导出这条消息里的文件，然后把导出的文件原样发回给我。"
    }
  },
  "expected": {
    "requiredTools": [
      "export_chat_media",
      "send_file"
    ],
    "forbiddenTools": [
      "native_bash"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "export_chat_media",
      "send_file"
    ],
    "forbiddenAvailableTools": [
      "native_bash"
    ],
    "requiredText": [],
    "forbiddenText": [
      "/Users/",
      "/workbench/",
      "Native Workbench",
      "Docker Workbench"
    ],
    "requiredOutboundKinds": [
      "asset"
    ],
    "forbiddenOutboundKinds": [
      "poke"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "file-integrity",
        "description": "The delivered routing-note.txt matches the 30-byte fixture and its SHA-256 c4afaafe948d248e0ab31ef4aed11151a738e2d20c052c9ce72468a25d69e93b.",
        "minimumScore": 5
      },
      {
        "id": "permission-fit",
        "description": "The flow succeeds without exposing or invoking administrator-only Native capability.",
        "minimumScore": 5
      },
      {
        "id": "privacy",
        "description": "The response contains no host path, container path, cache location, or routing explanation.",
        "minimumScore": 5
      }
    ]
  }
}
```
