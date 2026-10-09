"""스플래툰 3 무기 모델(bfres.zs) → 모델별 독립 glb 변환.

- 컬래버(_CstmNN) 파일이 기본 무기의 텍스처를 참조하면, 그 텍스처를 복사해 넣어서 glb 하나로 완결되게 만든다.
- bfres 하나에 모델이 여러 개면(예: 우산+케이스, 듀얼 좌우) 모델마다 glb를 따로 만든다.
- 머티리얼마다 셰이더 샘플러(_a0, _n0, _su0 …) → 텍스처 매핑과 셰이더 옵션을 material.extras.s3에 넣는다.
  불투명이 아니면 render state(블렌딩, 깊이 쓰기, alpha test)도, 뷰어가 쓰는 파라미터(opacity, emission, manual fresnel)는 params에 넣는다.
- 게임 render info와 샘플러 설정을 glTF 표준 필드로 옮긴다: 양면(doubleSided), 텍스처 wrap/filter(samplers).
- 1채널 텍스처(R=G=B=A인 PNG)는 회색 PNG로 다시 쓴다 (무손실, 용량만 줄어듦). 정점 컬러는 넣지 않는다 (무기 셰이더가 안 읽음).
- 무기군별 기본 방향 보정(ROTATE_Y)을 루트 노드 회전으로 넣는다.
- 기본 무기 bfres의 스켈레탈 애니메이션 중 ANIMATIONS(롤러 접기/펴기 등)를 glTF 애니메이션으로 넣는다 (tools/fska_dump 필요).
- 붙은 본이 invisible인 셰이프는 node.extras.s3.hidden = true로 표시한다 (게임에서 기본으로 숨겨진 부품).
- MIRROR_L 무기군은 왼손 모델(_L)이 bfres에 없으면 오른손 모델을 X축 대칭시켜 <모델>_L.glb로 만든다.

usage: python build_glb.py <Model 폴더> <출력 폴더> [파일 패턴, 기본 Wmn_*.bfres.zs]
환경 변수 BFRASS로 bfrass 실행 파일 경로를 지정할 수 있다 (기본: PATH의 bfrass).
"""
import fnmatch, json, math, os, re, struct, subprocess, sys, tempfile, zlib
import zstandard
import add_s3_params  # 같은 폴더

BFRASS = os.environ.get('BFRASS', 'bfrass')
FSKA_DUMP = os.environ.get('FSKA_DUMP', os.path.join(os.path.dirname(__file__), 'fska_dump', 'out', 'fska_dump.dll'))
DEFAULT = '<Default Value>'
RENDER_KEYS = {'gsys_render_state_mode', 'gsys_render_state_blend_mode', 'gsys_depth_test_write', 'gsys_alpha_test_enable', 'gsys_alpha_test_value',
               'gsys_render_state_display_face', 'gsys_dynamic_depth_shadow_only'}
# 무기군별 기본 방향 보정: 수직축(Y) 회전 각도(도). 뷰어 기본 카메라에서 정면이 보이도록 루트 노드에 회전만 넣는다 (정점은 그대로)
ROTATE_Y = {'Wmn_Roller_': 90, 'Wmn_Stringer_': 180}
# glb에 넣을 애니메이션 (롤러 접기/펴기, 쿠마 롤러 엔진, 소방 FF 사격 모드 전환 등). 컬래버 파일은 애니메이션이 없어서 기본 무기 것을 쓴다 (본 구성이 같음)
# 셰이더 파라미터 애니메이션은 이 이름들 + 이름이 '_auto'로 끝나는 것(게임이 자동 재생, 예: 히어로 슈터 발광)
ANIMATIONS = ('Open', 'Close', 'Open_Loop', 'Shot_Long_St', 'Shot_Short_St')
# 무기군별로 더 넣는 애니메이션. 이름이 다른 무기군과 겹쳐서(블래스터도 Shot이 있음) 무기군을 정해서 넣는다
# 스피너: 쿠겔 슈라이버 'Deform'(본·tex_mtx1)·'DeformEmm'(발광), 이그재미너 'Shot'(카트리지 보임/숨김 반복)
# 차저: 소이 튜버·스퀵 클린 차지 발광 (게임 액터의 AS가 'Charge'로 이 애니메이션을 가리킴. 다른 차저 액터에는 없음),
#       R-PEN 'Shot'(Bullet 본 반동)·'Bullet'(Bullet01~05 보임/숨김)
# 블래스터: 'Shot'(본 반동, 라이트·쇼트는 M_Body 발광도), 프리시전 'JumpShot'.
#         쇼트의 'Wait'·'Wmn_Blaster_Short'(반복)은 넣지 않음: 본 커브가 없고, 발광을 바꾸는 M_Glass는 emission이 꺼져 있고 M_GlassInv는 모델에 없음
# 붓: 빈센트 'TransformToAttack'/'TransformToWait'(Head 본을 대기 자세 ↔ 공격 자세로), 'Attack'(공격 자세에서 시작하고 끝나는 흔들림).
#     빈센트 'Wait'은 본 커브가 없어서 넣지 않음
# 슬로셔: 베어표 'Wmn_Slosher_Coop'(M_Body 발광 + tex_mtx1, 게임 액터 AS의 'Swing'이 가리킴). 익스플로셔 발광은 '_auto'로 들어감
# 셸터: 'Fly'(사출한 우산막이 날아가는 동안 반복. 파라·캠핑·도돌이·오더에만 있음, 스파이 가젯·베어표에는 없음)
# 스트링거: 'Default'(대기), 'Charge'(세로 차지), 'ChargeWidth'(가로 차지), 'Shoot'(발사). 본 + M_Body·M_String 발광 + M_String tex_mtx0.
#          베어표는 M_Receiver 발광 'Charge_Light'(반복)·'Shoot_Light'도. 게임 AS(WeaponStringer.root.asb)에 이 이름들과 변수 ChargeRate·TiltDeg가 있음
# 와이퍼: 'Charge'(반복)·'Shot'(사무·베어표: Wave 본 + StampA/B 보임/숨김 + M_Stamp tex_mtx0, 베어표는 M_Coil 발광도. 드라이브: Body·Blade 본),
#         드라이브 'Wmn_Saber_Light_Charge'(M_Body_Tube 발광 + tex_mtx1, 100프레임에 걸쳐 차오르고 유지),
#         덴탈 'Charge_SberHeavy00_St'(차지 시작)·'Charge_SberHeavy00'(반복)·'ChargeAttack_SberHeavy00'(차지 공격, 10~66프레임 Case 숨김).
#         덴탈 'Step_SberHeavy00'은 사용자가 요청한 기본/차지/공격에 없어서 넣지 않음. 덴탈 'Shot'은 본 커브가 없고 M_Stamp도 없음
# 서브(Wsb_)·스페셜(Wsp_): 파일에 있는 애니메이션 전부 (animlist 조사, Claude Handover/tools/animlist/animlist_sub_special.txt). 파일에 없는 이름은 건너뜀.
#   빼는 것: 'MicroLaserBitAll_Start'(다른 모델 Wsp_MicroLaserBitAll의 본, 메시 없음), 'test'(메가폰 레이저 Firing과 같은 본의 개발용 이름)
ANIMATIONS_BY_PREFIX = {'Wmn_Spinner_': ('Deform', 'DeformEmm', 'Shot'),
                        'Wmn_Charger_': ('Wmn_Charger_Keeper_Charge', 'Wmn_Charger_Quick_Charge', 'Shot', 'Bullet'),
                        'Wmn_Blaster_': ('Shot', 'JumpShot'),
                        'Wmn_Brush_': ('TransformToAttack', 'TransformToWait', 'Attack'),
                        'Wmn_Slosher_': ('Wmn_Slosher_Coop',),
                        'Wmn_Shelter_': ('Fly',),
                        'Wmn_Stringer_': ('Default', 'Charge', 'ChargeWidth', 'Shoot', 'Charge_Light', 'Shoot_Light', 'Shop_Wait_Strn'),  # Shop_Wait_Strn: 캐릭터가 들 때 무기 자세 (뷰어 holdWeapons)
                        'Wmn_Saber_': ('Charge', 'Shot', 'Wmn_Saber_Light_Charge', 'Charge_SberHeavy00_St', 'Charge_SberHeavy00', 'ChargeAttack_SberHeavy00'),
                        'Wsb_': ('Active', 'Fly', 'Held', 'Held_fsp', 'Held_fts', 'Jump', 'Reset', 'Scale', 'Shake', 'Sleep', 'Start', 'Start_Sway', 'Wait', 'Walk',
                                 'Warning', 'Warning_Fly', 'Warning_fsp', 'Wide', 'Wsb_Bomb_Curling_Rvl_auto', 'Wsb_Bomb_Curling_auto', 'Wsb_Bomb_Handy_Msn_auto',
                                 'Wsb_Bomb_Handy_auto', 'Wsb_Bomb_Msn1Lv1_auto', 'Wsb_Bomb_Msn1Lv2_auto', 'Wsb_Bomb_Msn1Lv3_auto', 'Wsb_Bomb_Tako', 'Wsb_Sprinkler_auto',
                                 'signal', 'transform', 'wait'),
                        'Wsp_': ('Activate', 'Activate_Drone', 'Activate_Loop', 'Appear', 'Attack', 'BreakSign', 'Caution', 'Charge', 'Close', 'Disapear', 'EmptySign',
                                 'Firing', 'Open', 'PreAciton', 'Return', 'Shake', 'ShootBullet', 'ShootCannonball', 'ShootCannonballDwn', 'ShootCannonballMdl',
                                 'ShootCannonballUp', 'Shot', 'Shot_End', 'Skewer_Invocation', 'Skewer_Jump', 'Skewer_Jump_Ed', 'Skewer_Run', 'Smash',
                                 'Sp_PreStart_Pogo_L', 'Sp_PreStart_Pogo_R', 'Sp_Start_Pogo_L', 'Sp_Start_Pogo_L_Ed', 'Sp_Start_Pogo_L_St', 'Sp_Start_Pogo_R',
                                 'Sp_Start_Pogo_R_Ed', 'Sp_Start_Pogo_R_St', 'Sp_Start_Skewer', 'Sphere', 'Throw', 'ThrowBomb_BothHandsShort', 'TransformCrab',
                                 'TransformSphere', 'Turn', 'Wait', 'WaitHold', 'Wait_Drone', 'WalkB', 'WalkBackward', 'WalkF', 'WalkForward', 'WalkL', 'WalkR',
                                 'Warning', 'Wsp_Blower', 'Wsp_TripleTornado_Auto', 'Wsp_UltraShot_Cartridge', 'signal', 'wait')}
# 커브가 없어도 기준값이 바인드 자세와 다른 본을 넣는 무기군 (게임은 커브가 없는 본에도 애니메이션 기준값을 씀.
# 예: 플루이드 V·LACT-450의 Charge는 커브 없이 Piston·ReelT·ReelU 기준값만 다름). 다른 무기군은 다시 변환하면 결과가 바뀔 수 있어서 확인한 무기군만
STATIC_BONE_PREFIXES = ('Wmn_Stringer_', 'Wsb_', 'Wsp_')  # 서브·스페셜은 새로 넣는 거라 처음부터 게임 식으로
# 그래도 빼는 본: {모델: {(애니메이션, 본)}}. 탄산 밤 Warning의 Handle은 커브 없이 기준값만 있는데 위치가 바인드의 100배(-28.286 vs -0.283)라
# 단위 실수로 보임. 넣으면 손잡이가 멀리 날아감 (사용자 확인: 게임에선 안 그럼). 빼면 바인드 위치 + 부모(Scale) 스케일 비율만큼 움직임
STATIC_BONE_SKIP = {'Wsb_Bomb_Piyo': {('Warning', 'Handle')}}
# 정적 tex_mtx0·1(SRT)을 material.extras.s3.tex_srt에 넣는 무기군. 뷰어는 tex_srt가 있으면 게임 식(g3d Maya)으로 UV를 바꿈
# (예: 와이퍼 M_Stamp는 세로 4배라 이걸 안 하면 stamp에 2cl 칠 영역이 안 걸림). 이동 애니메이션의 X 부호도 게임 식을 따르게 되므로 확인한 무기군만
TEX_SRT_PREFIXES = ('Wmn_Saber_', 'Wsb_', 'Wsp_')  # 서브·스페셜: 컬링 밤 M_Body tex_mtx1 X 30배 (Resource0 줄무늬, Held_fts가 이동)
# 정점 컬러를 넣는 모델: 셰이더가 정점 입력으로 읽음 (decompile: 스플래터컬러 스크린 막 M_Wall, 정점 물결 = 물결 맵 × aColor.z)
VERTEX_COLOR_MODELS = ('Wsp_ChimneyWall',)
# 본 flags의 Segment Scale Compensate 비트 (무기 스켈레톤은 스케일 모드 Maya)
SSC_FLAG = 1 << 23
ANIM_SAMPLES_PER_FRAME = 2  # 게임 커브(cubic)를 이 간격으로 샘플링해서 glTF linear 키로 넣음 (게임 60fps 기준 프레임)
# nn::gfx 샘플러 wrap → glTF (BfresLibrary SamplerSwitch.TexClamp: Repeat, Mirror, Clamp(to edge). 무기에는 이 셋만 있음)
GL_WRAP = {0: 10497, 1: 33648, 2: 33071}
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
    """--mat-info 출력 → {material: {'shader': str, 'render': {k: str}, 'params': {k: [float]}, 'samplers': {shader_sampler: mat_sampler},
    'attributes': {shader_attribute: vertex_attribute}, 'options': {k: v}}}"""
    mats, cur = {}, None
    for line in text.splitlines():
        if m := re.match(r'^Texture properties for (\S+):', line):
            cur = mats.setdefault(m.group(1), {'shader': None, 'render': {}, 'params': {}, 'samplers': {}, 'attributes': {}, 'options': {}, 'tex_srt': {}})
        elif cur is None:
            continue
        elif (m := re.match(r'^  (gsys_\w+): (.+)', line)) and m.group(1) in RENDER_KEYS:
            cur['render'][m.group(1)] = m.group(2)
        elif m := re.match(r'^Shader: (.+)', line):
            cur['shader'] = m.group(1)
        # 숫자 파라미터는 전부 (tex_mtx 같은 SRT 값은 제외). 일부만 저장했더니 transmission 키를 읽을 때 KeyError가 났음
        elif m := re.match(r'^(\w+): (-?[\d.]+(?:e[-+]?\d+)?(?:, -?[\d.]+(?:e[-+]?\d+)?)*)$', line):
            cur['params'][m.group(1)] = [float(x) for x in m.group(2).split(', ')]
        elif m := re.match(r'^(tex_mtx[0-2]): Scale X = (\S+), Y = (\S+) \| Rotate = (\S+) \| Translation X = (\S+), Y = (\S+) \| Axis: (.+)$', line):
            sx, sy, rot, tx, ty = map(float, m.group(2, 3, 4, 5, 6))
            cur['tex_srt'][m.group(1)] = {'mode': m.group(7), 'scale': [sx, sy], 'rotate': rot, 'translate': [tx, ty]}
        elif (m := re.match(r'^  sampler (\S+) = (.+)', line)) and m.group(2) != DEFAULT:
            cur['samplers'][m.group(1)] = m.group(2)
        elif (m := re.match(r'^  attribute (\S+) = (.+)', line)) and m.group(2) != DEFAULT:
            cur['attributes'][m.group(1)] = m.group(2)
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


def texture_for(gltf, binary, name, tex_dirs, sampler):
    """이름과 glTF 샘플러로 텍스처 인덱스를 찾고, 없으면 만든다 (이미지가 없으면 PNG를 넣음).
    glTF 텍스처는 (이미지, 샘플러) 쌍이라, 같은 이미지라도 샘플러가 다르면 따로 만든다."""
    images = gltf.setdefault('images', [])
    img = next((i for i, im in enumerate(images) if im.get('name') in (name, name + '.png')), None)
    if img is None:
        src = next(p for d in tex_dirs if os.path.exists(p := os.path.join(d, name + '.png')))
        img = add_image(gltf, binary, name, open(src, 'rb').read())
    samplers = gltf.setdefault('samplers', [])
    if sampler not in samplers:
        samplers.append(sampler)
    textures = gltf.setdefault('textures', [])
    key = {'source': img, 'sampler': samplers.index(sampler)}
    if key not in textures:
        textures.append(key)
    return textures.index(key)


def material_samplers(bfres, debug_text, model):
    """bfres v10 FMAT의 샘플러 설정(nn::gfx SamplerInfo) → {머티리얼: {머티리얼 샘플러 이름: glTF sampler}}.
    BfrAss는 이 값을 읽기만 하고 출력하지 않아서 직접 읽는다 (배치는 BfrAss SwitchLoader::loadMaterialV10·loadSamplers와 같음).
    FMAT 위치는 --debug의 FMDL 줄(fmatArray, fmatCount)에서, FMAT 하나는 0xB0바이트"""
    b = open(bfres, 'rb').read()
    u16 = lambda o: struct.unpack_from('<H', b, o)[0]
    u64 = lambda o: struct.unpack_from('<Q', b, o)[0]
    string = lambda o: b[o + 2:o + 2 + u16(o)].decode()
    m = re.search(rf'^FMDL: name={re.escape(model)} .*fmatArray=0x([0-9A-F]+) .*fmatCount=(\d+)', debug_text, re.M)
    result = {}
    for i in range(int(m.group(2))):
        o = int(m.group(1), 16) + 0xB0 * i
        assert b[o:o + 4] == b'FMAT', hex(o)
        array, dic, count = u64(o + 0x30), u64(o + 0x38), b[o + 0xA2]
        names = [string(u64(dic + 8 + 16 * (k + 1) + 8)) for k in range(count)]  # ResDic 노드 16바이트, 0번은 루트
        result[string(u64(o + 8))] = {names[k]: gltf_sampler(b[array + 32 * k: array + 32 * k + 32]) for k in range(count)}
    return result


def gltf_sampler(info):
    """SamplerInfo 32바이트 → glTF sampler. filter 비트: 밉 0-1, 확대 2-3, 축소 4-5 (1 point, 2 linear. 밉 0은 밉맵 없음)"""
    wrap_u, wrap_v, _, compare, _, _, flt = struct.unpack_from('<6BH', info)
    # LOD bias(와이퍼 M_Stamp 2cl −1), 1 이상인 최대 LOD(오더 브러시 M_Plastic 2cl 10), 최소 LOD(캐릭터 몸 Player00 1)는 glTF·WebGL에 넣을 자리가 없어서 버림
    min_lod, max_lod, _ = struct.unpack_from('<3f', info, 8)
    assert compare == 0, compare
    mip, mag, shrink = flt & 3, flt >> 2 & 3, flt >> 4 & 3
    # 최대 LOD < 0.5에 밉 point면 늘 밉 0만 씀 = 밉맵 없음 (크래시 블래스터 M_Body_Alb 0.4)
    if max_lod < 0.5:
        assert mip == 1, (mip, max_lod)
        mip = 0
    min_filter = {(1, 0): 9728, (2, 0): 9729, (1, 1): 9984, (2, 1): 9985, (1, 2): 9986, (2, 2): 9987}[shrink, mip]
    return {'magFilter': {1: 9728, 2: 9729}[mag], 'minFilter': min_filter, 'wrapS': GL_WRAP[wrap_u], 'wrapT': GL_WRAP[wrap_v]}


def decode_png(data):
    """8비트 non-interlaced PNG → (가로, 세로, 채널 수, 픽셀 bytes)"""
    w, h, depth, ctype, _, _, interlace = struct.unpack_from('>IIBBBBB', data, 16)
    assert data[:8] == b'\x89PNG\r\n\x1a\n' and depth == 8 and interlace == 0
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    idat, p = b'', 8
    while p < len(data):
        n, kind = struct.unpack_from('>I4s', data, p)
        if kind == b'IDAT':
            idat += data[p + 8:p + 8 + n]
        p += 12 + n
    raw, stride = zlib.decompress(idat), w * ch
    out, prev = bytearray(), bytearray(stride)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - ch] if i >= ch else 0
            c = prev[i - ch] if i >= ch else 0
            if f == 1:
                line[i] = line[i] + a & 255
            elif f == 2:
                line[i] = line[i] + prev[i] & 255
            elif f == 3:
                line[i] = line[i] + (a + prev[i] >> 1) & 255
            elif f == 4:
                pa, pb, pc = abs(prev[i] - c), abs(a - c), abs(a + prev[i] - 2 * c)
                line[i] = line[i] + (a if pa <= pb and pa <= pc else prev[i] if pb <= pc else c) & 255
        out += line
        prev = line
    return w, h, ch, bytes(out)


def encode_gray_png(px, w, h):
    """8비트 회색 PNG. 줄마다 필터 5종 중 절댓값 합이 가장 작은 것 (BfrAss와 같은 방식), zlib 9"""
    raw, prev = bytearray(), bytes(w)
    for y in range(h):
        row = px[y * w:(y + 1) * w]
        left, upleft = bytes(1) + row[:-1], bytes(1) + prev[:-1]
        def paeth(a, b, c):
            pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
            return a if pa <= pb and pa <= pc else b if pb <= pc else c
        candidates = (row, bytes(x - a & 255 for x, a in zip(row, left)), bytes(x - b & 255 for x, b in zip(row, prev)),
                      bytes(x - (a + b >> 1) & 255 for x, a, b in zip(row, left, prev)),
                      bytes(x - paeth(a, b, c) & 255 for x, a, b, c in zip(row, left, prev, upleft)))
        best = min(range(5), key=lambda f: sum(v if v < 128 else 256 - v for v in candidates[f]))
        raw.append(best)
        raw += candidates[best]
        prev = row
    chunk = lambda kind, body: struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def gray_png(png):
    """BC4 1채널 텍스처는 채널 매핑이 RRRR라서 BfrAss가 R=G=B=A인 RGBA PNG로 쓴다 (R=G=B인 RGB도 있음).
    게임 셰이더는 이 텍스처들의 x만 읽으므로 회색 PNG로 바꿔도 결과가 같다. 해당하지 않으면 None"""
    w, h, ch, px = decode_png(png)
    if ch < 3:
        return None
    r = px[0::ch]
    if r != px[1::ch] or r != px[2::ch] or (ch == 4 and px[3::ch] != r and px[3::ch] != b'\xff' * (w * h)):
        return None
    return encode_gray_png(r, w, h)


def compact_binary(gltf, binary):
    """쓰지 않는 텍스처를 빼고, 1채널 PNG를 회색으로 바꾸고, bufferView를 다시 이어 붙인 binary를 돌려준다"""
    def refs(mat):  # 머티리얼이 가리키는 텍스처 정보 전부 (BfrAss가 채운 emissiveTexture 등 표준 슬롯 포함)
        pbr = mat['pbrMetallicRoughness']
        return [*mat['extras']['s3']['textures'].values(), *mat['extras']['s3'].get('presets', {}).get('eye', []), *(mat[k] for k in ('normalTexture', 'occlusionTexture', 'emissiveTexture') if k in mat),
                *(pbr[k] for k in ('baseColorTexture', 'metallicRoughnessTexture') if k in pbr)]
    used = sorted({info['index'] for mat in gltf.get('materials', []) for info in refs(mat)})
    for mat in gltf.get('materials', []):
        for info in refs(mat):
            info['index'] = used.index(info['index'])
    gltf['textures'] = [gltf['textures'][i] for i in used]
    if not gltf['textures']:
        del gltf['textures']
    images = sorted({t['source'] for t in gltf.get('textures', [])})
    samplers = sorted({t['sampler'] for t in gltf.get('textures', [])})
    for t in gltf.get('textures', []):
        t['source'], t['sampler'] = images.index(t['source']), samplers.index(t['sampler'])
    gltf['images'] = [gltf['images'][i] for i in images]
    gltf['samplers'] = [gltf['samplers'][i] for i in samplers]
    for key in ('images', 'samplers'):
        if not gltf[key]:
            del gltf[key]
    data = {}
    for im in gltf.get('images', []):
        v = gltf['bufferViews'][im['bufferView']]
        png = bytes(binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']])
        data[im['bufferView']] = gray_png(png) or png
    views = sorted({im['bufferView'] for im in gltf.get('images', [])} | {a['bufferView'] for a in gltf['accessors'] if 'bufferView' in a})
    out = bytearray()
    new_views = []
    for i in views:
        v = dict(gltf['bufferViews'][i])
        chunk = data.get(i) or binary[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
        out += b'\0' * (-len(out) % 4)
        v['byteOffset'], v['byteLength'] = len(out), len(chunk)
        out += chunk
        new_views.append(v)
    for a in gltf['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = views.index(a['bufferView'])
    for im in gltf.get('images', []):
        im['bufferView'] = views.index(im['bufferView'])
    gltf['bufferViews'] = new_views
    gltf['buffers'][0]['byteLength'] = len(out)
    return out


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
    names = ANIMATIONS + next((v for prefix, v in ANIMATIONS_BY_PREFIX.items() if stem.startswith(prefix)), ())
    return tuple(dict.fromkeys(names))  # 중복 제거 (스페셜 목록에도 'Open'·'Close'가 있음)


def base_differs(node, data):
    """애니메이션 기준값이 바인드 자세(노드 T/R/S)와 다른지"""
    if 'Scale' in data['flagsBase'] and any(abs(a - b) > 1e-4 for a, b in zip(data['baseScale'], node['scale'])):
        return True
    if 'Translate' in data['flagsBase'] and any(abs(a - b) > 1e-4 for a, b in zip(data['baseTranslate'], node['translation'])):
        return True
    if 'Rotate' in data['flagsBase']:
        q = euler_xyz_to_quat(*data['baseRotate'][:3])
        return abs(sum(a * b for a, b in zip(q, node['rotation']))) < 1 - 1e-6
    return False


def add_animations(gltf, binary, anims, names, static_bones=False, skip=frozenset()):
    """게임 스켈레탈 애니메이션을 glTF 애니메이션으로. 커브가 있는 본만 넣고(여러 애니메이션을 동시에 재생해도 서로 덮어쓰지 않게),
    그 본의 T/R/S는 커브가 없는 성분도 애니메이션 기준값으로 채운다 (기준값이 바인드 자세와 조금 다를 수 있음)
    static_bones: 커브가 없어도 기준값이 바인드 자세와 다른 본도 넣음 (STATIC_BONE_PREFIXES). skip의 (애니메이션, 본)은 빼고 (STATIC_BONE_SKIP)"""
    joints = {node['name']: i for i, node in enumerate(gltf['nodes']) if 'mesh' not in node}
    for name in names:
        anim = anims['skeletal'].get(name)
        if anim is None:
            continue
        assert anim['flagsRotate'] == 'EulerXYZ', anim['flagsRotate']
        # 모델에 없는 본은 움직일 대상이 없으므로 무시 (예: 오더 롤러에는 Bench가 없음)
        bones = {b: d for b, d in anim['bones'].items()
                 if b in joints and (d['curves'] or (static_bones and (name, b) not in skip and base_differs(gltf['nodes'][joints[b]], d)))}
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


def accessor_view(gltf, acc):
    """float accessor → (바이너리 안 시작 위치, 성분 수)"""
    a = gltf['accessors'][acc]
    assert a['componentType'] == 5126, a
    return gltf['bufferViews'][a['bufferView']]['byteOffset'] + a.get('byteOffset', 0), {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]


def read_vectors(gltf, binary, acc):
    start, width = accessor_view(gltf, acc)
    flat = struct.unpack_from(f'<{gltf["accessors"][acc]["count"] * width}f', binary, start)
    return [list(flat[i:i + width]) for i in range(0, len(flat), width)]


def compensate_segment_scale(gltf, binary):
    """게임 스켈레톤(스케일 모드 Maya)의 SSC 본은 부모 스케일을 물려받지 않고, 위치만 부모 스케일만큼 늘어난다.
    glTF에는 SSC가 없어서 자식이 부모 스케일을 그대로 물려받는다 (예: 파블로 Open/Close에서 Brush_1·Brush_2 스케일이 털 끝까지 겹쳐 곱해짐).
    애니메이션이 스케일을 바꾸는 본 P와 그 SSC 자식 C 사이에 노드를 끼워 스케일 1/S_P를 걸고, C의 위치에 S_P를 곱해 굽는다:
    world(C) = world(P 이동·회전)·S_P·S_P⁻¹·T(S_P·t_C)·R_C·S_C = world(P 이동·회전)·T(S_P·t_C)·R_C·S_C (게임 식과 같음).
    본 flags는 BfrAss가 노드 extras에 넣어 둔다. 바인드 자세는 BfrAss 출력 그대로 둔다: 바인드 스케일 B가 1이 아니면 (예: 컬링 밤 옥타링 Root 0.7, 트리플 토네이도 장치 Root_Joint 1.0024)
    BfrAss는 C도 B를 물려받게 두므로, 바인드 대비 비율 S_P/B만 위 방식으로 보정한다 (바인드 자세에서는 끼운 노드 스케일 1, 위치 그대로)"""
    nodes = gltf['nodes']
    anims = [(anim, {(c['target']['node'], c['target']['path']): anim['samplers'][c['sampler']] for c in anim['channels']})
             for anim in gltf.get('animations', [])]
    scaled = {p for _, chans in anims for (p, path), s in chans.items()
              if path == 'scale' and any(abs(x - 1) > 1e-6 for v in read_vectors(gltf, binary, s['output']) for x in v)}
    pairs = []  # (P, C, 끼운 노드)
    for p in sorted(scaled):
        for c in [c for c in nodes[p].get('children', []) if int(nodes[c].get('extras', {}).get('bfres.bone.flags', '0'), 16) & SSC_FLAG]:
            nodes.append({'name': nodes[c]['name'] + '_SSC', 'translation': [0, 0, 0], 'rotation': [0, 0, 0, 1], 'scale': [1, 1, 1], 'children': [c]})
            nodes[p]['children'][nodes[p]['children'].index(c)] = len(nodes) - 1
            pairs.append((p, c, len(nodes) - 1))
    for anim, chans in anims:
        for p, c, k in pairs:
            scale = chans.get((p, 'scale'))
            if scale is None:
                # 이 애니메이션은 부모 스케일 커브가 없음 → 게임은 부모 스케일 기준값(바인드)을 씀. 바인드 대비 비율 1이라 자식 위치는 그대로 (예: 탄산 밤 Warning의 Scale 본)
                continue
            bind = nodes[p]['scale']
            if all(abs(b - 1) < 1e-6 for b in bind):
                bind = [1, 1, 1]  # 바인드 1인 본은 예전 결과와 비트까지 같게 (float 오차로 1 ulp씩 달라지지 않게)
            s = [[x / b for x, b in zip(v, bind)] for v in read_vectors(gltf, binary, scale['output'])]  # 바인드 대비 비율
            inverse = add_accessor(gltf, binary, [[1 / x for x in v] for v in s], 'VEC3')
            anim['samplers'].append({'input': scale['input'], 'output': inverse, 'interpolation': 'LINEAR'})
            anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': k, 'path': 'scale'}})
            t = chans.get((c, 'translation'))
            if t is None:
                t = {'input': scale['input'], 'output': add_accessor(gltf, binary, [nodes[c]['translation']] * len(s), 'VEC3'), 'interpolation': 'LINEAR'}
                anim['samplers'].append(t)
                anim['channels'].append({'sampler': len(anim['samplers']) - 1, 'target': {'node': c, 'path': 'translation'}})
            assert t['input'] == scale['input'], anim['name']
            start, _ = accessor_view(gltf, t['output'])
            values = [x * y for v, sv in zip(read_vectors(gltf, binary, t['output']), s) for x, y in zip(v, sv)]
            struct.pack_into(f'<{len(values)}f', binary, start, *values)


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
                  # 히어로 슈터는 애니메이션 쪽 이름이 M_body (모델은 M_Body). 컬래버 머티리얼(M_Body_Cstm01 등)은 기본 무기 애니메이션을 그대로 따름 (사용자 확인)
                  for mat, params in anim['materials'].items() if mat.lower() == re.sub(r'_Cstm\d+$', '', material).lower()
                  for p in params for c in p['curves']]
        if tracks:
            result[name] = {'loop': anim['loop'], 'duration': anim['frameCount'] / 60, 'tracks': tracks}
    return result


def material_param_presets(anims, material, name):
    """셰이더 파라미터 애니메이션의 프레임별 값 → {파라미터: [프레임마다 값 (성분이 하나면 수, 여럿이면 목록)]}"""
    anim = anims['shaderParam'].get(name)
    if not anim or material not in anim['materials']:
        return None
    result = {}
    for p in anim['materials'][material]:
        curves = sorted(p['curves'], key=lambda c: c['target'])
        values = [[eval_curve(c, f) for c in curves] for f in range(anim['frameCount'])]
        result[p['param']] = [v[0] if len(v) == 1 else v for v in values]
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


def build_file(bfres, out_dir, work, taken):
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
        if not mats:
            continue  # 메시 없이 본만 있는 모델 (예: Wsp_MicroLaserBitAll). BfrAss가 BIN 청크 없는 glb를 냄
        tmp = os.path.join(work, model + '.glb')
        # 정점 컬러는 빼고 변환: 무기 셰이더 프로그램 265개의 정점 입력에 _c0이 없음 (디컴파일로 확인). VERTEX_COLOR_MODELS만 넣음
        no_colors = () if model in VERTEX_COLOR_MODELS else ('--no-vertex-colors',)
        out_text = run('convert', bfres, '-m', model, '-o', tmp, '--mat-info', '--debug', *no_colors, *extra)
        mat_info = parse_mat_info(out_text)
        mat_samplers = material_samplers(bfres, out_text, model)
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
        add_animations(gltf, binary, anims, names, model.startswith(STATIC_BONE_PREFIXES), STATIC_BONE_SKIP.get(model, frozenset()))
        compensate_segment_scale(gltf, binary)
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
                    sampler = mat_samplers[name][mat_sampler]
                    textures[shader_sampler] = {'index': texture_for(gltf, binary, tex_name, tex_dirs, sampler), 'name': tex_name}
            s3 = {'shader': info['shader'], 'textures': textures, 'options': info['options']}
            # 셰이더 정점 입력이 이름이 다른 정점 속성을 읽는 경우만 기록 (예: 소이 튜버 M_Body는 셰이더의 _u2 자리에 _u0을 넣음)
            if remap := {k: v for k, v in info['attributes'].items() if k != v}:
                s3['attributes'] = remap
            render, params, opts = info['render'], info['params'], info['options']
            # 양면: display_face both면 컬링 없음 (Hoian GXConverter). 무기에는 front와 both만 있음
            assert render['gsys_render_state_display_face'] in ('front', 'both'), (name, render)
            if render['gsys_render_state_display_face'] == 'both':
                mat['doubleSided'] = True
            # 그림자만 드리우고 화면에는 안 그리는 머티리얼 (예: 스파이 가젯·도돌이 우산 M_Shadow)
            if render.get('gsys_dynamic_depth_shadow_only') == '1':
                s3['shadow_only'] = True
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
                # 조명 없음 + 알베도 텍스처 없음 + 기준 색 알베도: 색 = albedo_color × (1 + emission 맵 × intensity)
                # (decompile: 래피드 블래스터 엘리트 M_Ray, program 12569). 확인한 조합만
                if opts.get('enable_shading') == 'False' and opts.get('enable_albedo_tex') == 'False' and opts.get('emission_color_type') == '1':
                    used['albedo_color'] = params['albedo_color'][:3]
            # calc_color 피연산자 100~102 = const_color0~2 (decompile: 캐릭터 몸 M_Body program 13751, 얼굴 M_Face 2600). 피부색 프리셋(Color_Skin)이 이 값을 바꿈
            for k in range(3):
                if opts.get(f'enable_calc_color{k}') == 'True':
                    for op in ('A', 'B', 'C', 'D'):
                        if (v := opts.get(f'blitz_calc_color{k}_{op}')) in ('100', '101', '102'):
                            used[f'const_color{int(v) - 100}'] = params[f'const_color{int(v) - 100}'][:3]
            if opts.get('enable_manual_fresnel') == 'True':
                used['manual_fresnel'] = params['manual_fresnel'][0]
                used['manual_fresnel_color'] = params['manual_fresnel_color'][:3]
            # transfilm / edge light / transmission (add_s3_params.py와 같은 키)
            for opt, keys in add_s3_params.PARAMS.items():
                if opts.get(opt) == 'True':
                    for k in keys:
                        used[k] = params[k][0] if len(params[k]) == 1 else params[k][:3]
            # team_color_map_type 3 + 알베도 텍스처: 확산색 = mix(알베도, 잉크 색, sat(team_color_blend)). Tcl 맵을 안 읽음
            # (decompile: 스플래시 밤 M_VinylOut 12512, 오더 머뉴버 M_Clear 8043, 새싹 슈터 M_Rubber 11447. my_team_color 자리를 잉크 색으로 봄)
            if opts.get('team_color_map_type') == '3' and opts.get('enable_albedo_tex') != 'False':
                used['team_color_blend'] = params['team_color_blend'][0]
            # 커스텀 식 머티리얼 (pixel_expression0): 스플래터컬러 스크린 막 M_Wall (decompile program 11866). 식이 쓰는 상수만 기록, 계산은 뷰어
            if opts.get('pixel_expression0') == '3887478785':
                s3['expr'] = {'id': 'chimney_wall', 'const_value': [params[f'const_value{i}'][0] for i in range(10)],
                              'const_vector': [params[f'const_vector{i}'][:3] for i in range(4)]}
            if used:
                s3['params'] = used
            # 화면 색 버퍼를 굴절해서 읽는 유리 (decompile: 포이즌 미스트 M_Bottle, program 13667). 확인한 조합만
            # 확산색 = mix(sqrt(albedo_color) × 화면 색(UV를 뷰 법선 × refract_intensity만큼 밀고, mip = roughness), 조명 받은 albedo_color, Opa 맵)
            if opts.get('gsys_enable_color_buffer') == 'True' and opts.get('blitz_rendering_mode') == '3' and opts.get('enable_albedo_tex') == 'False':
                s3['refract'] = {'albedo_color': params['albedo_color'][:3], 'roughness': params['roughness'][0], 'refract_intensity': params['refract_intensity'][0]}
            if model.startswith(TEX_SRT_PREFIXES):
                s3['tex_srt'] = {k: v for k, v in info['tex_srt'].items() if k in ('tex_mtx0', 'tex_mtx1')}
            if param_anims := material_param_animations(anims, name, names):
                s3['param_anims'] = param_anims
            # 캐릭터 색 프리셋: 게임은 이 애니메이션의 프레임 하나를 골라 고정 적용 (HoianViewer PlayerScene.ApplySkinTone·ApplyEyeColor)
            if skin := material_param_presets(anims, name, 'Color_Skin'):
                s3.setdefault('presets', {})['skin'] = skin
            # Color_Eye는 M_Eye _a0 텍스처 패턴 애니메이션. 프레임 i → M_Eye_Alb.<i> (21프레임, 텍스처 이름 목록 순서 그대로. tools 밖 BfresLibrary 덤프로 확인)
            # fska_dump가 텍스처 패턴을 안 읽어서 이름 규칙으로 넣음
            if name == 'M_Eye' and model.startswith('Player') and '_a0' in textures:
                eyes = sorted(f[:-4] for f in os.listdir(tex_dirs[0]) if re.fullmatch(r'M_Eye_Alb\.\d+\.png', f))
                sampler = mat_samplers[name][info['samplers']['_a0']]
                s3.setdefault('presets', {})['eye'] = [{'index': texture_for(gltf, binary, t, tex_dirs, sampler), 'name': t} for t in eyes]
            mat.setdefault('extras', {})['s3'] = s3
            # 표준 슬롯도 셰이더 샘플러 기준으로 채운다 (BfrAss는 공유/외부 텍스처일 때 비워둠)
            pbr = mat.setdefault('pbrMetallicRoughness', {})
            pbr.pop('baseColorTexture', None)
            mat.pop('normalTexture', None)
            if '_a0' in textures:
                pbr['baseColorTexture'] = {'index': textures['_a0']['index']}
            if '_n0' in textures:
                mat['normalTexture'] = {'index': textures['_n0']['index']}
        binary = compact_binary(gltf, binary)
        # 다른 bfres 파일과 모델 이름이 겹치면 (예: Charger_LongB 안의 모델 이름이 Charger_Long) 파일 이름으로 저장해 덮어쓰지 않게 한다
        name = stem if model != stem and model in taken else model
        out = os.path.join(out_dir, name + '.glb')
        write_glb(out, gltf, binary)
        results.append((name, os.path.getsize(out)))
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
    taken = {f[:-len('.bfres.zs')] for f in os.listdir(src_dir) if f.endswith('.bfres.zs')}
    total = 0
    for f in names:
        for model, size in build_file(os.path.join(bfres_dir, f[:-len('.zs')]), out_dir, work, taken):
            total += size
            print(f'{model}.glb {size // 1024} KB')
    print(f'{len(names)} files, total {total / 2**20:.1f} MB')
