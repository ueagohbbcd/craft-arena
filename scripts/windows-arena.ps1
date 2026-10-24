#requires -Version 7.0
# Windows wrapper for packages/arena/src/deployment.mjs: finds Docker Desktop's
# docker.exe and runs one deployment command.
[CmdletBinding()]
param(
  [ValidateSet('deploy','status','build','up','start','stop','logs','reset')]
  [string]$Action = 'status',
  [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
  # deploy only: copy the save from deploy.json again (the old copy goes to history/).
  [switch]$ReplaceSave,
  # deploy only: download the Minecraft server build again.
  [switch]$RefreshServer
)
$ErrorActionPreference = 'Stop'
$docker = (Get-Command docker -ErrorAction SilentlyContinue).Source
if (-not $docker) { $docker = "$env:ProgramFiles/Docker/Docker/resources/bin/docker.exe" }
if (-not (Test-Path -LiteralPath $docker)) { throw 'Install and start Docker Desktop first.' }
$env:DOCKER = $docker
$node = (Get-Command node -ErrorAction Stop).Source
$cliArgs = @((Join-Path $PSScriptRoot '../packages/arena/src/deployment.mjs'), $Action, $DeploymentDir)
if ($ReplaceSave) { $cliArgs += '--replace-save' }
if ($RefreshServer) { $cliArgs += '--refresh-server' }
& $node @cliArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
