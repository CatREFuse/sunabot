$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
& node (Join-Path $PSScriptRoot "sync-workspace.mjs") push
if ($LASTEXITCODE -ne 0) {
  throw "sunabot workspace sync failed with exit code $LASTEXITCODE"
}
