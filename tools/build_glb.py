"""스플래툰 3 무기 모델(bfres.zs) → 모델별 독립 glb 변환.

- 컬래버(_CstmNN) 파일이 기본 무기의 텍스처를 참조하면, 그 텍스처를 복사해 넣어서 glb 하나로 완결되게 만든다.
- bfres 하나에 모델이 여러 개면(예: 우산+케이스, 듀얼 좌우) 모델마다 glb를 따로 만든다.
- 머티리얼마다 셰이더 샘플러(_a0, _n0, _su0 …) → 텍스처 매핑과 셰이더 옵션을 material.extras.s3에 넣는다.
  불투명이 아니면 render state(블렌딩, 깊이 쓰기, alpha test)도, 뷰어가 쓰는 파라미터(opacity, emission, manual fresnel)는 params에 넣는다.
- 무기군별 기본 방향 보정(ROTATE_Y)을 루트 노드 회전으로 넣는다.
- 기본 무기 bfres의 스켈레탈 애니메이션 중 ANIMATIONS(롤러 접기/펴기 등)를 glTF 애니메이션으로 넣는다 (tools/fska_dump 필요).
- 붙은 본이 invisible인 셰이프는 node.extras.s3.hidden = true로 표시한다 (게임에서 기본으로 숨겨진 부품).
- MIRROR_L 무기군은 왼손 모델(_L)이 bfres에 없으면 오른손 모델을 X축 대칭시켜 <모델>_L.glb로 만든다.

usage: python build_glb.py <Model 폴더> <출력 폴더> [파일 패턴, 기본 Wmn_*.bfres.zs]
환경 변수 BFRASS로 bfrass 실행 파일 경로를 지정할 수 있다 (기본: PATH의 bfrass).
"""
import fnmatch, json, math, os, re, struct, subprocess, sys, tempfile
import zstandard

BFRASS = os.environ.get('BFRASS', 'bfrass')
FSKA_DUMP = os.environ.get('FSKA_DUMP', os.path.join(os.path.dirname(__file__), 'fska_dump', 'out', 'fska_dump.dll'))
DEFAULT = '<Default Value>'
RENDER_KEYS = {'gsys_render_state_mode', 'gsys_render_state_blend_mode', 'gsys_depth_test_write', 'gsys_alpha_test_enable', 'gsys_alpha_test_value'}
# 무기군별 기본 방향 보정: 수직축(Y) 회전 각도(도). 뷰어 기본 카메라에서 정면이 보이도록 루트 노드에 회전만 넣는다 (정점은 그대로)
ROTATE_Y = {'Wmn_Roller_': 90}
# glb에 넣을 애니메이션 (롤러 접기/펴기, 쿠마 롤러 엔진, 소방 FF 사격 모드 전환 등). 컬래버 파일은 애니메이션이 없어서 기본 무기 것을 쓴다 (본 구성이 같음)
# 셰이더 파라미터 애니메이션은 이 이름들 + 이름이 '_auto'로 끝나는 것(게임이 자동 재생, 예: 히어로 슈터 발광)
ANIMATIONS = ('Open', 'Close', 'Open_Loop', 'Shot_Long_St', 'Shot_Short_St')
# 무기군별로 더 넣는 애니메이션. 이름이 다른 무기군과 겹쳐서(블래스터도 Shot이 있음) 무기군을 정해서 넣는다
# 스피너: 쿠겔 슈라이버 'Deform'(본·tex_mtx1)·'DeformEmm'(발광), 이그재미너 'Shot'(카트리지 보임/숨김 반복)
ANIMATIONS_BY_PREFIX = {'Wmn_Spinner_': ('Deform', 'DeformEmm', 'Shot')}
ANIM_SAMPLES_PER_FRAME = 2  # 게임 커브(cubic)를 이 간격으로 샘플링해서 glTF linear 키로 넣음 (게임 60fps 기준 프레임)
PARAM_KEYS = {'opacity', 'emission_intensity', 'emission_color', 'manual_fresnel', 'manual_fresnel_color'}
# 왼손 모델(<모델>_L)이 bfres에 없으면 오른손 모델을 X축(좌우)으로 대칭시켜 만든다. 머뉴버는 양손에 하나씩 드는데 듀얼 스위퍼만 _L이 따로 있음
MIRROR_L = ('Wmn_Maneuver_',)


def run(*args):
    r = subprocess.run([BFRASS, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'bfrass {args} failed:\n{r.stdout}\n{r.stderr}')
    return r.stdout + r.stderr


def parse_info(text):
    """bfrass info 출력 → {model: {material: {mat_sampler: texture_name}}}"""
    models, model, mat, section = {}, None, None, None
    for line in text.splitlines():
        if m := re.match(r'^Model (\S+)', line):
            model = models.setdefault(m.group(1), {})
            section = 'model'
        elif line.startswith('Textures'):
            section = None
        elif section == 'model':
            if m := re.match(r'^  Material (\S+)', line):
                mat = model.setdefault(m.group(1), {})
            elif m := re.match(r'^    (\S+) -> (\S+)', line):
                mat[m.group(1)] = m.group(2)
    return models


def parse_mat_info(text):
    """--mat-info 출력 → {material: {'shader': str, 'render': {k: str}, 'params': {k: [float]}, 'samplers': {shader_sampler: mat_sampler}, 'options': {k: v}}}"""
    mats, cur = {}, None
    for line in text.splitlines():
        if m := re.match(r'^Texture properties for (\S+):', line):
            cur = mats.setdefault(m.group(1), {'shader': None, 'render': {}, 'params': {}, 'samplers': {}, 'options': {}})
        elif cur is None:
            continue
        elif (m := re.match(r'^  (gsys_\w+): (.+)', line)) and m.group(1) in RENDER_KEYS:
            cur['render'][m.group(1)] = m.group(2)
        elif m := re.match(r'^Shader: (.+)', line):
            cur['shader'] = m.group(1)
        elif (m := re.match(r'^(\w+): (.+)', line)) and m.group(1) in PARAM_KEYS:
            cur['params'][m.group(1)] = [float(x) for x in m.group(2).split(', ')]
        elif (m := re.match(r'^  sampler (\S+) = (.+)', line)) and m.group(2) != DEFAULT:
            cur['samplers'][m.group(1)] = m.group(2)
        elif (m := re.match(r'^  option (\S+) = (.+)', line)) and m.group(2) != DEFAULT:
            cur['options'][m.group(1)] = m.group(2)
    return mats


def parse_shape_visibility(text):
    """--debug 출력 → {model: {shape: (보임 여부, 붙은 본 이름)}}. 보임 여부는 셰이프가 붙은 본의 visible 플래그(bit 0).
    예: 새싹 슈터는 스티커 셰이프가 붙은 Stecker_low 본이 invisible이라 게임에서 스티커가 안 보임."""
    result, model, bones = {}, None, {}
    for line in text.splitlines():
        if m := re.match(r'^FMDL: name=(\S+)', line):
            model, bones = result.setdefault(m.group(1), {}), {}
        elif m := re.match(r'^  bone #(\d+) (\S+): .*flags=0x([0-9A-Fa-f]+)', line):
            bones[int(m.group(1))] = (bool(int(m.group(3), 16) & 1), m.group(2))
        elif m := re.match(r'^FSHP #\d+ (\S+): .*fsklIndx=(\d+)', line):
            model[m.group(1)] = bones[int(m.group(2))]
    return result


def read_glb(path):
    d = open(path, 'rb').read()
    magic, version, _ = struct.unpack_from('<III', d, 0)
    assert magic == 0x46546C67 and version == 2, path
    jlen, jtype = struct.unpack_from('<II', d, 12)
    assert jtype == 0x4E4F534A
    gltf = json.loads(d[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack_from('<II', d, off)
    assert btype == 0x004E4942
    return gltf, bytearray(d[off + 8: off + 8 + blen])


def write_glb(path, gltf, binary):
    # Assimp가 bufferView 사이 패딩을 초기화하지 않아서 실행마다 결과가 달라짐 → 0으로 채워 재현 가능하게
    used = bytearray(len(binary))
    for v in gltf['bufferViews']:
        start = v.get('byteOffset', 0)
        used[start:start + v['byteLength']] = b'\1' * v['byteLength']
    binary = bytearray(b if u else 0 for b, u in zip(binary, used))
    j = json.dumps(gltf, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    binary = bytes(binary) + b'\0' * (-len(binary) % 4)
    total = 12 + 8 + len(j) + 8 + len(binary)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(j), 0x4E4F534A) + j)
        f.write(struct.pack('<II', len(binary), 0x004E4942) + binary)


def add_image(gltf, binary, name, png):
    binary += b'\0' * (-len(binary) % 4)
    gltf['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(png)})
    binary += png
    gltf['buffers'][0]['byteLength'] = len(binary)
    gltf.setdefault('images', []).append({'name': name, 'mimeType': 'image/png', 'bufferView': len(gltf['bufferViews']) - 1})
    return len(gltf['images']) - 1


def texture_for(gltf, binary, name, tex_dirs):
    """이름으로 텍스처 인덱스를 찾고, 없으면 PNG를 넣어서 만든다."""
    images = gltf.setdefault('images', [])
    img = next((i for i, im in enumerate(images) if im.get('name') in (name, name + '.png')), None)
    if img is None:
        src = next(p for d in tex_dirs if os.path.exists(p := os.path.join(d, name + '.png')))
        img = add_image(gltf, binary, name, open(src, 'rb').read())
    textures = gltf.setdefault('textures', [])
    tex = next((i for i, t in enumerate(textures) if t.get('source') == img), None)
    if tex is None:
        textures.append({'source': img})
        tex = len(textures) - 1
    return tex


def load_animations(bfres):
    """tools/fska_dump(BfresLibrary 사용)로 bfres의 애니메이션 원본 데이터를 읽는다. {skeletal, boneVisibility, shaderParam}"""
    r = subprocess.run(['dotnet', FSKA_DUMP, bfres], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f'fska_dump {bfres} failed:\n{r.stdout}\n{r.stderr}')
    return json.loads(r.stdout)


# BoneAnim 데이터 안의 바이트 오프셋 → (성분, 축). 구조: flags(4) scale(12) translate(12) pad(4) rotate(16)
CURVE_TARGETS = {4: ('scale', 0), 8: ('scale', 1), 12: ('scale', 2),
                 16: ('translate', 0), 20: ('translate', 1), 24: ('translate', 2),
                 32: ('rotate', 0), 36: ('rotate', 1), 40: ('rotate', 2), 44: ('rotate', 3)}


def eval_curve(curve, frame):
    """게임 커브를 frame에서 계산. 키 i 구간의 값 = (c0 + c1·t + c2·t² + c3·t³)·scale + offset, t는 구간 안 0~1"""
    frames, keys = curve['frames'], curve['keys']
    i = max(j for j in range(len(frames)) if frames[j] <= frame) if frame >= frames[0] else 0
    if i == len(frames) - 1 or curve['type'].startswith('Step'):
        return keys[i][0] * curve['scale'] + curve['offset']
    t = (frame - frames[i]) / (frames[i + 1] - frames[i])
    k = keys[i]
    if curve['type'] == 'Cubic':
        v = k[0] + k[1] * t + k[2] * t * t + k[3] * t * t * t
    elif curve['type'] == 'Linear':
        v = k[0] + k[1] * t
    else:
        raise ValueError(curve['type'])
    return v * curve['scale'] + curve['offset']


def euler_xyz_to_quat(x, y, z):
    """X → Y → Z 순서로 도는 오일러 각(라디안) → 쿼터니언 [x, y, z, w]"""
    cx, sx, cy, sy, cz, sz = math.cos(x / 2), math.sin(x / 2), math.cos(y / 2), math.sin(y / 2), math.cos(z / 2), math.sin(z / 2)
    return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz]


def matrix_to_trs(m):
    """glTF 열 우선 4x4 행렬 → (translation, rotation[x,y,z,w], scale). 전단(shear) 없음을 가정"""
    cols = [m[0:3], m[4:7], m[8:11]]
    scale = [math.sqrt(sum(c * c for c in col)) for col in cols]
    r = [[cols[j][i] / scale[j] for j in range(3)] for i in range(3)]  # r[행][열]
    tr = r[0][0] + r[1][1] + r[2][2]
    if tr > 0:
        s = math.sqrt(tr + 1) * 2
        q = [(r[2][1] - r[1][2]) / s, (r[0][2] - r[2][0]) / s, (r[1][0] - r[0][1]) / s, s / 4]
    elif r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        s = math.sqrt(1 + r[0][0] - r[1][1] - r[2][2]) * 2
        q = [s / 4, (r[0][1] + r[1][0]) / s, (r[0][2] + r[2][0]) / s, (r[2][1] - r[1][2]) / s]
    elif r[1][1] > r[2][2]:
        s = math.sqrt(1 + r[1][1] - r[0][0] - r[2][2]) * 2
        q = [(r[0][1] + r[1][0]) / s, s / 4, (r[1][2] + r[2][1]) / s, (r[0][2] - r[2][0]) / s]
    else:
        s = math.sqrt(1 + r[2][2] - r[0][0] - r[1][1]) * 2
        q = [(r[0][2] + r[2][0]) / s, (r[1][2] + r[2][1]) / s, s / 4, (r[1][0] - r[0][1]) / s]
    return list(m[12:15]), q, scale


def add_accessor(gltf, binary, values, kind):
    """float 배열을 버퍼에 넣고 accessor 인덱스를 돌려준다. kind: SCALAR / VEC3 / VEC4"""
    width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[kind]
    flat = [x for v in values for x in (v if width > 1 else [v])]
    binary += b'\0' * (-len(binary) % 4)
    gltf['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': 4 * len(flat)})
    binary += struct.pack(f'<{len(flat)}f', *flat)
    gltf['buffers'][0]['byteLength'] = len(binary)
    accessor = {'bufferView': len(gltf['bufferViews']) - 1, 'componentType': 5126, 'count': len(values), 'type': kind}
    if kind == 'SCALAR':
        accessor.update(min=[min(values)], max=[max(values)])
    gltf['accessors'].append(accessor)
    return len(gltf['accessors']) - 1


def sample_frames(frame_count):
    return [i / ANIM_SAMPLES_PER_FRAME for i in range(int(frame_count * ANIM_SAMPLES_PER_FRAME) + 1)]


def animation_names(stem):
    return ANIMATIONS + next((v for prefix, v in ANIMATIONS_BY_PREFIX.items() if stem.startswith(prefix)), ())


def add_animations(gltf, binary, anims, names):
    """게임 스켈레탈 애니메이션을 glTF 애니메이션으로. 커브가 있는 본만 넣고(여러 애니메이션을 동시에 재생해도 서로 덮어쓰지 않게),
    그 본의 T/R/S는 커브가 없는 성분도 애니메이션 기준값으로 채운다 (기준값이 바인드 자세와 조금 다를 수 있음)"""
    joints = {node['name']: i for i, node in enumerate(gltf['nodes']) if 'mesh' not in node}
    for name in names:
        anim = anims['skeletal'].get(name)
        if anim is None:
            continue
        assert anim['flagsRotate'] == 'EulerXYZ', anim['flagsRotate']
        # 모델에 없는 본은 움직일 대상이 없으므로 무시 (예: 오더 롤러에는 Bench가 없음)
        bones = {b: d for b, d in anim['bones'].items() if b in joints and d['curves']}
        if not bones:
            continue
        frames = sample_frames(anim['frameCount'])
        times = add_accessor(gltf, binary, [f / 60 for f in frames], 'SCALAR')
        channels, samplers = [], []
        for bone, data in bones.items():
            node = gltf['nodes'][joints[bone]]
            bind_t, bind_r, bind_s = node['translation'], node['rotation'], node['scale']
            base = {'scale': data['baseScale'] if 'Scale' in data['flagsBase'] else bind_s,
                    'translate': data['baseTranslate'] if 'Translate' in data['flagsBase'] else bind_t,
                    'rotate': data['baseRotate'][:3] if 'Rotate' in data['flagsBase'] else None}
            curves = [(CURVE_TARGETS[c['target']], c) for c in data['curves']]
            samples = {'scale': [], 'translate': [], 'rotate': []}
            for f in frames:
                v = {k: list(base[k]) if base[k] is not None else None for k in base}
                for (comp, axis), c in curves:
                    v[comp][axis] = eval_curve(c, f)
                samples['scale'].append(v['scale'])
                samples['translate'].append(v['translate'])
                samples['rotate'].append(euler_xyz_to_quat(*v['rotate']) if v['rotate'] is not None else bind_r)
            for comp, path, kind in (('translate', 'translation', 'VEC3'), ('rotate', 'rotation', 'VEC4'), ('scale', 'scale', 'VEC3')):
                samplers.append({'input': times, 'output': add_accessor(gltf, binary, samples[comp], kind), 'interpolation': 'LINEAR'})
                channels.append({'sampler': len(samplers) - 1, 'target': {'node': joints[bone], 'path': path}})
        gltf.setdefault('animations', []).append({'name': name, 'channels': channels, 'samplers': samplers})


def add_visibility_animations(gltf, anims, shape_bones, names):
    """본 보임/숨김 애니메이션 → 그 본에 붙은 메시 노드의 extras.s3.visibility[애니메이션] = [[초, 보임], ...]
    (glTF에는 보임/숨김 애니메이션이 없어서 뷰어가 재생 시 트랙으로 만든다. 예: 와이드 롤러를 접으면 빨대가 바뀜)
    마지막 키 뒤에 애니메이션 끝(frameCount)까지 값을 유지하는 키를 넣는다. 반복 재생할 때 길이가 게임과 같게 (예: 이그재미너 Shot은 22프레임까지만 키가 있고 길이는 72)"""
    for name in names:
        anim = anims['boneVisibility'].get(name)
        if anim is None:
            continue
        for curve in anim['curves']:
            keys = [[f / 60, v] for f, v in zip(curve['frames'], curve['values'])]
            if curve['frames'][-1] < anim['frameCount']:
                keys.append([anim['frameCount'] / 60, curve['values'][-1]])
            for node in gltf['nodes']:
                if 'mesh' in node and shape_bones[node['name']] == curve['bone']:
                    node.setdefault('extras', {}).setdefault('s3', {}).setdefault('visibility', {})[name] = keys


def material_param_animations(anims, material, names):
    """머티리얼의 셰이더 파라미터 애니메이션 → {애니메이션: {loop, duration, tracks: [{param, target, times, values}]}}
    target은 파라미터 안의 바이트 오프셋 (예: emission_intensity 0, tex_mtx0의 이동 X 16)"""
    result = {}
    for name, anim in anims['shaderParam'].items():
        if name not in names and not name.endswith('_auto'):
            continue
        frames = sample_frames(anim['frameCount'])
        tracks = [{'param': p['param'], 'target': c['target'], 'times': [f / 60 for f in frames], 'values': [eval_curve(c, f) for f in frames]}
                  for mat, params in anim['materials'].items() if mat.lower() == material.lower()  # 히어로 슈터는 애니메이션 쪽 이름이 M_body (모델은 M_Body)
                  for p in params for c in p['curves']]
        if tracks:
            result[name] = {'loop': anim['loop'], 'duration': anim['frameCount'] / 60, 'tracks': tracks}
    return result


def mirror_x(gltf, binary):
    """gltf/binary를 X축 대칭으로 바꾼다 (제자리 수정). 정점·노멀·탄젠트 x 반전, 탄젠트 w 반전(bitangent 방향 유지), 삼각형 감기 순서 반전,
    노드 TRS, 애니메이션 키, inverse bind matrix는 S·M·S (S = diag(-1, 1, 1))로 바꿔서 스켈레톤도 같은 거울상이 되게 한다."""

    def view(acc):
        a = gltf['accessors'][acc]
        v = gltf['bufferViews'][a['bufferView']]
        return a, v.get('byteOffset', 0) + a.get('byteOffset', 0), v.get('byteStride')

    def negate_floats(acc, comps):
        a, base, stride = view(acc)
        assert a['componentType'] == 5126
        width = {'VEC3': 3, 'VEC4': 4}[a['type']]
        stride = stride or 4 * width
        for i in range(a['count']):
            for c in comps:
                off = base + i * stride + 4 * c
                struct.pack_into('<f', binary, off, -struct.unpack_from('<f', binary, off)[0])
        return a

    positions, normals, tangents, indices = set(), set(), set(), set()
    for mesh in gltf['meshes']:
        for p in mesh['primitives']:
            assert p.get('mode', 4) == 4 and 'targets' not in p and 'indices' in p
            positions.add(p['attributes']['POSITION'])
            normals.add(p['attributes'].get('NORMAL'))
            tangents.add(p['attributes'].get('TANGENT'))
            indices.add(p['indices'])
    for acc in positions:
        a = negate_floats(acc, [0])
        a['min'][0], a['max'][0] = -a['max'][0], -a['min'][0]
    for acc in normals - {None}:
        negate_floats(acc, [0])
    for acc in tangents - {None}:
        negate_floats(acc, [0, 3])
    for acc in indices:
        a, base, stride = view(acc)
        fmt, size = {5121: ('B', 1), 5123: ('H', 2), 5125: ('I', 4)}[a['componentType']]
        assert stride in (None, size) and a['count'] % 3 == 0
        for t in range(0, a['count'], 3):
            o1, o2 = base + (t + 1) * size, base + (t + 2) * size
            i1, i2 = struct.unpack_from('<' + fmt, binary, o1)[0], struct.unpack_from('<' + fmt, binary, o2)[0]
            struct.pack_into('<' + fmt, binary, o1, i2)
            struct.pack_into('<' + fmt, binary, o2, i1)

    for node in gltf['nodes']:
        node['translation'][0] *= -1
        x, y, z, w = node['rotation']
        node['rotation'] = [x, -y, -z, w]
    # 애니메이션 키도 노드와 같은 규칙: 이동 x 반전, 회전 쿼터니언 y·z 반전 (출력 accessor는 채널마다 따로 만들어짐)
    flips = {'translation': [0], 'rotation': [1, 2]}
    outputs = {}
    for anim in gltf.get('animations', []):
        for ch in anim['channels']:
            path = ch['target']['path']
            if path in flips:
                acc = anim['samplers'][ch['sampler']]['output']
                assert outputs.setdefault(acc, path) == path
    for acc, path in outputs.items():
        negate_floats(acc, flips[path])
    for skin in gltf.get('skins', []):
        a, base, stride = view(skin['inverseBindMatrices'])
        assert a['componentType'] == 5126 and a['type'] == 'MAT4' and stride in (None, 64)
        for i in range(a['count']):
            for col in range(4):
                for row in range(4):
                    if (row == 0) != (col == 0):
                        off = base + 64 * i + 4 * (col * 4 + row)
                        struct.pack_into('<f', binary, off, -struct.unpack_from('<f', binary, off)[0])


def build_file(bfres, out_dir, work):
    stem = os.path.basename(bfres)[:-len('.bfres')]
    base = re.sub(r'_Cstm\d+$', '', stem)
    base_bfres = os.path.join(os.path.dirname(bfres), base + '.bfres')
    models = parse_info(run('info', bfres))

    tex_dirs = [os.path.join(work, 'tex', stem)]
    run('textures', bfres, '-o', tex_dirs[0])
    extra = []
    if base != stem:
        tex_dirs.append(os.path.join(work, 'tex', base))
        if not os.path.isdir(tex_dirs[1]):
            run('textures', base_bfres, '-o', tex_dirs[1])
        extra = ['--textures', base_bfres]

    anims = load_animations(bfres)
    names = animation_names(stem)
    if base != stem and not any(anims.values()):
        anims = load_animations(base_bfres)

    results = []
    for model, mats in models.items():
        tmp = os.path.join(work, model + '.glb')
        out_text = run('convert', bfres, '-m', model, '-o', tmp, '--mat-info', '--debug', *extra)
        mat_info = parse_mat_info(out_text)
        shapes = parse_shape_visibility(out_text)[model]
        shape_bones = {shape: bone for shape, (_, bone) in shapes.items()}
        gltf, binary = read_glb(tmp)
        deg = next((v for prefix, v in ROTATE_Y.items() if model.startswith(prefix)), None)
        if deg is not None:
            [root_index] = gltf['scenes'][0]['nodes']
            root = gltf['nodes'][root_index]
            assert not ({'rotation', 'matrix'} & root.keys()), model
            half = math.radians(deg) / 2
            root['rotation'] = [0, math.sin(half), 0, math.cos(half)]
        # 애니메이션 대상 노드는 행렬 대신 T/R/S여야 함 (glTF 규칙). 다른 노드도 일관되게 바꿈
        for node in gltf['nodes']:
            if 'matrix' in node:
                node['translation'], node['rotation'], node['scale'] = matrix_to_trs(node.pop('matrix'))
            node.setdefault('translation', [0, 0, 0])
            node.setdefault('rotation', [0, 0, 0, 1])
            node.setdefault('scale', [1, 1, 1])
        add_animations(gltf, binary, anims, names)
        add_visibility_animations(gltf, anims, shape_bones, names)
        for node in gltf['nodes']:
            if 'mesh' in node and not shapes[node['name']][0]:
                node.setdefault('extras', {}).setdefault('s3', {})['hidden'] = True
        for mat in gltf.get('materials', []):
            name = mat['name']
            info = mat_info[name]
            textures = {}
            for shader_sampler, mat_sampler in info['samplers'].items():
                if mat_sampler in mats[name]:
                    tex_name = mats[name][mat_sampler]
                    textures[shader_sampler] = {'index': texture_for(gltf, binary, tex_name, tex_dirs), 'name': tex_name}
            s3 = {'shader': info['shader'], 'textures': textures, 'options': info['options']}
            render, params, opts = info['render'], info['params'], info['options']
            used = {}
            if render['gsys_render_state_mode'] != 'opaque':  # translucent / mask / custom
                s3['render'] = {
                    'mode': render['gsys_render_state_mode'],
                    'blend': render['gsys_render_state_blend_mode'] != 'none',
                    'depth_write': render['gsys_depth_test_write'] == 'true',
                    'alpha_test': float(render['gsys_alpha_test_value']) if render['gsys_alpha_test_enable'] == 'true' else None,
                }
                used['opacity'] = params['opacity'][0]
            if opts.get('enable_emission') == 'True':
                used['emission_intensity'] = params['emission_intensity'][0]
                used['emission_color'] = params['emission_color'][:3]
            if opts.get('enable_manual_fresnel') == 'True':
                used['manual_fresnel'] = params['manual_fresnel'][0]
                used['manual_fresnel_color'] = params['manual_fresnel_color'][:3]
            if used:
                s3['params'] = used
            if param_anims := material_param_animations(anims, name, names):
                s3['param_anims'] = param_anims
            mat.setdefault('extras', {})['s3'] = s3
            # 표준 슬롯도 셰이더 샘플러 기준으로 채운다 (BfrAss는 공유/외부 텍스처일 때 비워둠)
            pbr = mat.setdefault('pbrMetallicRoughness', {})
            pbr.pop('baseColorTexture', None)
            mat.pop('normalTexture', None)
            if '_a0' in textures:
                pbr['baseColorTexture'] = {'index': textures['_a0']['index']}
            if '_n0' in textures:
                mat['normalTexture'] = {'index': textures['_n0']['index']}
        out = os.path.join(out_dir, model + '.glb')
        write_glb(out, gltf, binary)
        results.append((model, os.path.getsize(out)))
        if model.startswith(MIRROR_L) and not model.endswith('_L') and model + '_L' not in models:
            mirror_x(gltf, binary)
            out = os.path.join(out_dir, model + '_L.glb')
            write_glb(out, gltf, binary)
            results.append((model + '_L', os.path.getsize(out)))
    return results


if __name__ == '__main__':
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    pattern = sys.argv[3] if len(sys.argv) > 3 else 'Wmn_*.bfres.zs'
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix='s3glb_')
    bfres_dir = os.path.join(work, 'bfres')
    os.makedirs(bfres_dir)
    # 기본 무기 텍스처를 찾을 수 있도록, 대상 파일을 모두 먼저 해제해 둔다
    names = sorted(f for f in os.listdir(src_dir) if fnmatch.fnmatch(f, pattern))
    dctx = zstandard.ZstdDecompressor()
    for f in names:
        with open(os.path.join(src_dir, f), 'rb') as src:
            open(os.path.join(bfres_dir, f[:-len('.zs')]), 'wb').write(dctx.decompress(src.read()))
    total = 0
    for f in names:
        for model, size in build_file(os.path.join(bfres_dir, f[:-len('.zs')]), out_dir, work):
            total += size
            print(f'{model}.glb {size // 1024} KB')
    print(f'{len(names)} files, total {total / 2**20:.1f} MB')
