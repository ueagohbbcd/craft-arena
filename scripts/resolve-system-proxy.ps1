param([Parameter(Mandatory)][Uri]$Target)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/system-proxy.ps1"
Get-ArenaSystemProxy -Target $Target
