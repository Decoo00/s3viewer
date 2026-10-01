# tools

게임에서 추출한 무기 모델(`Wmn_*.bfres.zs`)을 웹에서 쓰는 `glb/`로 변환하는 스크립트.

## 준비

1. Python 3.8 이상, `pip install zstandard`
2. [BfrAss](https://github.com/RAMDRAGONS/BfrAss) 빌드 (CMake + C++ 컴파일러)
   ```sh
   git clone https://github.com/assimp/assimp
   git clone https://github.com/RAMDRAGONS/BfrAss
   cd BfrAss
   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
   cmake --build build
   ```
   `assimp`와 `BfrAss`는 같은 폴더에 나란히 있어야 한다. 결과물은 `build/bfrass`.
3. 애니메이션(롤러 접기/펴기 등)을 넣으려면 `fska_dump` 빌드 (.NET 8 SDK 필요). BfrAss는 애니메이션을 읽지 못해서,
   [KillzXGaming/ShaderLibrary](https://github.com/KillzXGaming/ShaderLibrary)에 들어 있는 BfresLibrary DLL로 읽는다.
   ```sh
   git clone https://github.com/KillzXGaming/ShaderLibrary
   BFRES_LIB_DIR=/path/to/ShaderLibrary/ShaderLibrary.CompileTool/Libs/Bfres dotnet build tools/fska_dump -c Release -o tools/fska_dump/out
   ```
   `build_glb.py`는 `dotnet tools/fska_dump/out/fska_dump.dll`을 실행한다 (다른 위치면 환경 변수 `FSKA_DUMP`로 지정).

## 실행

```sh
BFRASS=/path/to/bfrass python tools/build_glb.py <추출한 Model 폴더> glb
```

- 세 번째 인자로 파일 패턴을 바꿀 수 있다 (기본 `Wmn_*.bfres.zs`).
- 컬래버(`_CstmNN`)가 참조하는 기본 무기 텍스처와 애니메이션은 기본 무기 파일에서 가져오므로, 기본 무기 파일도 같은 패턴에 포함돼야 한다.

## 출력 형식

- bfres 안의 모델 하나당 `<모델 이름>.glb` 하나. 텍스처는 PNG로 내장.
- `material.extras.s3` (three.js에서는 `material.userData.s3`)
  - `textures`: 셰이더 샘플러 이름 → `{index, name}` (예: `_a0` 알베도, `_n0` 노멀, `_su0` Tcl)
  - `options`: 기본값이 아닌 셰이더 옵션 (예: `team_color_map_type`)
  - `shader`: 셰이더 이름
  - `render`: 불투명이 아닐 때만. render state (`mode`, `blend`, `depth_write`, `alpha_test`)
  - `params`: 뷰어가 쓰는 셰이더 파라미터 (`opacity`, `emission_*`, `manual_fresnel*`)
- `node.extras.s3.hidden`: 게임에서 기본으로 숨겨진 부품
- 무기군별 기본 방향 보정(`ROTATE_Y`)은 루트 노드 회전으로 들어간다.
- `animations`: 게임 스켈레탈 애니메이션 중 `ANIMATIONS`(`Open`, `Close`, `Open_Loop`). 커브가 있는 본만, 게임 커브를 프레임당 2번 샘플링한 linear 키, 60fps 기준 시간.
- `node.extras.s3.visibility`: 본 보임/숨김 애니메이션 → 그 본에 붙은 메시의 `{애니메이션: [[초, 보임], ...]}` (예: 와이드 롤러 빨대)
- `material.extras.s3.param_anims`: 셰이더 파라미터 애니메이션 `{애니메이션: {loop, duration, tracks: [{param, target, times, values}]}}`.
  `ANIMATIONS`에 있는 이름과 `_auto`로 끝나는 이름만 (예: 와이드 롤러 헤드 `tex_mtx0`, 히어로 슈터 `emission_intensity`)
