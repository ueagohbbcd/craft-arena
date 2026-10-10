# Shared filesystem guard for initialization and reset. Never follow links while moving world data.
function Assert-ArenaPath {
    param([Parameter(Mandatory)][string]$Path, [string]$Root, [switch]$Tree)
    $full = [IO.Path]::GetFullPath($Path)
    if ($Root) {
        $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path must remain inside the deployment.' }
    }
    $cursor = $full
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing to follow a reparse point: $cursor" }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    if ($Tree -and (Test-Path -LiteralPath $full) -and (Get-ChildItem -LiteralPath $full -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw "Tree contains a reparse point: $full" }
    return $full
}
