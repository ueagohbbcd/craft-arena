#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WorldDir,
    [Parameter(Mandatory)][string]$MatchConfig,
    [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
    [switch]$AcceptEula,
    [string]$ServerJar,
    [string]$ServerDownload = (Join-Path $PSScriptRoot '../infra/windows-local/minecraft-download.json'),
    [string]$DeepSeekApiKeyEnv = 'DEEPSEEK_API_KEY'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/arena-paths.ps1"
if (-not $AcceptEula) { throw 'Pass -AcceptEula after reading https://www.minecraft.net/eula to accept the Minecraft EULA.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = Assert-ArenaPath $DeploymentDir
if (Test-Path -LiteralPath $destination) { throw 'DeploymentDir already exists; initialization never overwrites a deployment.' }
$world = Assert-ArenaPath $WorldDir -Tree
if (-not (Test-Path -LiteralPath (Join-Path $world 'level.dat') -PathType Leaf)) { throw 'WorldDir must be a prepared Minecraft world containing level.dat.' }
if ($destination.StartsWith($world.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'DeploymentDir must not be inside WorldDir.' }
$match = (Resolve-Path -LiteralPath $MatchConfig).Path
# The host validates the match schema. Here we only require readable JSON before copying it.
$null = Get-Content -LiteralPath $match -Raw | ConvertFrom-Json
$download = Get-Content -LiteralPath $ServerDownload -Raw | ConvertFrom-Json
if ($download.sha1 -notmatch '^[a-fA-F0-9]{40}$' -or $download.size -le 0) { throw 'ServerDownload requires the expected server JAR sha1 and size.' }
if ($ServerJar) { $ServerJar = (Resolve-Path -LiteralPath $ServerJar).Path }
elseif ($download.url -notmatch '^https://') { throw 'ServerDownload requires an HTTPS download URL.' }
$key = [Environment]::GetEnvironmentVariable($DeepSeekApiKeyEnv)
if ($key -match '[\r\n\x00]') { throw 'DeepSeek API key contains unsupported characters.' }
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
    foreach ($dir in @('server','minecraft-data','map-original','auth','results','control')) { New-Item -ItemType Directory -Path (Join-Path $stage $dir) | Out-Null }
    $template = Join-Path $repo 'infra/windows-local'
    foreach ($file in @('compose.yaml','budget.json','budget.deepseek.json','codex.json','deepseek.json','model.codex.json','model.deepseek.json')) { Copy-Item -LiteralPath (Join-Path $template $file) -Destination $stage }
    Copy-Item -LiteralPath $match -Destination (Join-Path $stage 'match.live.json')
    Copy-Item -LiteralPath (Join-Path $template 'Dockerfile.minecraft') -Destination (Join-Path $stage 'server/Dockerfile')
    Copy-Item -LiteralPath $ServerDownload -Destination (Join-Path $stage 'server/download.json')
    $jarTarget = Join-Path $stage 'server/server.jar'
    if ($ServerJar) { Copy-Item -LiteralPath $ServerJar -Destination $jarTarget } else { Invoke-WebRequest -Uri $download.url -OutFile $jarTarget }
    if ((Get-Item -LiteralPath $jarTarget).Length -ne $download.size -or (Get-FileHash -LiteralPath $jarTarget -Algorithm SHA1).Hash -ne $download.sha1) { throw 'Server JAR does not match the checksum and size in ServerDownload.' }
    Copy-Item -LiteralPath $world -Destination (Join-Path $stage 'map-original/world') -Recurse
    Copy-Item -LiteralPath (Join-Path $stage 'map-original/world') -Destination (Join-Path $stage 'minecraft-data/world') -Recurse
    $envLines = [Collections.Generic.List[string]]::new()
    # Compose dotenv single quotes preserve dollar signs and backslashes literally.
    function Quote-DotEnv([string]$value) { return "'" + $value.Replace("'", "\'") + "'" }
    $envLines.Add('ARENA_SOURCE_DIR=' + (Quote-DotEnv $repo.Replace('\','/')))
    $rcon = ''
    foreach ($name in @('MC_RCON_PASSWORD','RED1_BRIDGE_TOKEN','BLUE1_BRIDGE_TOKEN','RED1_MODEL_TOKEN','BLUE1_MODEL_TOKEN','CODEX_ADAPTER_TOKEN','DEEPSEEK_ADAPTER_TOKEN')) {
        $token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        $envLines.Add("$name=$token")
        if ($name -eq 'MC_RCON_PASSWORD') { $rcon = $token }
    }
    if ($key) { $envLines.Add('DEEPSEEK_API_KEY=' + (Quote-DotEnv $key)) }
    [IO.File]::WriteAllLines((Join-Path $stage '.env'), $envLines)
    [IO.File]::WriteAllText((Join-Path $stage '.proxy.env'), '')
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
Write-Output "Initialized deployment at $destination. Review server.properties and match.live.json, then complete Codex OAuth login before starting agents."
