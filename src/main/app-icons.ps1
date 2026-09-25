# Reads "key|path" lines on stdin and prints "key|<base64 png>" for each.
# Store apps (under WindowsApps) use the logo from their package manifest;
# everything else uses the icon Windows associates with the executable.
# Office click-to-run and Store executables return a generic icon through
# the usual shell API, which is why this exists.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

function Png64($bitmap) {
  $ms = New-Object System.IO.MemoryStream
  $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($ms.ToArray())
}

function StoreLogo($exe) {
  $dir = Split-Path $exe
  while ($dir -and -not (Test-Path (Join-Path $dir 'AppxManifest.xml'))) { $dir = Split-Path $dir }
  if (-not $dir) { return $null }
  [xml]$m = Get-Content (Join-Path $dir 'AppxManifest.xml') -Raw
  $name = Split-Path $exe -Leaf
  $apps = @($m.Package.Applications.Application)
  $app = $apps | Where-Object { $_.Executable -and ($_.Executable -like "*$name") } | Select-Object -First 1
  if (-not $app) { $app = $apps | Select-Object -First 1 }
  $logo = $app.VisualElements.Square44x44Logo
  if (-not $logo) { return $null }
  $base = Join-Path $dir ([System.IO.Path]::ChangeExtension($logo, $null).TrimEnd('.'))
  $ext = [System.IO.Path]::GetExtension($logo)
  foreach ($suffix in '.targetsize-48_altform-unplated', '.targetsize-48', '.targetsize-64_altform-unplated', '.scale-200', '.targetsize-32', '') {
    $f = "$base$suffix$ext"
    if (Test-Path $f) { return [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) }
  }
  $any = Get-ChildItem (Split-Path $base) -Filter ((Split-Path $base -Leaf) + '*' + $ext) | Sort-Object Length -Descending | Select-Object -First 1
  if ($any) { return [Convert]::ToBase64String([IO.File]::ReadAllBytes($any.FullName)) }
  return $null
}

foreach ($line in [Console]::In.ReadToEnd() -split "`r?`n") {
  if (-not $line) { continue }
  $key, $path = $line -split '\|', 2
  $b64 = $null
  try {
    if ($path -match '\\WindowsApps\\') { $b64 = StoreLogo $path }
    if (-not $b64) { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path); if ($icon) { $b64 = Png64 $icon.ToBitmap() } }
  } catch { }
  if ($b64) { [Console]::Out.WriteLine("$key|$b64") }
}
