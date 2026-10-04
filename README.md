# Splatoon 3 Web Viewer (v0.6.2)

[한국어](#한국어) | [English](#english)

https://decoo00.github.io/s3viewer/

## 한국어

스플래툰 3 메인 웨폰을 여러 각도에서 볼 수 있는 웹 3D 뷰어입니다.
무기를 그리는 사람이 자료를 찾아 헤매지 않고, 원하는 각도와 상태를 직접 띄워 놓고 볼 수 있도록 만들었습니다.
설치 없이 브라우저에서 바로 동작하며, 가볍게 돌아가는 것을 우선으로 합니다.

### 수록 무기
- 스플래툰 3 v11.3.0 기준 메인 웨폰 전 카테고리 수록
- 커스텀(바리에이션) 무기 포함

### 렌더링
- 게임 셰이더 규칙에 최대한 맞춘 렌더링 (임의 보정 없이, 확인된 규칙만 적용)
- 셰이더 종류: 인게임 / 픽셀 / 선화 / 카툰
- 원근 / 직교 카메라 전환
- 잉크 색 프리셋, 배경색 프리셋

### 애니메이션
- 무기별 동작 재현: 차지, 발사, 셸터 펴기/접기, 스트링거 가로/세로 차지, 와이퍼 차지/공격 등
- 발광·텍스처가 바뀌는 애니메이션도 게임과 같게 연결
- 히어로 슈터 레벨 슬라이더
- 일시정지 버튼으로 원하는 순간에 멈춰서 관찰

### 저장
- PNG / GIF / WebP 저장
- 투명 배경 지원
- 시퀀스 편집기로 애니메이션 구간을 골라 움직이는 이미지로 저장

### 기타
- three.js 기반, GitHub Pages로 배포
- 이 사이트는 팬 제작 비공식 도구이며, 닌텐도와 관련이 없습니다. 모든 모델과 텍스처의 저작권은 Nintendo에 있습니다.

---

## English

A web-based 3D viewer for Splatoon 3 main weapons.
Made for artists who draw weapons, so you can pull up the exact angle and state you need instead of hunting for reference images.
It runs right in the browser with no installation, and is built to stay lightweight.

### Weapons
- Every main weapon category in Splatoon 3, as of v11.3.0
- Includes custom (variant) weapons

### Rendering
- Rendering that follows the game's shader rules as closely as possible (no arbitrary tweaks, only verified rules are applied)
- Shader modes: In-game / Pixel / Line art / Cartoon
- Perspective / orthographic camera
- Ink color presets and background color presets

### Animations
- Per-weapon actions: charge, fire, Brella open/close, Stringer horizontal/vertical charge, Splatana charge/attack, and more
- Animations that change emission or textures are wired up the same way as in the game
- Hero Shot level slider
- Pause button to freeze any moment

### Export
- Save as PNG / GIF / WebP
- Transparent background supported
- Sequence editor to pick an animation range and save it as an animated image

### Other
- Built with three.js, deployed on GitHub Pages
- This is an unofficial fan-made tool and is not affiliated with Nintendo. All models and textures are © Nintendo.
