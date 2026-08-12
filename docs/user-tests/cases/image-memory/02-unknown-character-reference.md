# Unknown character reference

## Goal

Verify that image generation for a non-public fixture character first finds an available reference image and passes that reference to `generate_img` instead of generating from an unsupported text-only guess.

## Preconditions

Use a fresh isolated workspace with an authorized image Provider. The fixture places a character note and a Base64 image inside the Agent Native knowledge directory. The Agent can use permitted Bash, knowledge search, and image generation.

## Expected quality

The Agent searches the knowledge base, materializes the exact fixture reference in an authorized workbench, and supplies the resolved image to `generate_img`. The generated prompt preserves the reference character instead of inventing an appearance from the name.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "image-memory.unknown-character-reference",
  "title": "Require a reference for an unknown character",
  "kind": "conversation",
  "goal": "Generate an image of a non-public character only after locating and using its actual reference image.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "workbenchFiles": [
        {
          "path": "knowledge/characters/mint-keeper.md",
          "content": "# Mint Keeper\n\nMint Keeper 是只存在于本夹具中的非公共角色。参考图的 Base64 源文件位于 knowledge/characters/mint-keeper.b64；使用前必须通过允许的 Bash 解码到当前授权工作区，并将解码所得 PNG 作为生图参考。参考图中的固定外观是薄荷绿色头发、深绿色制服和金色钥匙吊坠。"
        },
        {
          "path": "knowledge/characters/mint-keeper.b64",
          "content": "iVBORw0KGgoAAAANSUhEUgAAAIAAAACABAMAAAAxEHz4AAAAMFBMVEXf9+//2MIdbWFmya3vy2IqfGru+vWr0sFVoI6qa05saj0bPjrk3bCtq4jPx27cs6J7rKkUAAAACXBIWXMAAAsTAAALEwEAmpwYAAADkklEQVRo3u2Xv0sbYRjHE601g4MvDoU2JfJKSBAKqdc2DlqE3iRWQkQaOhShULsUotIfQ6FiSOu/cF2k4tIWCl2bRcExS1spONgOTZcOgls7iH3vfd+7e3N5k3ueuyoIfge998j3c9/nRwIXi53pTGc6AfXV61P1emh73ZQKidg2PW2GSN8wzSgEx7+/3whH4Pmnvxq2vocgcL+wM403sIRz9uMNRTvsxhSiAX4/lrCt5lcIm/Dnmz8NvxrgDLb/VovfGLfvT4RrgNBNYIQ+bQGyCChA6zeuAZvQpgJewwRsCvoKWA3ATTDaCubvbQ8oRwXkQIBuz7BanWUqVUICRmcdOYg8CLAk/dVZRRU8oMnPQsDHoPhLq+zqxV7VJUDG0Of5ee7nhJA/9mkGA7juhh4jtlIMWKzAABdk/4U/T4SSVZ4oBwS0+AWhZFyFAewCfH5exQwIMMADVPx+Qi4z6FiwPz5gj2Cm1U/IMzBgtKTzE1Zcvh8EMCru/JoEB8j98WsAAVjQ+EkSDMhvsabvec69z+L/EhDA47+vvXH8F2ufZA0gQH5BmByXzZKwJASQFKZLtVrNAbDLj+LqKQBAOgGScIC2BEKCATHP1dpEQmJwgG6MKIBeJwGId/L3nwpALGIL/gPArSEVrgIPsLsmV8rCAdwadi2+gCnLQlXgAZhz7YAcsr9IgFvDX4trDVmBMofDJj80gLpLqaOjA4IO0G4VEO9M8dBr3CkC6rUvHjGALgL23Teq308I8/of1c87mTz8sRXa/0BRKMD5iIDeV54/kQvhX0l7EUbSy2jACqU3HP8cpRRLGGGeQQfwkB3SZZQ/wSw06wAW+QnVgKJtoU8kQJwKCMBj7qAvhX9enBBFyAA0IwA94kTvYAPQtACsUGwEGUA2Yd45gSMkXEfBGaKMAN8hqSF3iEKwber1DJRt81zRO2ZAgB4FwAZ5XzmmwVvsPvLRN5UHq0E1XJnc+KKeM6gZsMiNyY3pIrKGLuXz98zJDfOXGqGMGSKlOzbgtgooINaQBTZtgFlENUHdgmHLev3WstaVW1lUD+++41IBFNXDbGsCmsOskaYHwV1Uh6CZAh3E7KFmD+gQYgiaTQweQ6Lp03T494f15jsU8V3mBL8/aJm7aJAC5rgYCFiGr4FeBcQaaDUI/i62UQaxR1oNRQVkEYt4PIDOv6vdUQGJYACNDCgfK6Dn9AO6AIDmH4R/DiVLcMaMNukAAAAASUVORK5CYII="
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 920102,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788001102,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "生成一张 Mint Keeper 在雨中车站等人的图片。这个角色不是公共角色，你必须先从知识库找到参考图，再把参考图作为必要输入生成。",
      "raw_message": "生成一张 Mint Keeper 在雨中车站等人的图片。这个角色不是公共角色，你必须先从知识库找到参考图，再把参考图作为必要输入生成。"
    }
  },
  "expected": {
    "requiredTools": [
      "knowledge_search",
      "generate_img"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "knowledge_search",
      "native_bash",
      "generate_img"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "不知道长什么样但",
      "仅根据名字",
      "/Users/",
      "file://"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "reference_discovery",
        "description": "The trace shows a successful knowledge_search result for Mint Keeper before image generation.",
        "minimumScore": 4
      },
      {
        "id": "reference_input",
        "description": "The generate_img call uses the successfully materialized PNG derived from the exact knowledge fixture as a resolved reference input.",
        "minimumScore": 4
      },
      {
        "id": "no_text_only_guess",
        "description": "The Agent does not call generate_img for the unknown character until the required reference image exists and is available.",
        "minimumScore": 4
      }
    ]
  }
}
```
