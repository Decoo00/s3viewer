"""기존 glb의 material.extras.s3.params에 transfilm / edge light / transmission 파라미터를 덧붙인다.
값은 게임 덤프의 bfres(v10) 머티리얼 셰이더 파라미터에서 직접 읽는다 (BfrAss 없이). build_glb.py로 새로 만들 때도 같은 키가 들어감.

usage: python add_s3_params.py <추출한 Model 폴더> <glb 폴더>
glb 이름(<모델 이름>.glb)과 이름이 가장 길게 겹치는 Wmn_*.bfres.zs에서 같은 이름의 머티리얼을 찾는다.
"""
import glob, json, os, re, struct, sys
import zstandard

# 옵션 → 셰이더가 읽는 파라미터 (decompile: 스퍼터리 OWL M_Twins_Short_Cstm02, program 7268)
PARAMS = {
    'enable_transfilm': ['film_transmission_power', 'film_transmission_rate', 'under_film_color'],
    'enable_edge_light': ['edge_light_intens', 'edge_light_power', 'edge_light_color'],
    'enable_taransmission': ['transmission_rate', 'scattering_rate', 'edge_transmission_power', 'transmission_color_backlight'],
}
FLOAT_TYPES = {12: 1, 13: 2, 14: 3, 15: 4}  # ShaderParamType float, float2, float3, float4


def load_bfres(path):
    return zstandard.ZstdDecompressor().decompress(open(path, 'rb').read(), max_output_size=1 << 30)


def has_model(b, model):
    """bfres 문자열 풀에 모델 이름이 있는지 (u16 길이 + 이름 + NUL)"""
    name = model.encode()
    return struct.pack('<H', len(name)) + name + b'\0' in b


def bfres_materials(b):
    """{머티리얼 이름: {파라미터 이름: [float, ...]}}. 구조는 BfresLibrary MaterialParserV10과 같음"""
    u16 = lambda o: struct.unpack_from('<H', b, o)[0]
    u64 = lambda o: struct.unpack_from('<Q', b, o)[0]
    def string(o):
        return b[o + 2:o + 2 + u16(o)].decode('utf8', 'replace') if o else None
    out = {}
    for m in re.finditer(b'FMAT', b):
        o = m.start()
        name, info = string(u64(o + 8)), u64(o + 16)
        if not name or not info or not 0 < u64(info) < len(b):
            continue
        assign = u64(info)  # ShaderAssignV10
        table, count, size, data = u64(assign + 32), u16(assign + 74), u16(assign + 76), u64(o + 88)
        params = {}
        for i in range(count):
            e = table + 24 * i
            n = FLOAT_TYPES.get(u16(e + 18))
            off = u16(e + 16)
            if n and off + 4 * n <= size:
                params[string(u64(e + 8))] = list(struct.unpack_from('<%df' % n, b, data + off))
        out.setdefault(name, params)
    return out


def rewrite_glb(path, update):
    b = open(path, 'rb').read()
    n = struct.unpack_from('<I', b, 12)[0]
    gltf = json.loads(b[20:20 + n])
    if not update(gltf):
        return False
    js = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    rest = b[20 + n:]
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + len(rest)) + struct.pack('<II', len(js), 0x4E4F534A) + js + rest
    open(path, 'wb').write(out)
    return True


def main(model_dir, glb_dir):
    bfres = {os.path.basename(p)[:-len('.bfres.zs')]: p for p in glob.glob(os.path.join(model_dir, 'Wmn_*.bfres.zs'))}
    cache, mats = {}, {}
    changed = 0
    for path in sorted(glob.glob(os.path.join(glb_dir, '*.glb'))):
        model = os.path.basename(path)[:-4]
        # 모델 이름이 실제로 들어 있는 bfres만 (덤프 버전에 없는 무기를 이름이 비슷한 다른 무기 값으로 채우지 않게)
        # 이름이 앞부분부터 겹치는 bfres를 먼저 보고, 없으면 전부 찾음. 왼손(_L)이 게임에 없으면 변환 때 오른손을 대칭한 것이라 오른손 이름으로 찾음
        src = None
        for name in [model] + ([model[:-2]] if model.endswith('_L') else []):
            prefixed = sorted((k for k in bfres if name.startswith(k)), key=len, reverse=True)
            for k in prefixed + [k for k in sorted(bfres) if k not in prefixed]:
                if k not in cache:
                    cache[k] = load_bfres(bfres[k])
                if has_model(cache[k], name):
                    src = k
                    break
            if src:
                break
        if src is None:
            print('bfres 없음:', model)
            continue
        def update(gltf):
            hit = False
            for mat in gltf.get('materials', []):
                s3 = mat.get('extras', {}).get('s3')
                if not s3:
                    continue
                wanted = [p for opt, ps in PARAMS.items() if s3.get('options', {}).get(opt) == 'True' for p in ps]
                if not wanted:
                    continue
                if src not in mats:
                    mats[src] = bfres_materials(cache[src])
                values = mats[src].get(mat['name'])
                if values is None:
                    print('머티리얼 없음:', model, mat['name'])
                    continue
                params = s3.setdefault('params', {})
                for p in wanted:
                    v = values[p]
                    v = v[0] if len(v) == 1 else v[:3]
                    if params.get(p) != v:
                        params[p] = v
                        hit = True
            return hit
        if rewrite_glb(path, update):
            changed += 1
    print('바뀐 glb:', changed)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
