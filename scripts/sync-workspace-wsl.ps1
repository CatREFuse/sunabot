$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Distro = if ($env:SUNABOT_SYNC_WSL_DISTRO) { $env:SUNABOT_SYNC_WSL_DISTRO } else { "Ubuntu-22.04" }
$WslProject = if ($env:SUNABOT_SYNC_WSL_PROJECT) { $env:SUNABOT_SYNC_WSL_PROJECT } else { "/srv/sunabot" }

$WslExecutable = Join-Path $env:SystemRoot "System32\wsl.exe"
$process = Start-Process `
  -FilePath $WslExecutable `
  -ArgumentList @("-d", $Distro, "--cd", $WslProject, "node", "scripts/sync-workspace.mjs", "push") `
  -NoNewWindow `
  -Wait `
  -PassThru

if ($process.ExitCode -ne 0) {
  throw "sunabot WSL workspace sync failed with exit code $($process.ExitCode)"
}
