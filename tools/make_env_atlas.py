# 게임 장비 뷰어의 prefiltered env 큐브 배열(Hoian Viewer Resources/SPL3/cubemap.dds, R11G11B10F 256², 13개) 중
# 셰이더가 거칠기로 고르는 0~11번을 텍스처 한 장으로 모음 (WebGL2에는 cube array가 없음)
# 큐브 k = 가로로 놓은 면 6개(+X -X +Y -Y +Z -Z), 각 면은 D3D 큐브맵 방향 그대로. 1~11번은 원래 흐려서 작은 밉을 씀 (256 대비 오차 1% 미만)
# 값(최대 1.047)은 1.05로 나눠 sRGB 8bit로 저장
# usage: python make_env_atlas.py cubemap.dds spl3_viewer_env.png
import numpy as np, sys
from PIL import Image
raw = open(sys.argv[1], 'rb').read()
N, MIPS = 256, 6
LAYER = sum((N >> m) ** 2 * 4 for m in range(MIPS))
SCALE = 1.05
# (큐브, 밉, x, y): main.js의 ENV_ATLAS_BLOCKS와 같아야 함
BLOCKS = [(0, 0, 0, 0), (1, 2, 0, 256)] + [(k, 3, 384 + (k - 2) % 6 * 192, 256 + (k - 2) // 6 * 32) for k in range(2, 12)]
W, H = 1536, 320

def r11g11b10(u, bits):
    m = u & ((1 << bits) - 1); e = (u >> bits) & 31
    return np.where(e == 0, m / (1 << bits) * 2.0 ** -14, (1 + m / (1 << bits)) * 2.0 ** (e.astype(np.float64) - 15))

def face(layer, mip):
    w = N >> mip
    u = np.frombuffer(raw, np.uint32, w * w, 148 + layer * LAYER + sum((N >> m) ** 2 * 4 for m in range(mip))).reshape(w, w)
    return np.stack([r11g11b10(u & 0x7FF, 6), r11g11b10((u >> 11) & 0x7FF, 6), r11g11b10((u >> 22) & 0x3FF, 5)], -1)

atlas = np.zeros((H, W, 3))
for k, mip, x, y in BLOCKS:
    s = N >> mip
    for f in range(6):
        atlas[y:y + s, x + f * s:x + (f + 1) * s] = face(k * 6 + f, mip)
v = np.clip(atlas / SCALE, 0, 1)
srgb = np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)
Image.fromarray(np.round(srgb * 255).astype(np.uint8)).save(sys.argv[2], optimize=True)
