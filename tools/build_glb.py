"""스플래툰 3 무기 모델(bfres.zs) → 모델별 독립 glb 변환.

- 컬래버(_CstmNN) 파일이 기본 무기의 텍스처를 참조하면, 그 텍스처를 복사해 넣어서 glb 하나로 완결되게 만든다.
- bfres 하나에 모델이 여러 개면(예: 우산+케이스, 듀얼 좌우) 모델마다 glb를 따로 만든다.
- 머티리얼마다 셰이더 샘플러(_a0, _n0, _su0 …) → 텍스처 매핑과 셰이더 옵션을 material.extras.s3에 넣는다.
  불투명이 아니면 render state(블렌딩, 깊이 쓰기, alpha test)도, 뷰어가 쓰는 파라미터(opacity, emission, manual fresnel)는 params에 넣는다.
- 붙은 본이 invisible인 셰이프는 node.extras.s3.hidden = true로 표시한다 (게임에서 기본으로 숨겨진 부품).

usage: python build_glb.py <Model 폴더> <출력 폴더> [파일 패턴, 기본 Wmn_*.bfres.zs]
환경 변수 BFRASS로 bfrass 실행 파일 경로를 지정할 수 있다 (기본: PATH의 bfrass).
"""
import fnmatch, json, os, re, struct, subprocess, sys, tempfile
import zstandard

BFRASS = os.environ.get('BFRASS', 'bfrass')
DEFAULT = '<Default Value>'
RENDER_KEYS = {'gsys_render_state_mode', 'gsys_render_state_blend_mode', 'gsys_depth_test_write', 'gsys_alpha_test_enable', 'gsys_alpha_test_value'}
PARAM_KEYS = {'opacity', 'emission_intensity', 'emission_color', 'manual_fresnel', 'manual_fresnel_color'}


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
    """--debug 출력 → {model: {shape: bool}}. 셰이프가 붙은 본의 visible 플래그(bit 0)를 따른다.
    예: 새싹 슈터는 스티커 셰이프가 붙은 Stecker_low 본이 invisible이라 게임에서 스티커가 안 보임."""
    result, model, bones = {}, None, {}
    for line in text.splitlines():
        if m := re.match(r'^FMDL: name=(\S+)', line):
            model, bones = result.setdefault(m.group(1), {}), {}
        elif m := re.match(r'^  bone #(\d+) \S+: .*flags=0x([0-9A-Fa-f]+)', line):
            bones[int(m.group(1))] = bool(int(m.group(2), 16) & 1)
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

    results = []
    for model, mats in models.items():
        tmp = os.path.join(work, model + '.glb')
        out_text = run('convert', bfres, '-m', model, '-o', tmp, '--mat-info', '--debug', *extra)
        mat_info = parse_mat_info(out_text)
        shape_visible = parse_shape_visibility(out_text)[model]
        gltf, binary = read_glb(tmp)
        for node in gltf['nodes']:
            if 'mesh' in node and not shape_visible[node['name']]:
                node.setdefault('extras', {})['s3'] = {'hidden': True}
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
