$ErrorActionPreference = "Stop"

$windowsRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = Join-Path $windowsRoot "build"
$x64Root = Join-Path $targetRoot "x64"
$arm64Root = Join-Path $targetRoot "arm64"
$bundlesRoot = Join-Path $windowsRoot "bundles"
$arm64Target = if ($env:NOCTURNE_ARM64_TARGET) { $env:NOCTURNE_ARM64_TARGET } else { "aarch64-pc-windows-msvc" }
$cargoTargetRoot = if ($env:CARGO_TARGET_DIR) {
  [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
} else {
  Join-Path $windowsRoot "target"
}

New-Item -ItemType Directory -Force -Path $x64Root, $arm64Root, $bundlesRoot | Out-Null

$serverRoot = Join-Path $windowsRoot "binaries"
Set-Location $windowsRoot

function Invoke-CargoTarget([string]$target) {
  $arguments = @(
    "build", "--manifest-path", (Join-Path $windowsRoot "Cargo.toml"),
    "--release", "--target", $target
  )
  if ($env:NOCTURNE_CARGO_TOOLCHAIN) {
    & rustup run $env:NOCTURNE_CARGO_TOOLCHAIN cargo @arguments
  } else {
    & cargo @arguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Native host build failed for $target with exit code $LASTEXITCODE."
  }
}

function Copy-HostRuntime([string]$target, [string]$targetTriple, [string]$architecture, [string]$destination) {
  $loader = Get-ChildItem (Join-Path $target "release\build") -Recurse -Filter "WebView2Loader.dll" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\out\\$architecture\\WebView2Loader\.dll$" } |
    Select-Object -First 1
  if ($null -eq $loader) {
    throw "WebView2Loader.dll for $architecture was not produced by the native build."
  }
  Copy-Item $loader.FullName (Join-Path $destination "WebView2Loader.dll") -Force

  $runtimeName = if ($architecture -eq "arm64") { "arm64" } else { "x64" }
  $runtime = Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio") -Recurse -Filter "vcruntime140.dll" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\$runtimeName\\Microsoft\.VC143\.CRT\\vcruntime140\.dll$" } |
    Select-Object -First 1
  if ($null -ne $runtime) {
    Copy-Item $runtime.FullName (Join-Path $destination "vcruntime140.dll") -Force
    $runtimeOne = Join-Path $runtime.DirectoryName "vcruntime140_1.dll"
    if (Test-Path $runtimeOne) {
      Copy-Item $runtimeOne (Join-Path $destination "vcruntime140_1.dll") -Force
    }
  }
  if ($targetTriple -like "*gnullvm") {
    if (-not $env:NOCTURNE_LLVM_MINGW_ROOT) {
      throw "NOCTURNE_LLVM_MINGW_ROOT is required for a gnullvm ARM64 build."
    }
    $unwind = Join-Path $env:NOCTURNE_LLVM_MINGW_ROOT "bin\libunwind.dll"
    if (-not (Test-Path $unwind)) {
      throw "libunwind.dll was not found under NOCTURNE_LLVM_MINGW_ROOT."
    }
    Copy-Item $unwind (Join-Path $destination "libunwind.dll") -Force
  }
}

if (-not (Test-Path (Join-Path $serverRoot "nocturne-connector-server-x64.exe"))) {
  throw "The x64 Bun server sidecar is missing. Run the server-build recipe first."
}
if (-not (Test-Path (Join-Path $serverRoot "nocturne-connector-server-arm64.exe"))) {
  throw "The ARM64 Bun server sidecar is missing. Run the server-build recipe first."
}

$env:NOCTURNE_SERVER_EXECUTABLE = Join-Path $serverRoot "nocturne-connector-server-arm64.exe"
if ($arm64Target -like "*gnullvm" -and $env:NOCTURNE_ARM64_LINKER) {
  $env:CARGO_TARGET_AARCH64_PC_WINDOWS_GNULLVM_LINKER = $env:NOCTURNE_ARM64_LINKER
}
Invoke-CargoTarget $arm64Target
$armTargetRoot = Join-Path $cargoTargetRoot $arm64Target
Copy-Item (Join-Path $armTargetRoot "release\nocturne-connector-windows.exe") (Join-Path $arm64Root "Nocturne.Connector.exe") -Force
Copy-HostRuntime $armTargetRoot $arm64Target "arm64" $arm64Root

$env:NOCTURNE_SERVER_EXECUTABLE = Join-Path $serverRoot "nocturne-connector-server-x64.exe"
Invoke-CargoTarget "x86_64-pc-windows-msvc"
$x64TargetRoot = Join-Path $cargoTargetRoot "x86_64-pc-windows-msvc"
Copy-Item (Join-Path $x64TargetRoot "release\nocturne-connector-windows.exe") (Join-Path $x64Root "Nocturne.Connector.exe") -Force
Copy-HostRuntime $x64TargetRoot "x86_64-pc-windows-msvc" "x64" $x64Root

Copy-Item (Join-Path $serverRoot "nocturne-connector-server-arm64.exe") (Join-Path $arm64Root "nocturne-connector-server.exe") -Force
Copy-Item (Join-Path $serverRoot "nocturne-connector-server-x64.exe") (Join-Path $x64Root "nocturne-connector-server.exe") -Force
Remove-Item (Join-Path $arm64Root "client") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $x64Root "client") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $serverRoot "client") (Join-Path $arm64Root "client") -Recurse -Force
Copy-Item (Join-Path $serverRoot "client") (Join-Path $x64Root "client") -Recurse -Force

$nsis = Get-Command makensis -ErrorAction SilentlyContinue
if ($null -eq $nsis) {
  $installedNsis = Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe"
  if (Test-Path $installedNsis) {
    $nsis = Get-Item $installedNsis
  }
}
if ($null -eq $nsis) {
  throw "makensis is required to build the universal setup executable."
}
$nsisPath = if ($nsis.PSObject.Properties.Name -contains "Source") {
  $nsis.Source
} else {
  $nsis.FullName
}

$version = if ($env:NOCTURNE_CONNECTOR_VERSION) { $env:NOCTURNE_CONNECTOR_VERSION } else { "2.1.3" }
$output = Join-Path $bundlesRoot "nocturne-connector_${version}_windows_setup.exe"

function Sign-Artifact([string]$path) {
  if (-not $env:NOCTURNE_SIGNING_CERT) {
    return
  }
  $signTool = Get-Command signtool -ErrorAction SilentlyContinue
  if ($null -eq $signTool) {
    throw "signtool is required when NOCTURNE_SIGNING_CERT is set."
  }
  $timestampUrl = if ($env:NOCTURNE_SIGNING_TIMESTAMP_URL) {
    $env:NOCTURNE_SIGNING_TIMESTAMP_URL
  } else {
    "http://timestamp.digicert.com"
  }
  $arguments = @("sign", "/fd", "SHA256", "/f", $env:NOCTURNE_SIGNING_CERT)
  if ($timestampUrl -ne "none") {
    $arguments += @("/tr", $timestampUrl, "/td", "SHA256")
  }
  if ($env:NOCTURNE_SIGNING_CERT_PASSWORD) {
    $arguments += @("/p", $env:NOCTURNE_SIGNING_CERT_PASSWORD)
  }
  $arguments += $path
  & $signTool.Source @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Signing failed for $path with exit code $LASTEXITCODE."
  }
}

Get-ChildItem $x64Root, $arm64Root -Recurse -Include *.exe, *.dll | ForEach-Object {
  Sign-Artifact $_.FullName
}
& $nsisPath "/DVERSION=$version" "/DX64ROOT=$x64Root" "/DARM64ROOT=$arm64Root" "/DOUTFILE=$output" (Join-Path $PSScriptRoot "universal-installer.nsi")
if ($LASTEXITCODE -ne 0) {
  throw "Universal installer build failed with exit code $LASTEXITCODE."
}
Sign-Artifact $output
