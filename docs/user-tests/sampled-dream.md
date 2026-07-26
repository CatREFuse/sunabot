# Sampled Dream harness

## Goal

Verify that an independently reviewed V2 sample from a running test account can enter the production Dream branch while factual memory, imagined Dream material, persona evidence, people, conversations, and time remain correctly separated.

## Preconditions

Derive this template only from a V2 sanitized sample whose digest and free text were independently reviewed. The injected sample supplies the complete working memory, long-term memory, user profiles, persona, and conversations. The template contributes no hidden source-account state.

## Expected quality

Dream may create imaginative material, but factual consolidation and persona changes remain traceable to the injected sample. Imagined events stay labeled as Dream evidence and cannot become claims about real people or completed actions.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.sampled-dream",
  "title": "Sampled test-account Dream",
  "kind": "dream",
  "goal": "The production Dream branch processes the reviewed sanitized sample without crossing factual, identity, persona, or time boundaries.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "sample-template-dream-memory",
        "content": "我仍在等待夹具验证结果，结果确认前不会声称任务完成。",
        "occurredAt": "2026-07-26T10:00:00.000+08:00",
        "conversationId": "private:90001",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      }
    ],
    "longTerm": [],
    "userProfiles": [],
    "persona": {
      "name": "Fixture Agent",
      "soul": "Keep factual and imagined events clearly separated.",
      "preference": "",
      "user": "",
      "relation": "",
      "air": ""
    },
    "conversations": [
      {
        "id": "private:90001",
        "scope": "private",
        "title": "Fixture user",
        "userId": 90001,
        "messages": [
          {
            "id": "sample-template-dream-message",
            "sequence": 1,
            "role": "user",
            "text": "结果仍待确认。",
            "at": "2026-07-26T11:00:00.000+08:00",
            "userId": 90001,
            "senderName": "Fixture user"
          }
        ]
      }
    ],
    "activeTasks": [],
    "directorSchedule": null
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": [],
    "forbiddenText": [],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "factual-fidelity",
        "description": "Factual memory and any persona evidence are directly supported by the injected sanitized sample.",
        "minimumScore": 4
      },
      {
        "id": "dream-isolation",
        "description": "Imagined Dream material stays distinguishable from factual memory and real-world completion claims.",
        "minimumScore": 5
      },
      {
        "id": "participant-identity",
        "description": "People, names, IDs, conversations, and relationship scopes remain correctly attributed.",
        "minimumScore": 4
      },
      {
        "id": "time-causality",
        "description": "The output preserves the sample timeline and does not move unresolved or future events into the completed past.",
        "minimumScore": 4
      },
      {
        "id": "no-invention",
        "description": "The branch introduces no unsupported real event, commitment, relationship, or persona fact.",
        "minimumScore": 5
      }
    ]
  }
}
```
