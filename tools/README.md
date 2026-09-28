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

## 실행

```sh
BFRASS=/path/to/bfrass python tools/build_glb.py <추출한 Model 폴더> glb
```

- 세 번째 인자로 파일 패턴을 바꿀 수 있다 (기본 `Wmn_*.bfres.zs`).
- 컬래버(`_CstmNN`)가 참조하는 기본 무기 텍스처는 glb 안에 복사되므로, 기본 무기 파일도 같은 패턴에 포함돼야 한다.

## 출력 형식

- bfres 안의 모델 하나당 `<모델 이름>.glb` 하나. 텍스처는 PNG로 내장.
- `material.extras.s3` (three.js에서는 `material.userData.s3`)
  - `textures`: 셰이더 샘플러 이름 → `{index, name}` (예: `_a0` 알베도, `_n0` 노멀, `_su0` Tcl)
  - `options`: 기본값이 아닌 셰이더 옵션 (예: `team_color_map_type`)
  - `shader`: 셰이더 이름
