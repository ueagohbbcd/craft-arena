#requires -Version 7.0
[CmdletBinding()]
param(
  [ValidateSet('status','build','up','start','stop','logs','reset')]
  [string]$Action = 'status',
  [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy')
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/arena-paths.ps1"
$deployment = (Resolve-Path -LiteralPath $DeploymentDir).Path
if (-not (Test-Path -LiteralPath "$deployment/compose.yaml")) { throw 'Initialize the deployment first.' }
$docker = (Get-Command docker -ErrorAction SilentlyContinue).Source
if (-not $docker) { $docker = "$env:ProgramFiles/Docker/Docker/resources/bin/docker.exe" }
if (-not (Test-Path -LiteralPath $docker)) { throw 'Install and start Docker Desktop first.' }
$env:PATH = (Split-Path $docker -Parent) + ';' + $env:PATH
if (-not (Test-Path -LiteralPath "$deployment/compose.agents.yaml")) { throw 'compose.agents.yaml is missing: initialize the deployment again (cli.mjs provision generates it).' }
$compose = @('compose','--env-file',"$deployment/.env",'-f',"$deployment/compose.yaml",'-f',"$deployment/compose.agents.yaml",'--profile','agents')
function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments)][string[]]$CommandArgs)
  & $docker @compose @CommandArgs
  if ($LASTEXITCODE -ne 0) { throw "Docker operation failed: $($CommandArgs[0])" }
}
function Get-ParticipantServices {
  $services = & $docker @compose config --services
  if ($LASTEXITCODE -ne 0) { throw 'Cannot discover Compose participant services.' }
  $participants = @($services | Where-Object { $_ -like 'participant-*' })
  if (-not $participants.Count) { throw 'No participant services in Compose configuration.' }
  return $participants
}
# Runs packages/arena/src/cli.mjs against the server; returns its JSON output.
function Invoke-Arena {
  param([Parameter(ValueFromRemainingArguments)][string[]]$CommandArgs)
  $output = & $docker @compose --profile tools run --rm --no-deps -T arena @CommandArgs
  if ($LASTEXITCODE -ne 0) { throw "Arena command failed: $($CommandArgs[0])" }
  return (($output -join '') | ConvertFrom-Json)
}
function Read-SessionState {
  try { return (Invoke-Arena 'status').state } catch { return '' }
}
function Stop-Arena {
  # End the round first (best effort) so the datapack records the final scores.
  if ((Read-SessionState) -eq 'running') { $null = Invoke-Arena 'stop' '/config/match.json' }
  $services = & $docker @compose config --services
  if ($LASTEXITCODE -ne 0) { throw 'Cannot discover Compose services.' }
  Invoke-Compose (@('stop','-t','20') + @($services | Where-Object { $_ -ne 'minecraft' }))
  Invoke-Compose @('stop','minecraft')
}
switch ($Action) {
  'status' {
    Invoke-Compose @('ps','-a')
    $session = try { Invoke-Arena 'status' } catch { $null }
    if ($session) { $session | ConvertTo-Json -Depth 10 }
  }
  'build' {
    # The first bridge and participant carry the image builds.
    $services = @(& $docker @compose config --services)
    Invoke-Compose @('build','minecraft',@($services | Where-Object { $_ -like 'bridge-*' })[0],(Get-ParticipantServices)[0])
  }
  'logs' { Invoke-Compose @('logs','--tail','80') }
  'up' {
    Invoke-Compose @('up','-d','minecraft')
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
      & $docker @compose exec -T minecraft bash -c 'echo > /dev/tcp/127.0.0.1/25575' 2>$null
      if ($LASTEXITCODE -eq 0) { $ready=$true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Minecraft RCON readiness timed out.' }
    $bridges = @(& $docker @compose config --services | Where-Object { $_ -like 'bridge-*' })
    Invoke-Compose (@('up','-d') + $bridges)
    # #arena:prepare expects every player online.
    $players = @((Get-Content -LiteralPath "$deployment/match.json" -Raw | ConvertFrom-Json).config.teams | ForEach-Object { $_.players })
    $online = $false
    for ($i=0; $i -lt 60; $i++) {
      $list = (Invoke-Arena 'command' 'list').reply
      if (-not @($players | Where-Object { $list -notmatch "\b$_\b" }).Count) { $online=$true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $online) { throw 'Bots did not join the server; inspect bridge logs.' }
    $null = Invoke-Arena 'prepare' '/config/match.json'
    foreach ($participant in (Get-ParticipantServices)) {
      Invoke-Compose @('run','--rm','--no-deps',$participant,'sh','-c','test -d /team-git/project.git || git init --bare /team-git/project.git')
    }
    Invoke-Compose @('up','-d')
    Write-Output 'Arena prepared. Participants wait for the start command.'
  }
  'start' {
    if ((Read-SessionState) -ne 'waiting') { throw 'Run up and wait for the prepared (waiting) state before start.' }
    $null = Invoke-Arena 'start' '/config/match.json'
    Write-Output 'Match running. The datapack ends it at the time limit or on a win; status shows the session.'
  }
  'stop' { Stop-Arena }
  'reset' {
    $original = Assert-ArenaPath (Join-Path $deployment 'map-original/world') -Root $deployment -Tree
    if (-not (Test-Path -LiteralPath "$original/level.dat" -PathType Leaf)) { throw 'Original world is missing.' }
    $archiveId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $archive = Assert-ArenaPath (Join-Path $deployment "history/$archiveId") -Root $deployment
    $world = Assert-ArenaPath (Join-Path $deployment 'minecraft-data/world') -Root $deployment -Tree
    Stop-Arena
    foreach ($participant in (Get-ParticipantServices)) {
      Invoke-Compose @('run','--rm','--no-deps',$participant,'node','/opt/arena/scripts/archive-participant-state.mjs',$archiveId)
    }
    New-Item -ItemType Directory -Path $archive | Out-Null
    if (Test-Path -LiteralPath $world) { Move-Item -LiteralPath $world -Destination (Join-Path $archive 'world') }
    Copy-Item -LiteralPath $original -Destination $world -Recurse
    # Remove containers, not volumes: fresh bridges and relays, retained code and run archives.
    $services = & $docker @compose config --services
    if ($LASTEXITCODE -ne 0) { throw 'Cannot discover Compose services.' }
    Invoke-Compose (@('rm','-f') + @($services | Where-Object { $_ -like 'participant-*' -or $_ -like 'model-*' -or $_ -like 'bridge-*' }))
    Write-Output "World reset; the previous world is in $archive. Participant sessions and match-artifacts moved to .arena-history/$archiveId in each work volume. Code and team Git are retained. Run up next."
  }
}
