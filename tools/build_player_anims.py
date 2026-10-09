"""캐릭터(Player00~03) 스켈레탈 애니메이션 → 애니메이션만 든 glb (메시 없이 본 노드 + glTF 애니메이션).
뷰어가 캐릭터 몸 glb(build_glb.py 출력)에 같은 본 이름으로 붙여 재생한다. 애니메이션마다 파일 하나라 필요할 때만 받는다.

- 애니메이션 출처: 그 캐릭터 파일에 있으면 그것, 없으면 Player00 (HoianViewer AnimLibrary와 같은 우선순위.
  _v-* 파일은 11.2.0에 PLAYER_ANIMS 이름이 하나도 없어서 넣지 않음). 예: 오징어 남(Player01)은 Wait만 자기 것, Shop_Wait_*는 Player00 것
- 게임은 애니메이션에 든 본 전부를 기준값으로 덮으므로, 커브가 없어도 기준값이 바인드 자세와 다른 본도 넣는다 (static_bones)
- 같은 이름의 머티리얼 애니메이션에 든 셰이더 파라미터 커브(눈동자 이동 M_Eye tex_mtx0)는 animations[0].extras.s3.param_anims에
  {머티리얼: [{param, target, times, values}]}로 넣는다 (fska_dump materialParam). 같은 애니메이션의 M_Eyelids 텍스처 패턴은 상수(모델 기본 텍스처)라 안 넣음
- 길게 반복하는 대기 동작이라 게임 커브를 프레임당 1번 샘플링 (무기는 2번). 값이 끝까지 같은 채널은 키 하나로 줄임. 둘 다 용량 때문

usage: python build_player_anims.py <Model 폴더> <출력 폴더>  →  <출력 폴더>/<출처 Player0N>_<애니메이션>.glb, index.json
index.json: {캐릭터: {애니메이션: 파일 이름}}. Player00 것을 빌려 쓰는 애니메이션은 Player00 파일을 가리킨다 (본 이름이 같아서 그대로 재생됨)
"""
import copy, json, os, sys, tempfile
import zstandard
import build_glb  # 같은 폴더

PLAYERS = ('Player00', 'Player01', 'Player02', 'Player03')
WEAPON_CODES = ('Blst', 'Brsh', 'Chrg', 'Mnvr', 'Rllr', 'Sber', 'Shlt', 'Shtr', 'Slsh', 'Spnr', 'Strn')
# 스페셜 들기 대기 동작: WaitHold<코드>. 제트팩은 공중 대기(WaitHoldAir_JetPack). 스플래터컬러 스크린(Chimney)·디코이 캐넌(Firework)은 캐릭터 쪽 동작이 없음
SPECIAL_ANIMS = ('WaitHoldAir_JetPack', 'WaitHold_Blower', 'WaitHold_Chariot', 'WaitHold_GHoko', 'WaitHold_IkuraShoot', 'WaitHold_RainCloud',
                 'WaitHold_SprMissle', 'WaitHold_SuperStamp', 'WaitHold_TripleTornado', 'WaitHold_UltraShot')
PLAYER_ANIMS = ('Wait',) + tuple(f'Shop_Wait_{c}' for c in WEAPON_CODES) + SPECIAL_ANIMS


def skeleton_gltf(bfres, model, work):
    """BfrAss 출력에서 본 노드만 남긴 glTF (build_glb.build_file과 같은 T/R/S 변환)"""
    tmp = os.path.join(work, model + '_skl.glb')
    build_glb.run('convert', bfres, '-m', model, '-o', tmp, '--no-vertex-colors')
    gltf, _ = build_glb.read_glb(tmp)
    for node in gltf['nodes']:
        node.pop('mesh', None)
        node.pop('skin', None)
        if 'matrix' in node:
            node['translation'], node['rotation'], node['scale'] = build_glb.matrix_to_trs(node.pop('matrix'))
        node.setdefault('translation', [0, 0, 0])
        node.setdefault('rotation', [0, 0, 0, 1])
        node.setdefault('scale', [1, 1, 1])
    for key in ('meshes', 'skins', 'materials', 'textures', 'images', 'samplers', 'animations'):
        gltf.pop(key, None)
    return gltf


def compact(gltf, binary):
    """값이 끝까지 같은 채널은 키 하나로 줄이고, 쓰는 accessor만 새 binary에 다시 쓴다"""
    old = (gltf['accessors'], binary)
    old_views = [v.get('byteOffset', 0) for v in gltf['bufferViews']]
    gltf['accessors'], gltf['bufferViews'], gltf['buffers'] = [], [], [{'byteLength': 0}]
    out = bytearray()
    kinds = {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4'}
    cache = {}
    def read(acc):
        a = old[0][acc]
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
        flat = build_glb.struct.unpack_from(f'<{a["count"] * width}f', old[1], old_views[a['bufferView']] + a.get('byteOffset', 0))
        return [list(flat[i:i + width]) for i in range(0, len(flat), width)], width
    for anim in gltf['animations']:
        for sampler in anim['samplers']:
            times, _ = read(sampler['input'])
            values, width = read(sampler['output'])
            if all(v == values[0] for v in values):
                times, values = times[:1], values[:1]
            key = (sampler['input'], len(times))
            if key not in cache:
                cache[key] = build_glb.add_accessor(gltf, out, [t[0] for t in times], 'SCALAR')
            sampler['input'] = cache[key]
            sampler['output'] = build_glb.add_accessor(gltf, out, [v if width > 1 else v[0] for v in values], kinds[width])
    return out


if __name__ == '__main__':
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix='s3anim_')
    dctx = zstandard.ZstdDecompressor()
    build_glb.ANIM_SAMPLES_PER_FRAME = 1
    anims = {}
    for p in PLAYERS:
        bfres = os.path.join(work, p + '.bfres')
        with open(os.path.join(src_dir, p + '.bfres.zs'), 'rb') as src:
            open(bfres, 'wb').write(dctx.decompress(src.read()))
        anims[p] = build_glb.load_animations(bfres)
    total = 0
    index = {p: {name: f'{p if name in anims[p]["skeletal"] else "Player00"}_{name}.glb' for name in PLAYER_ANIMS} for p in PLAYERS}
    json.dump(index, open(os.path.join(out_dir, 'index.json'), 'w'), indent=1)
    for p in PLAYERS:
        base = skeleton_gltf(os.path.join(work, p + '.bfres'), p, work)
        for name in PLAYER_ANIMS:
            source = p if name in anims[p]['skeletal'] else 'Player00'
            if source != p:
                continue
            gltf = copy.deepcopy(base)
            gltf.update(accessors=[], bufferViews=[], buffers=[{'byteLength': 0}])
            binary = bytearray()
            build_glb.add_animations(gltf, binary, anims[source], (name,), static_bones=True)
            assert gltf.get('animations'), (p, name)
            mat_anim = anims[source]['materialParam'].get(name)
            if mat_anim:
                frames = build_glb.sample_frames(mat_anim['frameCount'])
                gltf['animations'][0]['extras'] = {'s3': {'param_anims': {
                    mat: [{'param': prm['param'], 'target': c['target'], 'times': [f / 60 for f in frames], 'values': [build_glb.eval_curve(c, f) for f in frames]}
                          for prm in params for c in prm['curves']]
                    for mat, params in mat_anim['materials'].items()}}}
            build_glb.compensate_segment_scale(gltf, binary)
            binary = compact(gltf, binary)
            out = os.path.join(out_dir, f'{p}_{name}.glb')
            build_glb.write_glb(out, gltf, binary)
            total += os.path.getsize(out)
            print(f'{p}_{name}.glb {os.path.getsize(out) // 1024} KB')
    print(f'total {total / 2**20:.1f} MB')
