# 生成 TurtleMark 全套应用图标（需要 Windows + .NET System.Drawing）
param([string]$OutDir = "")

Add-Type -AssemblyName System.Drawing
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot '..\icons' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Get-DropletPath([float]$scale, [float]$cx, [float]$cy) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.StartFigure()
    $p.AddBezier(256, 440, 206, 340, 140, 300, 159, 215)   # 底尖 → 左侧
    $p.AddArc(159, 118, 194, 194, 180, 180)                 # 左侧 → 顶部 → 右侧
    $p.AddBezier(353, 215, 372, 300, 306, 340, 256, 440)    # 右侧 → 底尖
    $p.CloseFigure()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Scale($scale, $scale)
    $m.Translate($cx - 256 * $scale, $cy - 256 * $scale)
    $p.Transform($m)
    return $p
}

function Get-RoundedRectPath([int]$s, [int]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $r
    if ($r -le 0) { $p.AddRectangle((New-Object System.Drawing.Rectangle(0, 0, $s, $s))); return $p }
    $p.AddArc(0, 0, $d, $d, 180, 90)
    $p.AddArc($s - $d, 0, $d, $d, 270, 90)
    $p.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
    $p.AddArc(0, $s - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Get-SparklePath([float]$scale, [float]$cx, [float]$cy) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddPolygon([System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF(360, 100)),
        (New-Object System.Drawing.PointF(372, 128)),
        (New-Object System.Drawing.PointF(400, 140)),
        (New-Object System.Drawing.PointF(372, 152)),
        (New-Object System.Drawing.PointF(360, 180)),
        (New-Object System.Drawing.PointF(348, 152)),
        (New-Object System.Drawing.PointF(320, 140)),
        (New-Object System.Drawing.PointF(348, 128))
    ))
    $p.CloseFigure()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Scale($scale, $scale)
    $m.Translate($cx - 360 * $scale, $cy - 140 * $scale)
    $p.Transform($m)
    return $p
}

function New-Icon([int]$size, [string]$name, [int]$radius, [float]$dropScale, [bool]$withSparkle) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $bgPath = Get-RoundedRectPath $size ([int]($radius * $size / 512))
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle(0, 0, $size, $size)),
        [System.Drawing.Color]::FromArgb(255, 34, 211, 238),
        [System.Drawing.Color]::FromArgb(255, 37, 99, 235),
        45)
    $g.FillPath($brush, $bgPath)
    $brush.Dispose()

    $outer = Get-DropletPath $dropScale 256 262
    $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), $outer)
    $inner = Get-DropletPath ($dropScale * 0.56) 256 262
    $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 34, 211, 238))), $inner)
    if ($withSparkle) {
        $sp = Get-SparklePath ($dropScale * 0.8) 256 256
        $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 224, 242, 254))), $sp)
    }
    $g.Dispose()
    $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "OK  $name  (${size}x${size})"
}

New-Icon 512 'icon-512.png'          116  1.0  $true
New-Icon 192 'icon-192.png'          116  1.0  $true
New-Icon 512 'icon-maskable-512.png' 80   0.76 $false
New-Icon 180 'apple-touch-icon.png'  0    1.0  $true
New-Icon 32  'favicon-32.png'        116  1.0  $false

Write-Host "图标已生成到: $OutDir"
