$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Distro = if ($env:SUNABOT_SYNC_WSL_DISTRO) { $env:SUNABOT_SYNC_WSL_DISTRO } else { "Ubuntu-22.04" }
$WslProject = if ($env:SUNABOT_SYNC_WSL_PROJECT) { $env:SUNABOT_SYNC_WSL_PROJECT } else { "/srv/sunabot" }

& wsl.exe -d $Distro --cd $WslProject node scripts/sync-workspace.mjs push
if ($LASTEXITCODE -ne 0) {
  throw "sunabot WSL workspace sync failed with exit code $LASTEXITCODE"
}
