"""캐릭터 장비(상의·하의·신발)용 보조 데이터.

- 몸 가리기 마스크: Model/GearAlphaMask.bfres의 텍스처 전부 → <출력>/mask/<이름>.png (1채널 회색 PNG, 이름의 _Opa는 뗌)
- 장비 목록: RSDB GearInfoClothes·BottomInfo·GearInfoShoes → <출력>/gear.json
  {종류: {RowId: {mask: {F, M, V1}, variations}}}. 뷰어가 장비 RowId로 마스크 이름을 찾는다
  게임은 장비가 가리는 몸 피부를 이 마스크들과 몸 Opa 맵의 최솟값으로 지움 (HoianViewer AlphaMaskSystem = 게임 PlayerAlphaMaskMgr)

usage: python build_gear_masks.py <romfs 폴더 (Model·RSDB가 있는 곳)> <출력 폴더>
"""
import json, os, struct, sys, tempfile
import zstandard
import build_glb  # 같은 폴더

GEAR_TABLES = {'clothes': 'GearInfoClothes', 'bottom': 'BottomInfo', 'shoes': 'GearInfoShoes'}


def byml(b):
    """BYML v7 (rstbl.byml) → 파이썬 값. 문자열·정수·실수·bool·배열·사전만"""
    assert b[:2] == b'YB'
    keys_off, strs_off, root_off = struct.unpack_from('<III', b, 4)

    def table(off):
        n = struct.unpack_from('<I', b, off)[0] >> 8
        return [b[off + o:b.index(b'\0', off + o)].decode() for o in struct.unpack_from(f'<{n}I', b, off + 4)]
    keys, strs = table(keys_off), table(strs_off)

    def node(t, v):
        if t == 0xA0: return strs[v]
        if t == 0xD0: return bool(v)
        if t == 0xD1: return struct.unpack('<i', struct.pack('<I', v))[0]
        if t == 0xD2: return struct.unpack('<f', struct.pack('<I', v))[0]
        if t == 0xD3: return v
        if t in (0xC0, 0xC1): return container(v)
        raise ValueError(hex(t))

    def container(off):
        t, n = b[off], struct.unpack_from('<I', b, off)[0] >> 8
        if t == 0xC1:
            return {keys[struct.unpack_from('<I', b, off + 4 + 8 * i)[0] & 0xFFFFFF]: node(b[off + 7 + 8 * i], struct.unpack_from('<I', b, off + 8 + 8 * i)[0])
                    for i in range(n)}
        types, values = b[off + 4:off + 4 + n], off + 4 + ((n + 3) & ~3)
        return [node(types[i], struct.unpack_from('<I', b, values + 4 * i)[0]) for i in range(n)]
    return container(root_off)


if __name__ == '__main__':
    romfs, out_dir = sys.argv[1], sys.argv[2]
    dctx = zstandard.ZstdDecompressor()
    gear = {}
    for kind, table in GEAR_TABLES.items():
        path = os.path.join(romfs, 'RSDB', f'{table}.Product.b20.rstbl.byml.zs')
        rows = byml(dctx.decompress(open(path, 'rb').read()))
        gear[kind] = {r['__RowId']: {'mask': {'F': r['AlphaMaskF'], 'M': r['AlphaMaskM'], 'V1': r.get('AlphaMaskV1', '')}, 'variations': r['VariationNum']}
                      for r in rows}
    os.makedirs(os.path.join(out_dir, 'mask'), exist_ok=True)
    json.dump(gear, open(os.path.join(out_dir, 'gear.json'), 'w'), indent=1, sort_keys=True)
    work = tempfile.mkdtemp(prefix='s3gear_')
    bfres = os.path.join(work, 'GearAlphaMask.bfres')
    open(bfres, 'wb').write(dctx.decompress(open(os.path.join(romfs, 'Model', 'GearAlphaMask.bfres.zs'), 'rb').read()))
    build_glb.run('textures', bfres, '-o', os.path.join(work, 'tex'))
    count = 0
    for f in sorted(os.listdir(os.path.join(work, 'tex'))):
        png = open(os.path.join(work, 'tex', f), 'rb').read()
        name = f[:-len('.png')].removesuffix('_Opa')
        open(os.path.join(out_dir, 'mask', name + '.png'), 'wb').write(build_glb.gray_png(png) or png)
        count += 1
    print(f'{sum(len(v) for v in gear.values())} gear rows, {count} masks')
