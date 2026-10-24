#requires -Version 7.0
# Creates a Windows deployment directory that only the current user, SYSTEM
# and Administrators can open, writes deploy.json and match.json into it
# (packages/arena/src/deployment.mjs init) and generates the deployment
# (deployment.mjs deploy). Afterwards edit deploy.json or match.json and run
# scripts/windows-arena.ps1 deploy to apply the change.
[CmdletBinding()]
param(
    # A Minecraft world folder containing level.dat; copied, never changed.
    [Parameter(Mandatory)][string]$SaveDir,
    [string]$DeploymentDir = (Join-Path $PSScriptRoot '../runtime/deploy'),
    # Compose project name and image tag (default: craft-arena-<folder name>).
    [string]$DeploymentName,
    [switch]$AcceptEula
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $AcceptEula) { throw 'Pass -AcceptEula after reading https://www.minecraft.net/eula to accept the Minecraft EULA.' }
$node = (Get-Command node -ErrorAction Stop).Source
if ((& $node -p 'Number(process.versions.node.split(".")[0]) >= 24') -ne 'true') { throw 'Node.js 24 or newer is required.' }
$destination = [IO.Path]::GetFullPath($DeploymentDir)
if (Test-Path -LiteralPath $destination) { throw 'DeploymentDir already exists; run windows-arena.ps1 deploy to update a deployment.' }
New-Item -ItemType Directory -Path $destination | Out-Null
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($sid in @($currentUser, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, $propagation, $allow))
}
Set-Acl -LiteralPath $destination -AclObject $acl
$cli = Join-Path $PSScriptRoot '../packages/arena/src/deployment.mjs'
$initArgs = @($cli, 'init', $destination, '--save', $SaveDir)
if ($DeploymentName) { $initArgs += @('--name', $DeploymentName) }
& $node @initArgs
if ($LASTEXITCODE -ne 0) { throw 'Writing deploy.json failed (see above).' }
& $node $cli deploy $destination --accept-eula
if ($LASTEXITCODE -ne 0) { throw 'Generating the deployment failed (see above); fix deploy.json or match.json and run windows-arena.ps1 deploy.' }
Write-Output "Initialized $destination. Put the model keys named above into its .env, then run windows-arena.ps1 build, up and start."
