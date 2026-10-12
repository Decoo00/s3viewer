"""게임 이펙트(VFXB) 덤프 → 뷰어용 이펙트 JSON + 텍스처 PNG.

입력은 KillzXGaming/EffectLibrary(패치판)로 뽑은 이미터 덤프와, 내장 BFRES에서 bfrass로 뽑은 프리미티브 glTF, bntx2png.py로 바꾼 텍스처.
만드는 법과 근거는 Claude_WorkSpace/s3_effect_analysis/README.md.

usage: python build_effect.py <덤프 폴더(ESET 폴더들이 있는 곳)> <프리미티브 glTF 폴더> <텍스처 PNG 폴더> <출력 폴더> <ESET 이름>...
출력: <출력>/<ESET 공통 이름>.json, <출력>/tex/<텍스처>.png
"""
import json, os, shutil, struct, sys

NONE = 0xFFFFFFFFFFFFFFFF
PRIM_NAMES = {4431516: 'Tube00', 2733314871: 'Tube01'}  # PrimitiveID → 내장 BFRES 모델 (G3NT 순번 = 모델 순번)
WRAP = {'Repeat': 'repeat', 'Mirror': 'mirror', 'ClampEdge': 'clamp'}


def keys(table, count):
    return [[k['Time'], k['X'], k['Y'], k['Z']] for k in table['Keys'][:count]]


def color(pc, st, which, count):
    """색·알파: 상수면 ParticleColor 값, 8키 애니메이션이면 EmitterStatic 키 (시간 = 수명 비율)"""
    if pc[f'{which}Type'] == 'Constant':
        if which.startswith('Alpha'):
            return {'value': [pc[which]] * 3}
        return {'value': [pc[f'{which}R'], pc[f'{which}G'], pc[f'{which}B']]}
    return {'keys': keys(st[which], count)}


def sampler(d, i, tex_names):
    s = d[f'Sampler{i}']
    if s['TextureID'] == NONE:
        return None
    st = d['EmitterStatic'][f'TexScrollAnim{i}']
    anim = d[f'TextureAnim{i}']
    return {
        'tex': tex_names[s['TextureID']],
        'wrap': [WRAP[s['WrapU']], WRAP[s['WrapV']]],
        'scroll': [st['ScrollX'], st['ScrollY']] if anim['IsScroll'] else [0, 0],
        'scrollAdd': [st['ScrollAddX'], st['ScrollAddY']] if anim['IsScroll'] else [0, 0],
        'scale': [st['ScaleX'], st['ScaleY']] if anim['IsScale'] else [1, 1],
        'scaleAdd': [st['ScaleAddX'], st['ScaleAddY']] if anim['IsScale'] else [0, 0],
        'rotate': st['Rotation'] if anim['IsRotate'] else 0,
        'rotateAdd': st['RotationAdd'] if anim['IsRotate'] else 0,
        'density': [bool(s.get('IsDensityFixedU')), bool(s.get('IsDensityFixedV'))],  # UV × 입자 크기 (텍스처 밀도 고정)
    }


def emitter(path, set_name, tex_names, shader):
    d = json.load(open(os.path.join(path, 'EmitterData.json')))
    st, info, pd, pc, ps = d['EmitterStatic'], d['EmitterInfo'], d['ParticleData'], d['ParticleColor'], d['ParticleScale']
    vel, em, shape, rs = d['ParticleVelocity'], d['Emission'], d['ShapeInfo'], d['RenderState']
    prim = pd['PrimitiveID']
    kind = 'mesh' if prim != NONE else {0: 'billboard', 4: 'quad'}[pd['BillboardType']]
    return {
        'name': d['Namev40'], 'set': set_name, 'kind': kind, 'mesh': PRIM_NAMES[prim] if prim != NONE else None,
        'shader': shader,
        'life': pd['Life'], 'infinite': bool(pd['InfiniteLife']),
        'emit': {'start': em['Start'], 'duration': em['Duration'], 'rate': em['Rate']},
        'fadeIn': info['FadeInTime'] if info['IsAlphaFadeIn'] else 0,
        'fadeOut': info['AlphaFadeTime'],
        'trans': [info['TransX'], info['TransY'], info['TransZ']],
        'colorScale': st['ColorScale'],
        'color0': color(pc, st, 'Color0', st['NumColor0Keys']), 'alpha0': color(pc, st, 'Alpha0', st['NumAlpha0Keys']),
        'color1': color(pc, st, 'Color1', st['NumColor1Keys']), 'alpha1': color(pc, st, 'Alpha1', st['NumAlpha1Keys']),
        'scale': [ps['ScaleX'], ps['ScaleY'], ps['ScaleZ']],
        'scaleRandom': ps['ScaleRandomX'] / 100,
        'scaleKeys': keys(st['ScaleAnim'], st['NumScaleKeys']),
        'center': [st['CenterX'], st['CenterY']],
        'depthOffset': st['Padding'],
        'rotateInit': [st['RotateInitX'], st['RotateInitY'], st['RotateInitZ']],
        'rotateAdd': [st['RotateAddX'], st['RotateAddY'], st['RotateAddZ']],
        'velocity': {'dir': [vel['DesignatedDirX'], vel['DesignatedDirY'], vel['DesignatedDirZ']],
                     'speed': vel['DesignatedDirScale'], 'random': vel['VelRandom'] / 100},
        'gravity': [em['GravityDirX'] * em['GravityScale'], em['GravityDirY'] * em['GravityScale'], em['GravityDirZ'] * em['GravityScale']],
        'volume': {'type': shape['VolumeType'], 'radius': [shape['VolumeRadiusX'], shape['VolumeRadiusY'], shape['VolumeRadiusZ']]},
        'side': rs['DisplaySide'],
        'samplers': [sampler(d, i, tex_names) for i in range(3)],
    }


def mesh(gltf_path):
    g = json.load(open(gltf_path))
    b = open(gltf_path[:-5] + '.bin', 'rb').read()
    prim = g['meshes'][0]['primitives'][0]

    def read(acc_index):
        a = g['accessors'][acc_index]
        v = g['bufferViews'][a['bufferView']]
        n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        fmt = {5126: 'f', 5123: 'H', 5125: 'I'}[a['componentType']]
        stride = v.get('byteStride', n * struct.calcsize(fmt))
        base = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        out = []
        for i in range(a['count']):
            out += struct.unpack_from(f'<{n}{fmt}', b, base + i * stride)
        return [round(x, 5) if fmt == 'f' else x for x in out]
    attrs = prim['attributes']
    return {
        'position': read(attrs['POSITION']),
        'uv': read(attrs['TEXCOORD_0']),
        'color': read(attrs['COLOR_0']) if 'COLOR_0' in attrs else None,
        'index': read(prim['indices']),
    }


# 이미터 → 픽셀 셰이더 식 (디컴파일한 Shader.frag 기준, 이름은 뷰어 effect.js와 맞춤)
SHADERS = {('WpsTrapAppear', 'Emitter1'): 'glow', ('WpsTrapAppear', 'Emitter1_Copy1'): 'glowSq',
           ('WpsTrapAppear', 'Dot'): 'dot', ('WpsTrapGuide', 'Dot'): 'dot',
           ('WpsTrapAppear', 'pillar'): 'pillar', ('WpsTrapGuide', 'Pillar'): 'pillar',
           ('WpsTrapGuide', 'PillarWallBack'): 'wall', ('WpsTrapGuide', 'PillarWallFront'): 'wall'}

if __name__ == '__main__':
    dump, prim_dir, tex_dir, out_dir, *sets = sys.argv[1:]
    os.makedirs(os.path.join(out_dir, 'tex'), exist_ok=True)
    tex_names = {}
    for set_name in sets:
        for em in os.listdir(os.path.join(dump, set_name)):
            p = os.path.join(dump, set_name, em)
            for f in os.listdir(p) if os.path.isdir(p) else []:
                if f.endswith('.bntx'):
                    raw = open(os.path.join(p, f), 'rb').read()
                    i = raw.find(b'_fi')
                    tex_names[int(f[:-5])] = raw[raw.rfind(b'\0', 0, i) + 1:i + 3].decode()
    out = {'emitters': [], 'meshes': {}}
    for set_name in sets:
        for em in json.load(open(os.path.join(dump, set_name, 'EmitterOrder.txt')))['Order']:
            out['emitters'].append(emitter(os.path.join(dump, set_name, em), set_name, tex_names, SHADERS[(set_name, em)]))
    for name in sorted({e['mesh'] for e in out['emitters'] if e['mesh']}):
        out['meshes'][name] = mesh(os.path.join(prim_dir, name + '.gltf'))
    for name in sorted({s['tex'] for e in out['emitters'] for s in e['samplers'] if s}):
        shutil.copy(os.path.join(tex_dir, name + '.png'), os.path.join(out_dir, 'tex', name + '.png'))
    path = os.path.join(out_dir, os.path.commonprefix(sets) + '.json')
    json.dump(out, open(path, 'w'), separators=(',', ':'))
    print(path, os.path.getsize(path), 'bytes,', len(out['emitters']), 'emitters')
