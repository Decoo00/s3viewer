# bfres.zs → glb 원클릭 변환 (Windows)

## 쓰는 법

- `convert_bfres.bat` 위로 `Wmn_*.bfres.zs` 파일을 끌어다 놓는다 (여러 개 가능). 더블클릭하면 파일 선택 창이 뜬다.
- 결과는 입력 파일 폴더의 `glb\`에 생기고, 끝나면 탐색기가 열린다.
- 명령줄: `powershell -ExecutionPolicy Bypass -File tools\convert\convert.ps1 -Out <출력 폴더> <파일...>`
- 필요한 것: Docker Desktop (켜져 있어야 함), `tools/cloud_toolkit/`의 `s3tools.tar.xz.part00`·`part01` (git에는 없음).
- 처음 한 번만 도구 이미지 `s3glb`를 만든다. toolkit을 다시 묶었으면 `docker rmi s3glb` 후 다시 실행.
- 컬래버(`_CstmNN`)를 넣으면 같은 폴더의 기본 무기 파일도 같이 변환한다 (텍스처·애니메이션을 기본 무기에서 가져오기 때문). 그래서 기본 무기 glb도 같이 나온다.
- 파일 하나에 모델이 여러 개면 glb도 여러 개 나온다 (예: `Wmn_Shooter_Short` → `Short`, `Precision`).

## 안에서 일어나는 일

1. `convert.ps1`이 입력 파일을 임시 폴더에 모은다.
2. Docker `ubuntu:24.04` 컨테이너(이미지 `s3glb`)에서 `tools/build_glb.py`를 돌린다. `tools/`는 읽기 전용으로 붙이므로, 저장소의 현재 `build_glb.py`가 그대로 쓰인다.
   이미지에는 `restore.sh`로 푼 bfrass, .NET 8 런타임, fska_dump, zstd shim이 들어 있다.
3. `build_glb.py`가 하는 일:
   - **zstd 해제**: `.bfres.zs` → `.bfres`.
   - **BfrAss**: bfres를 glTF로 바꾼다 (메시, 스켈레톤, 텍스처 PNG).
   - **bfres 직접 파싱**: 머티리얼마다 셰이더 이름, 옵션, 샘플러 → 텍스처 매핑(`_a0`, `_n0` …), render state, 셰이더 파라미터를 읽어 `material.extras.s3`에 넣는다.
     transfilm·edge light·transmission 파라미터는 `add_s3_params.py`를 import해서 같은 방식으로 넣는다.
   - **텍스처 정리**: 컬래버가 참조하는 기본 무기 텍스처를 복사해 넣고, 1채널 텍스처는 회색 PNG로 줄인다.
   - **애니메이션**: `fska_dump`(C#, BfresLibrary)로 스켈레탈·본 보임·셰이더 파라미터 애니메이션을 JSON으로 뽑아 glTF 애니메이션과 `extras.s3`로 넣는다.
   - **glb 쓰기**: 숨김 부품 표시, 무기군별 회전(`ROTATE_Y`), 왼손 대칭(`_L`)을 넣고 모델마다 `.glb` 하나로 저장한다.

2026-10-03 확인: `Wmn_Shooter_Short_Cstm01` 변환 결과 3개가 저장소 `glb/`와 md5 일치.
