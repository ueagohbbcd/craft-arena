param([string]$AuthFile = 'runtime/codex/auth.json')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\system-proxy.ps1"
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$proxy = Get-ArenaSystemProxy -Target 'https://auth.openai.com/oauth/token'
$saved = @{}
foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','NO_PROXY')) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
try {
  $env:HTTP_PROXY = $proxy
  $env:HTTPS_PROXY = $proxy
  $env:NO_PROXY = 'localhost,127.0.0.1,::1'
  $path = if ([IO.Path]::IsPathRooted($AuthFile)) { $AuthFile } else { Join-Path $root $AuthFile }
  & $node --use-env-proxy "$root\packages\codex-adapter\login.mjs" $path
  if ($LASTEXITCODE -ne 0) { throw 'Pi OAuth login did not complete.' }
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
}

