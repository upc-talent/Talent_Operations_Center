# Tiny static web server for local testing (no Node/Python needed).
#   powershell -NoProfile -ExecutionPolicy Bypass -File dev/serve.ps1 -Port 5173
param([int]$Port = 5173)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mime = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.js'='application/javascript; charset=utf-8';
           '.gs'='text/plain; charset=utf-8'; '.json'='application/json'; '.png'='image/png'; '.svg'='image/svg+xml'; '.ico'='image/x-icon' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root) -or -not (Test-Path $path -PathType Leaf)) {
      $ctx.Response.StatusCode = 404
    } else {
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $ctx.Response.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
      $bytes = [IO.File]::ReadAllBytes($path)
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch { $ctx.Response.StatusCode = 500 }
  $ctx.Response.Close()
}
