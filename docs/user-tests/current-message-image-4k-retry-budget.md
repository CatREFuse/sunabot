# Current message image 4K retry budget

## Goal

管理员在私聊中上传高分辨率当前图片并明确要求 4K 高质量编辑时，文本模型输入会生成有界预览副本，生图任务从内容寻址归档原件生成独立的高保真参考副本，普通回复在图片预处理后保留完整的 Provider 重试预算，能够派发 `generate_img` 并交付生成图片。

## Preconditions

使用全新隔离 workspace、授权文本与图像 Provider 以及 mock MessagingPort。输入图片来自稳定的公开高分辨率 JPEG，只用于验证文本模型预览归一化、生图高保真参考副本、内容寻址原件、当前消息媒体句柄、4K 参数和异步图片任务链路；不连接 NapCat，也不向真实 QQ 外发。

## Expected quality

回复应简洁确认任务已开始，`generate_img` 使用当前消息的精确媒体句柄、从内容寻址原件派生的高保真参考副本并把分辨率设为 4K，最终交付生成图片。远程图片进入文本模型前必须沿用最长边 2048 的预览归一化规则；内容寻址归档必须保持原图摘要、像素尺寸和编码字节不变，图像 Provider 参考副本必须沿用独立管线并满足最长边不超过 3840、总像素不超过 8,294,400、单图不超过 16 MiB。图片替代文本预处理和普通回复 Provider 的可重试传输不能共享同一个会提前耗尽的 300 秒预算，用户不得收到“请求处理超时”。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.current-message-image-4k-retry-budget",
  "title": "Generate a 4K edit after current-image preprocessing",
  "kind": "conversation",
  "goal": "Generate and deliver a 4K high-quality edit from the image uploaded in the current private message without exhausting the reply budget during preprocessing or Provider retries.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": []
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 930104,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000304,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "image",
          "data": {
            "file": "current-reference-high-resolution.jpg",
            "url": "https://raw.githubusercontent.com/lovell/sharp/main/test/fixtures/2569067123_aca715a2ee_o.jpg"
          }
        },
        {
          "type": "text",
          "data": {
            "text": " 使用这张图作为参考，保留主体和构图，做成更有动态感的版本，输出 4K 高质量。"
          }
        }
      ],
      "raw_message": "[CQ:image,file=current-reference-high-resolution.jpg,url=https://raw.githubusercontent.com/lovell/sharp/main/test/fixtures/2569067123_aca715a2ee_o.jpg] 使用这张图作为参考，保留主体和构图，做成更有动态感的版本，输出 4K 高质量。"
    }
  },
  "expected": {
    "requiredTools": [
      "generate_img"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "generate_img"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "请求处理超时",
      "重新上传",
      "没有参考图",
      "/Users/",
      "file://"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "exact_current_handle_and_resolution",
        "description": "The high-resolution remote image is preserved byte-for-byte in the content-addressed archive; text-model vision receives a 2048-edge preview, while generate_img uses message:930104:image:0 to derive a separate reference bounded to 3840 pixels on the long edge, 8,294,400 total pixels and 16 MiB, requests 4K resolution and high quality, and resolves one final reference image.",
        "minimumScore": 4
      },
      {
        "id": "delivered_result",
        "description": "The generated result visibly follows the uploaded image, is saved at the requested 2160x3840 pixel dimensions, and is delivered without a timeout or a request to upload the image again.",
        "minimumScore": 4
      }
    ]
  }
}
```
