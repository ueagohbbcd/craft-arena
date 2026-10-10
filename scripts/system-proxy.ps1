function Get-ArenaSystemProxy {
  param(
    [Parameter(Mandatory)][Uri]$Target,
    [switch]$ForDocker
  )
  # Resolve Windows system settings, including per-protocol/PAC decisions.
  $resolver = [System.Net.WebRequest]::GetSystemWebProxy()
  if ($resolver.IsBypassed($Target)) { return '' }
  $proxy = $resolver.GetProxy($Target)
  if ($proxy -eq $Target) { return '' }
  if ($proxy.Scheme -notin @('http','https')) {
    throw 'The selected system proxy is not an HTTP/HTTPS proxy supported by Node.'
  }
  $builder = [UriBuilder]::new($proxy)
  if ($ForDocker -and ($builder.Host -in @('localhost','127.0.0.1','::1','[::1]'))) {
    $builder.Host = 'host.docker.internal'
  }
  return $builder.Uri.AbsoluteUri.TrimEnd('/')
}
