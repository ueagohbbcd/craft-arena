#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorldDir,
    # Match file for packages/arena/src/cli.mjs: arena:config plus phase commands.
    [Parameter(Mandatory)][string]$MatchConfig,
    # Map package: map.json agent slots plus the files they put into each
    # participant container (cli.mjs provision compiles it with the match file).
    [string]$MapDir = (Join-Path $PSScriptRoot '../infra/maps/race-of-wool'),
    [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
    # Compose project name and image tag of this deployment (default:
    # craft-arena-<DeploymentDir folder name>), so deployments run side by side
    # and a build never replaces another deployment's images.
    [string]$DeploymentName,
    [switch]$AcceptEula,
    [string]$ServerJar,
    [string]$ServerDownload = (Join-Path $PSScriptRoot '../infra/minecraft-download.json'),
    # Datapacks installed into the world; the default judges the race-of-wool monuments.
    [string[]]$Datapacks = @(Join-Path $PSScriptRoot '../infra/datapacks/race-of-wool'),
    # Each team's model relay forwards to one OpenAI-compatible base URL: an
    # official API, or a forwarder on this host (http://host.docker.internal:PORT/v1).
    [string]$RedModelUrl = 'https://api.openai.com/v1',
    [string]$BlueModelUrl = 'https://api.deepseek.com',
    # Names of environment variables holding each team's key (optional).
    [string]$RedModelKeyEnv = 'RED_MODEL_KEY',
    [string]$BlueModelKeyEnv = 'BLUE_MODEL_KEY'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/arena-paths.ps1"
if (-not $AcceptEula) { throw 'Pass -AcceptEula after reading https://www.minecraft.net/eula to accept the Minecraft EULA.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = Assert-ArenaPath $DeploymentDir
if (Test-Path -LiteralPath $destination) { throw 'DeploymentDir already exists; initialization never overwrites a deployment.' }
if (-not $DeploymentName) { $DeploymentName = ('craft-arena-' + ((Split-Path -Leaf $destination).ToLowerInvariant() -replace '[^a-z0-9_-]+','-')).Trim('-') }
# Valid both as a Compose project name and as an image tag.
if ($DeploymentName -cnotmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'DeploymentName must be lowercase letters, digits, - and _, starting with a letter or digit.' }
$world = Assert-ArenaPath $WorldDir -Tree
if (-not (Test-Path -LiteralPath (Join-Path $world 'level.dat') -PathType Leaf)) { throw 'WorldDir must be a prepared Minecraft world containing level.dat.' }
if ($destination.StartsWith($world.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'DeploymentDir must not be inside WorldDir.' }
$match = (Resolve-Path -LiteralPath $MatchConfig).Path
$map = (Resolve-Path -LiteralPath $MapDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $map 'map.json') -PathType Leaf)) { throw 'MapDir must contain map.json.' }
# Download schema and integrity are checked once by prepare-minecraft-server.mjs.
$download = Get-Content -LiteralPath $ServerDownload -Raw | ConvertFrom-Json
if ($download.minecraftVersion -ne '1.21.1') { throw 'The Compose template pins Minecraft 1.21.1; ServerDownload must match.' }
if ($ServerJar) { $ServerJar = (Resolve-Path -LiteralPath $ServerJar).Path }
$node = (Get-Command node -ErrorAction Stop).Source
if ((& $node -p 'Number(process.versions.node.split(".")[0]) >= 24') -ne 'true') { throw 'Node.js 24 or newer is required.' }
& $node (Join-Path $repo 'packages/arena/src/cli.mjs') check $match
if ($LASTEXITCODE -ne 0) { throw 'Match file is invalid (see above).' }
# Model settings go into .env as given; the relays forward without checking them.
$modelSettings = [ordered]@{ RED_MODEL_URL = $RedModelUrl; BLUE_MODEL_URL = $BlueModelUrl; RED_MODEL_KEY = [Environment]::GetEnvironmentVariable($RedModelKeyEnv); BLUE_MODEL_KEY = [Environment]::GetEnvironmentVariable($BlueModelKeyEnv) }
foreach ($name in @($modelSettings.Keys)) {
    if ($modelSettings[$name] -match '[\r\n\x00]') { throw "$name contains unsupported characters." }
}
# Assemble in a private sibling directory; Directory.Move refuses an existing destination.
$parent = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$stage = Join-Path $parent ('.arena-initialize-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($sid in @($currentUser, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, $propagation, $allow))
    }
    Set-Acl -LiteralPath $stage -AclObject $acl
    foreach ($dir in @('minecraft-data','map-original','results','replay-config')) { New-Item -ItemType Directory -Path (Join-Path $stage $dir) | Out-Null }
    $template = Join-Path $repo 'infra/windows-local'
    foreach ($file in @('compose.yaml','model.red.json','model.blue.json')) { Copy-Item -LiteralPath (Join-Path $template $file) -Destination $stage }
    # The operator's match file stays as match.source.json; provision writes
    # match.json (teams from the map), compose.agents.yaml and agents/.
    Copy-Item -LiteralPath $match -Destination (Join-Path $stage 'match.source.json')
    # Provision reads the original match file, so a model path it names is
    # relative to where the operator keeps it; default descriptors come from
    # the templates copied above.
    & $node (Join-Path $repo 'packages/arena/src/cli.mjs') provision $map $match $stage $stage
    if ($LASTEXITCODE -ne 0) { throw 'Provisioning the map failed (see above).' }
    # Each agent now has its own copy (agents/<id>/model.json); the templates
    # would only mislead later edits.
    foreach ($file in @('model.red.json','model.blue.json')) { Remove-Item -LiteralPath (Join-Path $stage $file) }
    $prepareArgs = @((Join-Path $repo 'scripts/prepare-minecraft-server.mjs'), (Join-Path $stage 'server'), '--manifest', $ServerDownload)
    if ($ServerJar) { $prepareArgs += @('--server-jar', $ServerJar) }
    & $node @prepareArgs
    if ($LASTEXITCODE -ne 0) { throw 'Checked Minecraft server preparation failed.' }
    Copy-Item -LiteralPath $world -Destination (Join-Path $stage 'map-original/world') -Recurse
    # Into the original world so every reset keeps the rules.
    $packDir = Join-Path $stage 'map-original/world/datapacks'
    New-Item -ItemType Directory -Force -Path $packDir | Out-Null
    foreach ($pack in $Datapacks) {
        $source = (Resolve-Path -LiteralPath $pack).Path
        if (-not (Test-Path -LiteralPath (Join-Path $source 'pack.mcmeta') -PathType Leaf)) { throw "Datapack $source has no pack.mcmeta." }
        $target = Join-Path $packDir (Split-Path -Leaf $source)
        if (Test-Path -LiteralPath $target) { throw "World already contains datapack $(Split-Path -Leaf $source)." }
        Copy-Item -LiteralPath $source -Destination $target -Recurse
    }
    Copy-Item -LiteralPath (Join-Path $stage 'map-original/world') -Destination (Join-Path $stage 'minecraft-data/world') -Recurse
    $envLines = [Collections.Generic.List[string]]::new()
    # Compose dotenv single quotes keep dollar signs and backslashes literally and
    # have no escape for a single quote, so a value containing one is refused.
    function Quote-DotEnv([string]$value) {
        if ($value.Contains("'")) { throw 'A value written to .env contains a single quote; set it in .env by hand.' }
        return "'" + $value + "'"
    }
    $envLines.Add('ARENA_SOURCE_DIR=' + (Quote-DotEnv $repo.Replace('\','/')))
    $envLines.Add("ARENA_DEPLOYMENT=$DeploymentName")
    $rcon = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $envLines.Add("MC_RCON_PASSWORD=$rcon")
    foreach ($name in $modelSettings.Keys) { if ($modelSettings[$name]) { $envLines.Add("$name=" + (Quote-DotEnv $modelSettings[$name])) } }
    [IO.File]::WriteAllLines((Join-Path $stage '.env'), $envLines)
    [IO.File]::WriteAllText((Join-Path $stage 'minecraft-data/eula.txt'), "eula=true`n")
    $properties = @('level-name=world','server-port=25565','enable-rcon=true','rcon.port=25575',"rcon.password=$rcon",'online-mode=false','enforce-secure-profile=false','spawn-protection=0','gamemode=survival','difficulty=normal','pvp=true','allow-flight=true','view-distance=8','simulation-distance=6','max-players=10','enable-command-block=false','motd=Craft Arena','max-tick-time=120000')
    [IO.File]::WriteAllLines((Join-Path $stage 'minecraft-data/server.properties'), $properties)
    $null = Assert-ArenaPath $stage -Root $parent -Tree
    [IO.Directory]::Move($stage, $destination)
} finally {
    if (Test-Path -LiteralPath $stage) {
        $null = Assert-ArenaPath $stage -Root $parent -Tree
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
Write-Output "Initialized deployment $DeploymentName at $destination. Review server.properties, match.json, agents/*/config, agents/*/model.json and the model settings in .env (RED_MODEL_URL, BLUE_MODEL_URL and optional RED_MODEL_KEY, BLUE_MODEL_KEY) before starting agents."
