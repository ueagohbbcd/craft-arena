#requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('status','build','up','start','stop','logs','proxy','reset')]
  [string]$Action = 'status',
  [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
  [ValidateRange(1024,65535)][int]$ProxyPort = 18181
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/arena-paths.ps1"
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
  foreach ($candidate in (Get-Command node -All -CommandType Application -ErrorAction Stop)) {
    $path = $candidate.Source
    if ((& $path -p 'Number(process.versions.node.split(".")[0]) >= 24') -eq 'true') { return $path }
  }
  throw 'Node.js 24 or newer is required on PATH.'
}
function Get-ParticipantServices {
  $services = & $docker @compose config --services
  if ($LASTEXITCODE -ne 0) { throw 'Cannot discover Compose participant services.' }
  $participants = @($services | Where-Object { $_ -like 'participant-*' })
  if (-not $participants.Count) { throw 'No participant services in Compose configuration.' }
  return $participants
}
function Start-RuntimeSupervisor {
  $record = Join-Path $deployment 'runtime-supervisor-process.json'
  $statusPath = Join-Path $deployment 'runtime-supervisor.json'
  $runState = Get-Content -LiteralPath "$deployment/results/match-result.json" -Raw | ConvertFrom-Json
  if (Test-Path -LiteralPath $record) {
    $saved = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
    if ($existing -and $existing.StartTime.ToUniversalTime().Ticks -eq $saved.startedAt) {
      $status = if (Test-Path -LiteralPath $statusPath) { Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } else { $null }
      if ($status -and $status.runId -eq $runState.runId -and $status.state -eq 'watching') { return }
      Stop-Process -InputObject $existing
    }
  }
  $node = Find-Node
  $cli = Join-Path $repo 'scripts/supervise-participants.mjs'
  if (Test-Path -LiteralPath $statusPath) { Remove-Item -LiteralPath $statusPath }
  $arguments = @('"'+$cli+'"','"'+$deployment+'"','"'+$docker+'"')
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput "$deployment/runtime-supervisor.log" -RedirectStandardError "$deployment/runtime-supervisor.err.log"
  @{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json | Set-Content -LiteralPath $record -Encoding utf8
  for ($i=0; $i -lt 60; $i++) {
    if ($process.HasExited) { throw 'Runtime supervisor exited; inspect runtime-supervisor.err.log and runtime-supervisor.json.' }
    if (Test-Path -LiteralPath $statusPath) {
      $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
      if ($status.state -eq 'watching' -and $status.runId -eq $runState.runId) { return }
      if ($status.state -eq 'fault') { throw 'A participant runtime stopped before start; inspect runtime-supervisor.json.' }
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Runtime supervisor readiness timed out; inspect runtime-supervisor.err.log.'
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
    # Allow exactly the upstream hosts the gateways are configured to call.
    $hosts = foreach ($team in 'red','blue') { ([uri](Get-Content -LiteralPath (Join-Path $deployment "budget.$team.json") -Raw | ConvertFrom-Json).upstream.url).Host }
    $arguments = @('"'+$cli+'"','--secret-file','"'+$secretFile+'"','--port',"$ProxyPort",'--allow',(($hosts | Sort-Object -Unique) -join ','))
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
  $script = "const r=await fetch('http://127.0.0.1:8080/v1/session',{headers:{authorization:'Bearer '+process.env.RED1_BRIDGE_TOKEN}});if(!r.ok)process.exit(1);console.log((await r.json()).result.state)"
  $state = & $docker @compose exec -T arena-host node --input-type=module -e $script 2>$null
  if ($LASTEXITCODE -eq 0) { return ($state -join '').Trim() }
  return ''
}
function Stop-Arena {
  Invoke-Compose @('stop','arena-host')
  $services = & $docker @compose config --services
  if ($LASTEXITCODE -ne 0) { throw 'Cannot discover Compose services.' }
  Invoke-Compose (@('stop','-t','20') + @($services | Where-Object { $_ -notin @('arena-host','minecraft') }))
  $resultPath = Join-Path $deployment 'results/match-result.json'
  if (Test-Path -LiteralPath $resultPath) {
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($result.replay.startRequested -and $result.replay.status -ne 'saved') {
      throw 'Replay saving is unconfirmed. Minecraft remains running; inspect results and replay caches before stopping or resetting.'
    }
  }
  Invoke-Compose @('stop','minecraft')
  Stop-ProxyRelay
}
switch ($Action) {
  'status' { Invoke-Compose @('ps','-a') }
  'build' { Invoke-Compose @('build','minecraft','arena-host','participant-red1') }
  'logs' { Invoke-Compose @('logs','--tail','80') }
  'proxy' {
    Start-ProxyRelay
    Invoke-Compose @('up','-d','--no-deps','budget-red','budget-blue')
  }
  'up' {
    if (Test-Path -LiteralPath "$deployment/control/start") { throw 'An earlier match has a start marker. Use status, or reset for a new match.' }
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
    foreach ($participant in (Get-ParticipantServices)) {
      Invoke-Compose @('run','--rm','--no-deps',$participant,'sh','-c','test -d /team-git/project.git || git init --bare /team-git/project.git')
    }
    Invoke-Compose @('up','-d')
    Start-RuntimeSupervisor
    Write-Output 'Arena prepared. Participant runtimes are supervised and wait for the start command.'
  }
  'start' {
    if ((Read-MatchState) -ne 'prepared') { throw 'Run up and wait for prepared state before start.' }
    Start-RuntimeSupervisor
    Invoke-Compose @('exec','-T','arena-host','touch','/control/start')
  }
  'stop' { Stop-Arena }
  'reset' {
    $original = Assert-ArenaPath (Join-Path $deployment 'map-original/world') -Root $deployment -Tree
    if (-not (Test-Path -LiteralPath "$original/level.dat" -PathType Leaf)) { throw 'Original world is missing.' }
    $archiveId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $archive = Assert-ArenaPath (Join-Path $deployment "history/$archiveId") -Root $deployment
    $world = Assert-ArenaPath (Join-Path $deployment 'minecraft-data/world') -Root $deployment -Tree
    $result = Assert-ArenaPath (Join-Path $deployment 'results/match-result.json') -Root $deployment
    $start = Assert-ArenaPath (Join-Path $deployment 'control/start') -Root $deployment
    Stop-Arena
    foreach ($participant in (Get-ParticipantServices)) {
      Invoke-Compose @('run','--rm','--no-deps',$participant,'node','/opt/arena/scripts/archive-participant-state.mjs',$archiveId)
    }
    New-Item -ItemType Directory -Path $archive | Out-Null
    if (Test-Path -LiteralPath $world) { Move-Item -LiteralPath $world -Destination (Join-Path $archive 'world') }
    Copy-Item -LiteralPath $original -Destination $world -Recurse
    if (Test-Path -LiteralPath $result) { Move-Item -LiteralPath $result -Destination (Join-Path $archive 'match-result.json') }
    if (Test-Path -LiteralPath $start) { Move-Item -LiteralPath $start -Destination (Join-Path $archive 'start') }
    # Remove containers, not volumes: fresh host/ledgers, retained code and run archives.
    $services = & $docker @compose config --services
    if ($LASTEXITCODE -ne 0) { throw 'Cannot discover Compose services.' }
    Invoke-Compose (@('rm','-f','arena-host') + @($services | Where-Object { $_ -like 'participant-*' -or $_ -like 'budget-*' }))
    Write-Output "World reset; previous world/result/start marker are in $archive. Participant sessions and match-artifacts moved to .arena-history/$archiveId in each work volume. Code and team Git are retained. Run up next."
  }
}
