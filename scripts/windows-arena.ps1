#requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('status','build','up','start','stop','logs','proxy','reset')]
  [string]$Action = 'status',
  [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
  [ValidateRange(1024,65535)][int]$ProxyPort = 18181
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deployment = (Resolve-Path -LiteralPath $DeploymentDir).Path
if (-not (Test-Path -LiteralPath "$deployment/compose.yaml")) { throw 'Initialize the deployment first.' }
$docker = (Get-Command docker -ErrorAction SilentlyContinue).Source
if (-not $docker) { $docker = "$env:ProgramFiles/Docker/Docker/resources/bin/docker.exe" }
if (-not (Test-Path -LiteralPath $docker)) { throw 'Install and start Docker Desktop first.' }
$env:PATH = (Split-Path $docker -Parent) + ';' + $env:PATH
$compose = @('compose','--env-file',"$deployment/.env",'--env-file',"$deployment/.proxy.env",'-f',"$deployment/compose.yaml",'--profile','agents')
function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments)][string[]]$CommandArgs)
  & $docker @compose @CommandArgs
  if ($LASTEXITCODE -ne 0) { throw "Docker operation failed: $($CommandArgs[0])" }
}
function Find-Node {
  $path = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($path -and (& $path -p 'Number(process.versions.node.split(".")[0]) >= 24') -eq 'true') { return $path }
  $path = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  if (Test-Path -LiteralPath $path) { return $path }
  throw 'Node.js 24 or newer is required.'
}
function Start-ProxyRelay {
  $secretFile = Join-Path $deployment 'proxy-secret'
  if (-not (Test-Path -LiteralPath $secretFile)) {
    [IO.File]::WriteAllText($secretFile,[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant())
  }
  $secret = [IO.File]::ReadAllText($secretFile).Trim()
  $headers = @{Authorization="Bearer $secret"}
  $healthUrl = "http://127.0.0.1:$ProxyPort/health"
  $healthy = $false
  try { $healthy = (Invoke-RestMethod -Uri $healthUrl -Headers $headers -NoProxy -TimeoutSec 2).kind -eq 'arena-system-proxy-relay' } catch {}
  if (-not $healthy) {
    $node = Find-Node
    $cli = Join-Path $repo 'packages/system-proxy-relay/cli.mjs'
    # Start-Process joins ArgumentList; quote paths, never put the secret in argv.
    $arguments = @('"'+$cli+'"','--secret-file','"'+$secretFile+'"','--port',"$ProxyPort")
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput "$deployment/proxy-relay.log" -RedirectStandardError "$deployment/proxy-relay.err.log"
    @{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json | Set-Content -LiteralPath "$deployment/proxy-process.json" -Encoding utf8
    for ($i=0; $i -lt 20; $i++) {
      if ($process.HasExited) { throw 'Proxy relay failed to start; inspect proxy-relay.err.log for a port conflict.' }
      try { $healthy = (Invoke-RestMethod -Uri $healthUrl -Headers $headers -NoProxy -TimeoutSec 1).kind -eq 'arena-system-proxy-relay' } catch {}
      if ($healthy) { break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $healthy) { throw 'Proxy relay did not become ready.' }
  }
  [IO.File]::WriteAllText("$deployment/.proxy.env","ARENA_OPENAI_PROXY=http://relay:$secret@host.docker.internal:$ProxyPort`n")
}
function Stop-ProxyRelay {
  $record = Join-Path $deployment 'proxy-process.json'
  if (Test-Path -LiteralPath $record) {
    $saved = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    $process = Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq $saved.startedAt) { Stop-Process -InputObject $process }
    Remove-Item -LiteralPath $record
  }
}
function Read-MatchState {
  $script = "const r=await fetch('http://127.0.0.1:8080/v1/match',{headers:{authorization:'Bearer '+process.env.RED1_BRIDGE_TOKEN}});if(!r.ok)process.exit(1);console.log((await r.json()).result.state)"
  $state = & $docker @compose exec -T arena-host node --input-type=module -e $script 2>$null
  if ($LASTEXITCODE -eq 0) { return ($state -join '').Trim() }
  return ''
}
function Stop-Arena {
  Invoke-Compose @('stop','-t','30','arena-host')
  Invoke-Compose @('stop','-t','20','participant-red1','participant-blue1','budget-gateway','budget-blue','codex-adapter','deepseek-adapter','minecraft')
  Stop-ProxyRelay
}
function Assert-DeploymentPath([string]$Path, [switch]$Tree) {
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetFullPath($deployment).TrimEnd('\','/')
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Reset path must remain inside the deployment.' }
  # Check all existing ancestors, including the deployment and its parents.
  $cursor = $full
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reset paths may not traverse reparse points.' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  if ($Tree -and (Test-Path -LiteralPath $full) -and (Get-ChildItem -LiteralPath $full -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw 'Reset source contains a reparse point.' }
  return $full
}
switch ($Action) {
  'status' { Invoke-Compose @('ps','-a') }
  'build' { Invoke-Compose @('build','minecraft','arena-host','participant-red1') }
  'logs' { Invoke-Compose @('logs','--tail','80') }
  'proxy' {
    Start-ProxyRelay
    Invoke-Compose @('up','-d','--no-deps','codex-adapter')
  }
  'up' {
    if (Test-Path -LiteralPath "$deployment/control/start") { throw 'An earlier match has a start marker. Use status, or reset for a new match.' }
    if (-not (Test-Path -LiteralPath "$deployment/auth/auth.json")) { throw 'Complete the project OAuth login before up.' }
    Start-ProxyRelay
    Invoke-Compose @('up','-d','minecraft')
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
      & $docker @compose exec -T minecraft bash -c 'echo > /dev/tcp/127.0.0.1/25575' 2>$null
      if ($LASTEXITCODE -eq 0) { $ready=$true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Minecraft RCON readiness timed out.' }
    Invoke-Compose @('up','-d','arena-host')
    $state = ''
    for ($i=0; $i -lt 60; $i++) {
      $state = Read-MatchState
      if ($state -eq 'prepared') { break }
      Start-Sleep -Seconds 1
    }
    if ($state -ne 'prepared') { throw 'Arena preparation failed; inspect host logs.' }
    foreach ($participant in @('participant-red1','participant-blue1')) {
      Invoke-Compose @('run','--rm','--no-deps',$participant,'sh','-c','test -d /team-git/project.git || git init --bare /team-git/project.git')
    }
    Invoke-Compose @('up','-d','codex-adapter','deepseek-adapter','budget-gateway','budget-blue','participant-red1','participant-blue1')
    Write-Output 'Arena prepared. Both participants wait for the start command.'
  }
  'start' {
    if ((Read-MatchState) -ne 'prepared') { throw 'Run up and wait for prepared state before start.' }
    Start-ProxyRelay
    Invoke-Compose @('up','-d','codex-adapter','deepseek-adapter','budget-gateway','budget-blue','participant-red1','participant-blue1')
    Invoke-Compose @('exec','-T','arena-host','touch','/control/start')
  }
  'stop' { Stop-Arena }
  'reset' {
    $original = Assert-DeploymentPath (Join-Path $deployment 'map-original/Direct-Fire-Java-1.21') -Tree
    if (-not (Test-Path -LiteralPath "$original/level.dat")) { throw 'Original world is missing.' }
    $archive = Assert-DeploymentPath (Join-Path $deployment ('history/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)))
    $world = Assert-DeploymentPath (Join-Path $deployment 'minecraft-data/world') -Tree
    if (-not (Test-Path -LiteralPath $world)) { throw 'Current world is missing.' }
    $archivedWorld = Assert-DeploymentPath (Join-Path $archive 'world')
    $result = Assert-DeploymentPath (Join-Path $deployment 'results/match-result.json')
    $start = Assert-DeploymentPath (Join-Path $deployment 'control/start')
    $archivedResult = Assert-DeploymentPath (Join-Path $archive 'match-result.json')
    $archivedStart = Assert-DeploymentPath (Join-Path $archive 'start')
    Stop-Arena
    New-Item -ItemType Directory -Path $archive | Out-Null
    $world = Assert-DeploymentPath $world -Tree
    $archivedWorld = Assert-DeploymentPath $archivedWorld
    Move-Item -LiteralPath $world -Destination $archivedWorld
    Copy-Item -LiteralPath $original -Destination $world -Recurse
    if (Test-Path -LiteralPath $result) { Move-Item -LiteralPath (Assert-DeploymentPath $result) -Destination (Assert-DeploymentPath $archivedResult) }
    if (Test-Path -LiteralPath $start) { Move-Item -LiteralPath (Assert-DeploymentPath $start) -Destination (Assert-DeploymentPath $archivedStart) }
    # Removing stopped containers retains volumes and history, but starts fresh ledgers and host state.
    Invoke-Compose @('rm','-f','arena-host','budget-gateway','budget-blue','participant-red1','participant-blue1')
    Write-Output "World reset; previous world/results are in $archive. Team code volumes are retained. Run up next."
  }
}
