# Bash Resource Operations

Use these modules after reading `workbench-addressing.md`. They are command patterns, not extra permissions. Run them only through the Bash backend exposed in the current turn.

## Contents

1. Discover the active Workbench
2. Resolve a safe relative target
3. Validate JSON and JSONL
4. Compare and atomically replace
5. Manage task artifacts
6. Manage knowledge
7. Manage selfie references
8. Manage emoji
9. Maintain Skill source packages
10. Verify publication

## 1. Discover the active Workbench

Start every Bash operation with:

```bash
set -eu
umask 077
pwd -P
test -f index.md
sed -n '1,220p' index.md
```

Choose the authoritative resource root from the backend:

```bash
case "$(pwd -P)" in
  /workbench)
    resource_root="$(pwd -P)"
    other_resource_root="${SUNABOT_NATIVE_WORKBENCH:-/workbench/native-workbench}"
    resource_mode=writable
    ;;
  *)
    resource_root="$(pwd -P)"
    other_resource_root="${SUNABOT_DOCKER_WORKBENCH:?Docker Workbench path is unavailable}"
    resource_mode=writable
    ;;
esac
test -f "$resource_root/index.md"
```

Do not infer a host path from the Agent name. Both roots belong to the same Agent. In Docker, `other_resource_root` remains read-only even if a command proposes another path.

## 2. Resolve a safe relative target

Accept only a fixed resource directory plus a simple relative path:

```bash
relative_path='knowledge/topic.md'
case "$relative_path" in
  ''|/*|*\\*|.|..|../*|*/../*|*/..)
    echo "unsafe relative path" >&2
    exit 2
    ;;
esac
target="$resource_root/$relative_path"
test ! -L "$target"
test ! -e "$target" || test -f "$target"
```

Reject symbolic links in every parent segment, multiple hard links, devices, sockets, and files outside the current Agent. Keep generated temporary files in the same target directory.

## 3. Validate JSON and JSONL

Validate a JSON file before publication:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$candidate"
```

Validate one JSON value per non-empty JSONL line:

```bash
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n");
if (lines.at(-1) === "") lines.pop();
for (const [index, line] of lines.entries()) {
  if (!line) throw new Error(`empty JSONL line ${index + 1}`);
  JSON.parse(line);
}
' "$candidate"
```

Generic parsing does not prove a resource schema. Compare keys and limits with the current fixed entry and the resource-specific rules below.

## 4. Compare and atomically replace

Capture the current file identity before editing:

```bash
target="$resource_root/knowledge/topic.md"
before=missing
test ! -e "$target" || before="$(shasum -a 256 "$target" | awk '{print $1}')"
directory="$(dirname "$target")"
base="$(basename "$target")"
temporary="$directory/.${base}.tmp.$$"
trap 'rm -f -- "$temporary"' EXIT
```

Write and validate the complete candidate, then perform a compare-and-swap and same-directory rename:

```bash
printf '%s\n' 'complete new content' > "$temporary"
chmod 600 "$temporary"

current=missing
test ! -e "$target" || current="$(shasum -a 256 "$target" | awk '{print $1}')"
test "$current" = "$before" || {
  echo "revision conflict" >&2
  exit 3
}

node -e '
const fs = require("fs");
const fd = fs.openSync(process.argv[1], "r");
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
' "$temporary"
mv -f -- "$temporary" "$target"
trap - EXIT
node -e '
const fs = require("fs");
const fd = fs.openSync(process.argv[1], "r");
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
' "$directory"
shasum -a 256 "$target"
```

For JSON or JSONL, run the corresponding validator before `mv`. Preserve a previous file until the new candidate passes all checks. A conflict requires rereading the fixed entry and rebuilding from the latest state.

## 5. Manage task artifacts

Native Bash writes task artifacts in the authoritative Native cwd. Docker Bash writes them under `/workbench`; use Docker for downloads, conversion, archives, code, and other isolated processing.

To reuse a Native resource in Docker:

```bash
source_file="${SUNABOT_NATIVE_WORKBENCH:-/workbench/native-workbench}/path/from/index"
test -f "$source_file"
test ! -L "$source_file"
cp -- "$source_file" ./working-copy
```

Modify only the Docker copy. Use `send_file` for a final Docker artifact when the current conversation exposes it.

## 6. Manage knowledge

Read `knowledge/index.json`, then add or update only `.md`, `.markdown`, `.txt`, or line-oriented `.jsonl` source files under `knowledge/`. Use the atomic module above for every source write. Do not hand-edit `knowledge/index.json`; the knowledge service rebuilds it from source files.

After publication, call `knowledge_search` with a unique phrase from the document. A successful file write without search or index confirmation remains an unverified knowledge update.

## 7. Manage selfie references

Read `selfie/references.jsonl`. The authoritative directory holds at most nine regular image files, each no larger than 8 MiB, plus one JSONL record:

```json
{"schemaVersion":1,"id":"<64 lowercase hex SHA-256>","fileName":"<basename>","note":"<1-120 code point note>"}
```

For a verified local image, compute its digest, publish the image under a safe basename with the atomic module, then rebuild the complete JSONL candidate while preserving all existing records and administrator notes. Reject duplicate IDs, extra fields, empty lines, control characters, symbolic links, and a tenth record. Validate every referenced file before atomically replacing `references.jsonl`.

When the source exists only as a chat media handle, run `export_chat_media` first. Bash cannot dereference a media handle by itself.

## 8. Manage emoji

Read `emoji/emojis.jsonl`. Each line contains exactly:

```json
{
  "schemaVersion": 1,
  "key": "<normalized key>",
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "currentFileName": "emoji-<sha256>.png",
  "versions": [
    {
      "fileName": "emoji-<sha256>.png",
      "source": "upload",
      "sizeBytes": 123,
      "width": 1024,
      "height": 1024,
      "createdAt": "<ISO timestamp>"
    }
  ]
}
```

The filename extension may be `.png` or `.gif`; the basename digest must match the actual bytes. A stored asset must be a single-link regular file, at most 16 MiB, and decode as 1024×1024. The catalog allows at most 64 unique keys, 20 unique versions per key, and no unknown fields. The 2 MiB limit applies only to `emojis.jsonl` itself. Do not add the byte sizes of referenced emoji images together or use that sum as a catalog-wide gate. Preserve the original `createdAt`, set `updatedAt` for a changed key, put the new version in `versions`, and point `currentFileName` at it.

Use Bash directly when the source is already a validated local PNG/GIF and the active root is writable. Build the complete candidate JSONL, validate every line and referenced asset, compare the old catalog digest, then atomically replace `emojis.jsonl` and read it back.

Use `import_chat_emoji` when the source is a current chat media handle, requires JPEG/WebP normalization, or the conversation has only Docker Bash. The tool writes Native in private chat and Docker in group chat.

## 9. Maintain Skill source packages

Read `skills/index.json`, activate the relevant Skill when needed, and read its declared resources before editing. Use Bash to create or maintain a source package with `SKILL.md` at its root, safe relative files, valid frontmatter, and no links or special files. Run the package's declared validation, then compute a reproducible archive and SHA-256.

Editing published package bytes changes the package digest. Do not patch `digestSha256`, `reviewedDigestSha256`, `approval`, `enabled`, or `revision` by hand. Submit the Bash-authored source package through the Skill repository for install or replacement, independent review, CAS publication, and enablement. A package copied into `skills/` without a matching reviewed index record is source material, not an active Skill.

## 10. Verify publication

Finish with all applicable evidence:

- final relative path under the current Agent;
- SHA-256 and byte count;
- fixed entry reread after publication;
- content-specific checks such as image dimensions or JSONL schema;
- consumer readback through emoji selection, selfie selection, Skill catalog, or `knowledge_search`;
- exact backend used and whether the result is authoritative or a Docker task artifact.

Do not report success from a temporary file, copied Docker artifact, stale index, or command exit code alone.
