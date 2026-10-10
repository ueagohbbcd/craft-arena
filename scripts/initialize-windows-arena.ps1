#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$MapArchive,
    [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
    [switch]$AcceptEula,
    [string]$ServerJar,
    [string]$DeepSeekApiKeyEnv = 'DEEPSEEK_API_KEY'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $AcceptEula) { throw 'Pass -AcceptEula after reading https://www.minecraft.net/eula to accept the Minecraft EULA.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [IO.Path]::GetFullPath($DeploymentDir)
if (Test-Path -LiteralPath $destination) { throw 'DeploymentDir already exists; initialization never overwrites a deployment.' }
$archive = (Resolve-Path -LiteralPath $MapArchive).Path
$mapHash = '80d40110a81e7a833d614eeb8157fe1267feff7e1cbc47748d5df9ad01f3d8f1'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $mapHash) { throw 'MapArchive is not the verified Direct Fire Java 1.21 archive.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Validate every entry before extracting anything, including Windows path aliases.
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $zip.Entries) {
        $path = $entry.FullName.Replace('\', '/')
        if ($path.StartsWith('/') -or $path.Contains(':') -or $path -match '(^|/)\.\.(/|$)' -or $path -match '(^|/)[^/]*[. ](/|$)' -or $path -match '(?i)(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([./]|$)') { throw 'Unsafe archive entry path.' }
        if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Archive symbolic links are not supported.' }
    }
    if (-not ($zip.Entries | Where-Object FullName -eq 'Direct-Fire-Java-1.21/level.dat')) { throw 'Expected Direct Fire world root is missing.' }
} finally { $zip.Dispose() }
$key = [Environment]::GetEnvironmentVariable($DeepSeekApiKeyEnv)
if ([string]::IsNullOrWhiteSpace($key)) { throw "DeepSeek API key environment variable '$DeepSeekApiKeyEnv' is empty." }
if ($key -match '[\r\n\x00]') { throw 'DeepSeek API key contains unsupported characters.' }
$jarSha1 = '450698d1863ab5180c25d7c804ef0fe6369dd1ba'
$jarUrl = "https://piston-data.mojang.com/v1/objects/$jarSha1/server.jar"
if ($ServerJar) {
    $ServerJar = (Resolve-Path -LiteralPath $ServerJar).Path
    if ((Get-FileHash -LiteralPath $ServerJar -Algorithm SHA1).Hash.ToLowerInvariant() -ne $jarSha1) { throw 'ServerJar is not the official Minecraft 1.21 server JAR.' }
}
# Assemble next to the destination, then rename only after all inputs are valid.
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
    foreach ($dir in @('server','minecraft-data','auth','results','control')) { New-Item -ItemType Directory -Path (Join-Path $stage $dir) | Out-Null }
    $template = Join-Path $repo 'infra/windows-local'
    foreach ($file in @('compose.yaml','budget.json','budget.deepseek.json','codex.json','deepseek.json')) { Copy-Item -LiteralPath (Join-Path $template $file) -Destination $stage }
    Copy-Item -LiteralPath (Join-Path $template 'match.direct-fire.json') -Destination (Join-Path $stage 'match.live.json')
    Copy-Item -LiteralPath (Join-Path $template 'Dockerfile.minecraft') -Destination (Join-Path $stage 'server/Dockerfile')
    Copy-Item -LiteralPath (Join-Path $template 'minecraft-download.json') -Destination (Join-Path $stage 'server/download.json')
    $jarTarget = Join-Path $stage 'server/server.jar'
    if ($ServerJar) { Copy-Item -LiteralPath $ServerJar -Destination $jarTarget } else { Invoke-WebRequest -Uri $jarUrl -OutFile $jarTarget }
    if ((Get-FileHash -LiteralPath $jarTarget -Algorithm SHA1).Hash.ToLowerInvariant() -ne $jarSha1) { throw 'Downloaded server JAR checksum mismatch.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $stage 'map-original'))
    Copy-Item -LiteralPath (Join-Path $stage 'map-original/Direct-Fire-Java-1.21') -Destination (Join-Path $stage 'minecraft-data/world') -Recurse
    $envLines = [Collections.Generic.List[string]]::new()
    # Compose dotenv single quotes preserve dollar signs and backslashes literally.
    function Quote-DotEnv([string]$value) { return "'" + $value.Replace("'", "\'") + "'" }
    $envLines.Add('ARENA_SOURCE_DIR=' + (Quote-DotEnv $repo.Replace('\','/')))
    $envLines.Add('ARENA_MODEL_ID=gpt-6.1-sol')
    $rcon = ''
    foreach ($name in @('MC_RCON_PASSWORD','RED1_BRIDGE_TOKEN','BLUE1_BRIDGE_TOKEN','RED1_MODEL_TOKEN','BLUE1_MODEL_TOKEN','CODEX_ADAPTER_TOKEN','DEEPSEEK_ADAPTER_TOKEN')) {
        $bytes = [byte[]]::new(32)
        [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $token = [Convert]::ToHexString($bytes).ToLowerInvariant()
        $envLines.Add("$name=$token")
        if ($name -eq 'MC_RCON_PASSWORD') { $rcon = $token }
    }
    $envLines.Add('DEEPSEEK_API_KEY=' + (Quote-DotEnv $key))
    [IO.File]::WriteAllLines((Join-Path $stage '.env'), $envLines)
    [IO.File]::WriteAllText((Join-Path $stage '.proxy.env'), '')
    [IO.File]::WriteAllText((Join-Path $stage 'minecraft-data/eula.txt'), "eula=true`n")
    $properties = @('level-name=world','server-port=25565','enable-rcon=true','rcon.port=25575',"rcon.password=$rcon",'online-mode=false','enforce-secure-profile=false','spawn-protection=0','gamemode=survival','difficulty=normal','pvp=true','allow-flight=true','view-distance=8','simulation-distance=6','max-players=10','enable-command-block=false','motd=Craft Arena - Direct Fire 1.21','max-tick-time=120000')
    [IO.File]::WriteAllLines((Join-Path $stage 'minecraft-data/server.properties'), $properties)
    if (Test-Path -LiteralPath $destination) { throw 'DeploymentDir appeared during initialization; refusing to overwrite it.' }
    $moveSource = (Resolve-Path -LiteralPath $stage).ProviderPath
    $moveTarget = [IO.Path]::GetFullPath($destination)
    $moveParent = (Resolve-Path -LiteralPath $parent).ProviderPath
    if (-not $moveSource.Equals([IO.Path]::GetFullPath($stage), [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetDirectoryName($moveSource)).Equals($moveParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetDirectoryName($moveTarget)).Equals($moveParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Initialization move must stay inside the specified deployment parent.' }
    $cursor = $moveSource
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Initialization move paths may not traverse reparse points.' }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if (Get-ChildItem -LiteralPath $moveSource -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Initialization staging tree contains a reparse point.' }
    [IO.Directory]::Move($moveSource, $moveTarget)
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).ProviderPath
        $expectedStage = [IO.Path]::GetFullPath($stage)
        $resolvedParent = (Resolve-Path -LiteralPath $parent).ProviderPath
        if (-not $resolvedStage.Equals($expectedStage, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([IO.Path]::GetDirectoryName($resolvedStage)).Equals($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -or
            ([IO.File]::GetAttributes($resolvedStage) -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing cleanup: staging path is not the generated directory inside DeploymentDir parent.'
        }
        # Reject links anywhere beneath the staging directory before recursive cleanup.
        if (Get-ChildItem -LiteralPath $resolvedStage -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
            throw 'Refusing cleanup: staging directory contains a reparse point.'
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
Write-Output "Initialized deployment at $destination. Complete Codex OAuth login separately before starting agents."
