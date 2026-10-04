# bfres.zs → glb 변환 (Windows용 래퍼). 기존 파이프라인(tools/build_glb.py + cloud_toolkit)을 Docker ubuntu:24.04 안에서 그대로 돌린다.
# usage: convert.ps1 [-Out <출력 폴더>] [파일.bfres.zs ...]
#   파일을 안 주면 파일 선택 창이 뜬다. 출력 폴더 기본값: 첫 입력 파일 폴더의 glb\
#   컬래버(_CstmNN)는 같은 폴더의 기본 무기 파일도 같이 넣는다 (텍스처·애니메이션 참조). 그래서 기본 무기 glb도 같이 나온다.
param(
    [string]$Out,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Files
)
$ErrorActionPreference = 'Stop'
$image = 's3glb'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tools = Join-Path $repo 'tools'

if (-not $Files) {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter = 'bfres.zs (*.bfres.zs)|*.bfres.zs'
    $dlg.Multiselect = $true
    $dlg.Title = '변환할 무기 bfres.zs 선택 (여러 개 가능)'
    if ($dlg.ShowDialog() -ne 'OK') { exit 1 }
    $Files = $dlg.FileNames
}
$Files = @($Files | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
foreach ($f in $Files) {
    if ($f -notlike '*.bfres.zs') { throw "bfres.zs 파일이 아니다: $f" }
}
if (-not $Out) { $Out = Join-Path (Split-Path $Files[0]) 'glb' }
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path

# Docker 확인 (네이티브 명령 실패가 예외로 안 바뀌게 잠깐 Continue)
$ErrorActionPreference = 'Continue'
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker가 안 켜져 있다. Docker Desktop을 켠 뒤 다시 실행해.' }

# 도구 이미지가 없으면 한 번만 만든다 (cloud_toolkit 묶음 복원)
docker image inspect $image *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "처음 실행이라 도구 이미지($image)를 만든다..."
    docker build -t $image -f (Join-Path $PSScriptRoot 'Dockerfile') (Join-Path $tools 'cloud_toolkit')
    if ($LASTEXITCODE -ne 0) { throw '이미지 빌드 실패' }
}

# 입력 stage: 고른 파일 + 컬래버의 기본 무기 파일
$stage = Join-Path ([IO.Path]::GetTempPath()) ('s3glb_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
try {
    foreach ($f in $Files) {
        Copy-Item -LiteralPath $f $stage -Force
        $name = [IO.Path]::GetFileName($f)
        if ($name -match '^(.+?)_Cstm\d*') {
            $base = Join-Path (Split-Path $f) ($Matches[1] + '.bfres.zs')
            if (Test-Path -LiteralPath $base) { Copy-Item -LiteralPath $base $stage -Force }
            else { Write-Warning "기본 무기 파일이 없다: $base (텍스처·애니메이션이 빠질 수 있음)" }
        }
    }
    Write-Host "변환: $((Get-ChildItem $stage).Name -join ', ')"
    docker run --rm -e PYTHONDONTWRITEBYTECODE=1 `
        -v "${stage}:/in:ro" -v "${Out}:/out" -v "${tools}:/tools:ro" `
        $image bash -c 'source /opt/s3tools/env.sh && cd /tmp && python3 /tools/build_glb.py /in /out'
    if ($LASTEXITCODE -ne 0) { throw '변환 실패 (위 로그 참고)' }
    Write-Host "완료: $Out"
    explorer.exe $Out
}
finally {
    Remove-Item -Recurse -Force -LiteralPath $stage
}
