# Generates build/icon.ico (and build/icon.png) from code: a stack of three layers on an indigo tile.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force "$root\build" | Out-Null

function Render([int]$n) {
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  # tile
  $r = $n * 0.22; $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($n - $d, 0, $d, $d, 270, 90)
  $path.AddArc($n - $d, $n - $d, $d, $d, 0, 90); $path.AddArc(0, $n - $d, $d, $d, 90, 90); $path.CloseFigure()
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0, 0)), ([System.Drawing.Point]::new($n, $n)), ([System.Drawing.Color]::FromArgb(255, 139, 149, 255)), ([System.Drawing.Color]::FromArgb(255, 88, 99, 224))
  $g.FillPath($grad, $path)
  # three stacked rhombus layers, fading toward the bottom
  $cx = $n / 2; $w = $n * 0.30; $h = $n * 0.14; $step = $n * 0.17; $top = $n * 0.27
  $tints = @(@(255,255,255), @(224,227,253), @(190,196,249))
  for ($i = 2; $i -ge 0; $i--) {
    $cy = $top + $i * $step
    $pts = [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($cx, $cy - $h), [System.Drawing.PointF]::new($cx + $w, $cy),
      [System.Drawing.PointF]::new($cx, $cy + $h), [System.Drawing.PointF]::new($cx - $w, $cy))
    $b = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $tints[$i][0], $tints[$i][1], $tints[$i][2]))
    $g.FillPolygon($b, $pts)
  }
  $g.Dispose(); return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) { $ms = New-Object System.IO.MemoryStream; (Render $s).Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); ,$ms.ToArray() }
(Render 512).Save("$root\build\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

# ICO container with PNG-compressed entries
$out = New-Object System.IO.MemoryStream; $bw = New-Object System.IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
[System.IO.File]::WriteAllBytes("$root\build\icon.ico", $out.ToArray())
"ok"
