// bfres의 애니메이션 원본 데이터(커브 계수, 기준값, 플래그)를 JSON으로 출력. 해석은 build_glb.py가 한다.
// skeletal: 본 T/R/S, boneVisibility: 본 보임/숨김, shaderParam: 머티리얼 셰이더 파라미터
using System.Text.Json;
using BfresLibrary;

object Curve(AnimCurve c) => new
{
    target = c.AnimDataOffset,
    type = c.CurveType.ToString(),
    frames = c.Frames,
    keys = Enumerable.Range(0, c.Keys.GetLength(0)).Select(i => Enumerable.Range(0, c.Keys.GetLength(1)).Select(k => c.Keys[i, k]).ToArray()).ToArray(),
    scale = c.Scale,
    offset = (float)c.Offset,
};

var res = new ResFile(args[0]);
var skeletal = new Dictionary<string, object>();
foreach (var anim in res.SkeletalAnims.Values)
{
    var bones = new Dictionary<string, object>();
    foreach (var b in anim.BoneAnims)
    {
        var d = b.BaseData;
        bones[b.Name] = new
        {
            flagsBase = b.FlagsBase.ToString(),
            baseScale = new[] { d.Scale.X, d.Scale.Y, d.Scale.Z },
            baseTranslate = new[] { d.Translate.X, d.Translate.Y, d.Translate.Z },
            baseRotate = new[] { d.Rotate.X, d.Rotate.Y, d.Rotate.Z, d.Rotate.W },
            curves = b.Curves.Select(Curve).ToArray(),
        };
    }
    skeletal[anim.Name] = new { frameCount = anim.FrameCount, loop = anim.Loop, flagsRotate = anim.FlagsRotate.ToString(), bones };
}
var boneVisibility = new Dictionary<string, object>();
foreach (var anim in res.BoneVisibilityAnims.Values)
{
    boneVisibility[anim.Name] = new
    {
        frameCount = anim.FrameCount,
        loop = anim.Loop,
        curves = anim.Curves.Select(c => new { bone = anim.Names[(int)c.AnimDataOffset], frames = c.Frames, values = c.KeyStepBoolData }).ToArray(),
    };
}
var shaderParam = new Dictionary<string, object>();
foreach (var anim in res.ShaderParamAnims.Values)
{
    var materials = new Dictionary<string, object>();
    foreach (var m in anim.MaterialAnimDataList)
    {
        materials[m.Name] = m.ParamAnimInfos.Select(p => new
        {
            param = p.Name,
            curves = m.Curves.Skip(p.BeginCurve).Take(p.FloatCurveCount).Select(Curve).ToArray(),
        }).Where(p => p.curves.Length > 0).ToArray();
    }
    shaderParam[anim.Name] = new { frameCount = anim.FrameCount, loop = anim.Loop, materials };
}
Console.WriteLine(JsonSerializer.Serialize(new { skeletal, boneVisibility, shaderParam }, new JsonSerializerOptions { WriteIndented = true }));
