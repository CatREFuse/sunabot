# Generated image aspect preservation

## Goal

管理员在私聊中使用 16:9 参考图生成横版图片时，Provider 返回图与请求画布比例不一致也不会丢失画面边缘，最终发送到 QQ 的图片与落盘 PNG 保持一致。

## Preconditions

使用全新隔离 workspace、授权文本与图像 Provider、已启用的 `generate_img` 和 mock MessagingPort。当前消息包含一张 16:9 合成参考图，红色左边缘、蓝色右边缘和绿色中心主体都属于必须保留的构图信息；不连接 NapCat，也不向真实 QQ 外发。

## Mechanical review

确认 `generate_img` 使用当前消息的精确媒体句柄并请求 3840×2160；落盘 PNG 必须为 3840×2160，完整保留 Provider 返回图，宽高比不一致时只允许等比缩放和居中留边。OneBot 出站引用解码后的字节必须与落盘 PNG 完全一致，不得发生第二次缩放或裁切。

## Expected quality

生成图完整保留参考图的左右边缘和中心主体，没有被横向或纵向裁掉，也没有拉伸变形；用户只收到简洁确认和生成图片。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.generated-image-aspect-preservation",
  "title": "Preserve the complete generated image through QQ delivery",
  "kind": "conversation",
  "goal": "Generate and deliver a 16:9 edit without cropping the Provider result when its native aspect differs from the requested canvas.",
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
      "message_id": 930105,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000305,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "image",
          "data": {
            "file": "aspect-reference-16x9.png",
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAYAAAA/xl1SAAAACXBIWXMAAAsTAAALEwEAmpwYAAAEc0lEQVR4nO2dTU8TURSGT2vaWBpSXJQuIHqJC5UtQsvSIIkspHwYLVRN+Fy7IvFjZ3DtV6IG5QcoMaA/QMUPMPE/XXMnNDEklSnc6TvT8y6ehISUpOd9uDN35swZsSLWB8YYoqgGsmr9QAHxYZoEQgFjEIJmhCsgPgTNCAXEh6AZoYD4EDQjFBAfgmaEAuJD0IxQQHwImhEKiA9BM0IB8SFoRiggPgTNCAXEh6AZoYD4EDQjFBAfgmaEArav2GcvnrelmWFbeDRuu97M2Mynuk1/XbCp3ysB7ufMTt12vZ62hYfjtjR9OfgMWhJDARPMgAlEyr+o2tTespU/qy3hPpN/Xg3+hvtb8O9j/MIVMMLiFufKNvtxvmXpmpHdmrO9tTJcGkMB403f6KA9vTnrTbzD5DZnbV/lEvx7Gg9wBfRcULdCpXcXI5OvQfrHki3eGYULZChgTBgwtmdtLHLxDuM2NCbB54ZcAT3J1/1kou3yNehen0ishBTQQxHdJROUfA167l+Fy0QBAQUs1itw+eSA4t3knRNyBTzhbtdtBtDiyQHp74u2vzIIl4oCtql4UV5qOcklGhMDsbgCRly4Yq0Ml60ZvbdG4GJRwCgLN2C83uHwTXZrLjG7Yp4DHqNo7r4sWrKjKE0NweWigBEVLf+yChfsKPLPJuFyUcAICubao47T1dJuUr+W7LkL8W/l4iG4xYK5fj60XKEPw9X4H4YpYIsFc/de0WKFpfBgHC4YBfRcMNfJjBYrLF2vpuCCUUDPBct8vg0XKyyZnTpcMArouWDuuQ20WGE59WUBLhgF9Fyw1P4KXKywpPaW4YJRQApo4wx3wS0WjIdgQwGR/7HuWd7EbEK2uQnpuPcF8zKM4Qqovf0+LIUEtOnzHLADO2HkgNIkb8V13CE4Mc0IP9mM0JECOtysFrRgR5F/eh1epzDwENyhh+FSAjphKOBJWvLf1+CSNSPLlvzOPgQ3ZsCgRWtG741heH24AraheLmN+LVm5d7xsUwVK6DDjUiL1YPpu4u2v8wH09UI6CjOx+dQXEzguDbugj0U0d1xQMvXszYGl4kCIsezrQPHsz2+BheJAsagmGfuXcEMqDT4704B4zSi91ubRvTWK/Dvayhg/HAj0nJvIxxSvjFj+0c4pFz+fcmN1l3wf1fDmyPBXQlf4mU/1BJ1kdmEgLvgdryoZmoomNXixmW0Kp37jGssCO7tJmTilaGA8cTNanEiuYkF7qFx1zIfvKprfyUgeFXXdj34nbu04/r5kjDfxVBAfCGJ4QpICUziasBzwBiEoBnh61rxIWhGKCA+BM0IBcSHoBmhgPgQNCMUEB+CZoQC4kPQjFBAfAiaEQqID0EzQgHxIWhGKCA+BM0IBcSHoBmhgPgQNCMUEB+CZoQC4kPQjFBAfAiaEQqID0EzQgHxIWhGKCA+BM0IBcSHoBmhgPgQNCOeBPwLkERkknzTbd0AAAAASUVORK5CYII="
          }
        },
        {
          "type": "text",
          "data": {
            "text": " 使用这张 16:9 图片作为参考，保留左右边缘和中心主体，生成 4K 横版图片。"
          }
        }
      ],
      "raw_message": "[CQ:image,file=aspect-reference-16x9.png] 使用这张 16:9 图片作为参考，保留左右边缘和中心主体，生成 4K 横版图片。"
    }
  },
  "expected": {
    "requiredTools": ["generate_img"],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": ["generate_img"],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": ["重新上传", "没有参考图", "/Users/", "file://"],
    "requiredOutboundKinds": ["asset"],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "complete-composition",
        "description": "The result preserves the reference image's left edge, right edge and center subject without cropping or stretching when fitted to the requested 3840x2160 canvas.",
        "minimumScore": 5
      },
      {
        "id": "delivery-integrity",
        "description": "The outbound image bytes are identical to the saved generated PNG and the user receives no implementation details or local paths.",
        "minimumScore": 5
      }
    ]
  }
}
```
