import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { editor, cropFrame, savePng, safeName, openSequenceEditor } from './export.js';
import { t, setText, categoryName, weaponName, englishWeaponName, onLangChange, mountLangPicker } from './i18n.js';

/**
 * TODO
 * 언어추가?
 */

let currentModel = null; // 현재 씬에 있는 모델을 담을 변수



// 1. 기본 설정 (씬, 카메라, 렌더러)
const scene = new THREE.Scene();
const BACKGROUND_COLOR = new THREE.Color(0xa0a0a0); // 기본/스튜디오 프리셋 배경색
scene.background = BACKGROUND_COLOR;

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(-1, 1, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); // alpha: 저장할 때 배경을 투명하게 (평소엔 배경이 불투명이라 차이 없음)
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

// 2. 조명 추가 (모델이 잘 보이게 하기 위함)
// 직접 조명은 lightRig에 묶어서 '조명 방향' 슬라이더로 같이 돌림
const lightRig = new THREE.Group();
scene.add(lightRig);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 1);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 4);
dirLight.position.set(1, 2, 1);
// 그림자 범위 설정 (모델 크기에 맞춰 조정 필요)
function castShadow(light) {
    light.castShadow = true;
    light.shadow.camera.left = -1;
    light.shadow.camera.right = 1;
    light.shadow.camera.top = 1;
    light.shadow.camera.bottom = -1;
    light.shadow.mapSize.width = 2048; // 그림자 해상도
    light.shadow.mapSize.height = 2048;
    light.shadow.camera.near = 0.001;
    light.shadow.camera.far = 10;
    light.shadow.bias = -0.0001;
}
castShadow(dirLight);
lightRig.add(dirLight);

// 인게임 주광: 게임 장비 뷰어의 gsys_environment 덤프 값 (Hoian Viewer Resources/SPL3/fp_c5.bin)
// row 5 = 색 × 세기 (6, 5.562, 4.494), row 23 = 빛이 진행하는 방향 (-0.709, -0.5, -0.497)
const gameLight = new THREE.DirectionalLight(new THREE.Color(1, 0.927, 0.749), 6);
gameLight.position.set(0.70941, 0.5, 0.49673);
castShadow(gameLight);
lightRig.add(gameLight);

// 인게임 환경광: 게임 셰이더(decompile first.a.frag)처럼 확산은 SH × albedo, 반사는 거칠기로 고른 prefiltered 큐브 × EnvBRDF.
// three.js 환경맵(PMREM)은 흐리는 방식과 확산 계산이 달라서 쓰지 않고, 머티리얼 셰이더에 직접 넣음
// SH = 덤프 gsys_environment row 25-31 (게임이 읽는 packed 형태 그대로: 조도/π)
// 큐브 = 덤프 cubemap.dds 0~11번을 한 장에 모은 atlas (tools/make_env_atlas.py). 블록 = [x, y, 면 크기], 면 6개가 가로로 놓임
const ENV_ATLAS_BLOCKS = [[0, 0, 256], [0, 256, 64], ...Array.from({ length: 10 }, (_, i) => [384 + i % 6 * 192, 256 + Math.floor(i / 6) * 32, 32])];
const gameEnv = {
    s3EnvOn: { value: 0 },
    s3Cel: { value: 0 }, // 셀 셰이딩 명암 단계 수 (0 = 끔). 픽셀 셰이더 옵션
    s3Toon: { value: new THREE.Vector4() }, // 카툰 셰이더: (켬, 명암 단계, 경계 부드러움, 림 라이트)
    s3ToonKey: { value: new THREE.Color() }, // 카툰 명암 기준 주광 (색 × 세기)

    s3EnvAtlas: { value: null },
    s3EnvBlocks: { value: ENV_ATLAS_BLOCKS.map((b) => new THREE.Vector3(...b)) },
    s3EnvRot: { value: new THREE.Matrix3() }, // 조명 방향 슬라이더
    s3EnvBrdf: { value: null },
    s3Sh: { value: [
        [-0.046075, -0.27152, -0.0038073, 0.46444], [-0.043173, -0.24803, -0.003363, 0.43941], [-0.03598, -0.19789, -0.0027045, 0.39064],
        [0.0025781, -3.0324e-05, -0.0046795, 0.00050236], [0.0026565, -0.0002019, -0.0046352, 0.0008451], [0.0027836, -0.00021951, -0.0040569, 0.00034307],
        [0.0013908, 0.0012987, 0.00016375, 1],
    ].map((r) => new THREE.Vector4(...r)) },
};
// 반사에 곱하는 EnvBRDF (F0 × A + B). 게임은 실행 중에 UE4 split-sum LUT를 만듦 (Hoian_Proc decompile):
// GGX 중요도 샘플 1024개(Hammersley), k = r²/2, Fresnel exp2((−5.55473·VoH − 6.98316)·VoH). 같은 식으로 32×32를 만듦 (u = NoV, v = 거칠기)
function makeEnvBrdfLut(size = 32, samples = 1024) {
    const data = new Uint8Array(size * size * 2);
    for (let j = 0; j < size; j++) {
        const r = (j + 0.5) / size, a2 = r ** 4, k = r * r / 2;
        for (let i = 0; i < size; i++) {
            const NoV = (i + 0.5) / size, Vx = Math.sqrt(1 - NoV * NoV);
            const gV = NoV / (NoV * (1 - k) + k);
            let A = 0, B = 0;
            for (let s = 0; s < samples; s++) {
                let bits = s; // radical inverse
                bits = ((bits << 16) | (bits >>> 16)) >>> 0;
                bits = (((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1)) >>> 0;
                bits = (((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2)) >>> 0;
                bits = (((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4)) >>> 0;
                bits = (((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8)) >>> 0;
                const phi = 2 * Math.PI * s / samples, y = bits / 4294967296;
                const cosT = Math.sqrt((1 - y) / (1 + (a2 - 1) * y)), sinT = Math.sqrt(1 - cosT * cosT);
                const Hx = sinT * Math.cos(phi), Hz = cosT;
                const VoH = Vx * Hx + NoV * Hz, NoL = 2 * VoH * Hz - NoV;
                if (NoL <= 0) continue;
                const gVis = gV * (NoL / (NoL * (1 - k) + k)) * VoH / (Hz * NoV);
                const Fc = 2 ** ((-5.55473 * VoH - 6.98316) * VoH);
                A += (1 - Fc) * gVis;
                B += Fc * gVis;
            }
            data[(j * size + i) * 2] = Math.round(A / samples * 255);
            data[(j * size + i) * 2 + 1] = Math.round(B / samples * 255);
        }
    }
    const texture = new THREE.DataTexture(data, size, size, THREE.RGFormat);
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}
let gameEnvAtlas = null;
function loadGameEnvAtlas() {
    gameEnvAtlas ??= new THREE.TextureLoader().loadAsync('hdri/spl3_viewer_env.png').then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.generateMipmaps = false; // 밉을 만들면 옆 면이 섞임
        texture.minFilter = THREE.LinearFilter;
        gameEnv.s3EnvAtlas.value = texture;
        gameEnv.s3EnvBrdf.value = makeEnvBrdfLut();
    });
    return gameEnvAtlas;
}
// 큐브 번호 = roundEven(5.5 − 5.5·cos(π·거칠기)) (first.a.frag:354). 면 방향은 D3D 큐브맵 규칙 (덤프 SH를 큐브 0번에서 다시 계산해서 확인)
const GAME_ENV_GLSL = `uniform float s3EnvOn;
uniform float s3Cel;
uniform vec4 s3Toon;
uniform vec3 s3ToonKey;
vec3 s3AmbNormal; // SH 확산을 읽는 법선 (transfilm은 정점 법선 쪽으로 섞음). 머티리얼이 안 정하면 normal
bool s3AmbNormalSet = false;
uniform sampler2D s3EnvAtlas;
uniform vec3 s3EnvBlocks[12];
uniform mat3 s3EnvRot;
uniform vec4 s3Sh[7];
uniform sampler2D s3EnvBrdf;
vec3 s3ShIrradiance(vec3 n) {
    vec4 l = vec4(n, 1.0);
    vec4 q = vec4(n.x * n.y, n.y * n.z, n.z * n.z, n.x * n.z);
    return vec3(dot(s3Sh[0], l) + dot(s3Sh[3], q), dot(s3Sh[1], l) + dot(s3Sh[4], q), dot(s3Sh[2], l) + dot(s3Sh[5], q)) + s3Sh[6].xyz * (n.x * n.x - n.y * n.y);
}
vec3 s3EnvRadiance(vec3 d, float roughness) {
    vec3 b = s3EnvBlocks[int(roundEven(5.5 - 5.5 * cos(PI * roughness)))];
    vec3 a = abs(d);
    float face;
    vec2 uv;
    if (a.x >= a.y && a.x >= a.z) { face = d.x > 0.0 ? 0.0 : 1.0; uv = vec2(-sign(d.x) * d.z, -d.y) / a.x; }
    else if (a.y >= a.z) { face = d.y > 0.0 ? 2.0 : 3.0; uv = vec2(d.x, sign(d.y) * d.z) / a.y; }
    else { face = d.z > 0.0 ? 4.0 : 5.0; uv = vec2(sign(d.z) * d.x, -d.y) / a.z; }
    vec2 p = clamp((uv * 0.5 + 0.5) * b.z, 0.5, b.z - 0.5) + vec2(b.x + face * b.z, b.y);
    return texture(s3EnvAtlas, p / vec2(textureSize(s3EnvAtlas, 0))).rgb * 1.05; // atlas는 1.05로 나눠 저장됨
}
`;
// 인게임 직접광: 게임 식(first.a.frag:575)에는 three.js의 반사 multiscatter 보정과 확산 × (1 − F)가 없어서 인게임일 때만 뺌
const GAME_DIRECT_PARS = THREE.ShaderChunk.lights_physical_pars_fragment
    .replace('reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
        'reflectedLight.directSpecular += irradiance * specularBRDF * (s3EnvOn > 0.5 ? vec3(1.0) : material.multiScatteringCompensation);')
    .replace('reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * (s3EnvOn > 0.5 ? vec3(1.0) : 1.0 - F);');
if (GAME_DIRECT_PARS === THREE.ShaderChunk.lights_physical_pars_fragment) console.warn('GAME_DIRECT_PARS: three.js 셰이더 문자열이 바뀌어 직접광 패치가 안 됨');
function addGameEnv(shader) {
    Object.assign(shader.uniforms, gameEnv);
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${GAME_ENV_GLSL}`)
        .replace('#include <lights_physical_pars_fragment>', GAME_DIRECT_PARS)
        // three.js의 radiance(→ DFG 근사)를 거치지 않고, 게임처럼 큐브 × (F0 × A + B)를 바로 더함. 거칠기 = max(맵, 1e-4) (fp_c1)
        // SH 확산에는 (1 − F0)를 곱함 (first.a.frag:394 fma(albedo', −F0, albedo'))
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
if (s3EnvOn > 0.5) {
    float s3R = max(roughnessFactor, 1e-4);
    vec2 s3Brdf = texture(s3EnvBrdf, vec2(saturate(dot(normal, geometryViewDir)), s3R)).rg;
    vec3 s3Env = s3EnvRadiance(s3EnvRot * transformDirectionByInverseViewMatrix(reflect(-geometryViewDir, normal), viewMatrix), s3R);
    reflectedLight.indirectSpecular += s3Env * (material.specularColorBlended * s3Brdf.x + s3Brdf.y);
    reflectedLight.indirectDiffuse += s3ShIrradiance(s3EnvRot * transformDirectionByInverseViewMatrix(s3AmbNormalSet ? s3AmbNormal : normal, viewMatrix)) * material.diffuseContribution * (1.0 - material.specularColorBlended);
}
// 카툰 (카툰 셰이더, 게임 근거 없는 보기용. 끄면 게임 식 그대로). 길티기어 Xrd·젤다 야숨식 셀 셰이딩을 참고
// - 명암: 직접광 확산(N·L × 그림자 맵)을 가장 밝은 주광 대비 비율로 바꾸고 AO를 곱한 값을 임계값으로 2단(또는 3단)으로 끊음. 경계만 s3Toon.z만큼 부드럽게
// - 그림자 색: 검게 누르지 않고 채도를 올린 알베도 × 환경광 (길티기어의 그림자 색 텍스처 흉내)
// - 밝은 면: 알베도 × (환경광 + 주광 × 0.75) 단색
// - 하이라이트: 직접 반사가 일정 이상인 곳만 단색. 환경 반사(금속)는 3단으로 끊음
// - 림 라이트(야숨): 밝은 면의 가장자리에 얇은 밝은 띠
if (s3Toon.x > 0.5) {
    const vec3 s3Lum = vec3(0.299, 0.587, 0.114);
    vec3 s3Albedo = material.diffuseContribution;
    float s3Key = max(dot(s3ToonKey, s3Lum), 1e-4);
    float s3Ratio = dot(reflectedLight.directDiffuse, s3Lum) / max(dot(s3Albedo, s3Lum) * RECIPROCAL_PI * s3Key, 1e-4);
    #ifdef USE_AOMAP
    s3Ratio *= (texture2D(aoMap, vAoMapUv).r - 1.0) * aoMapIntensity + 1.0;
    #endif
    float s3Soft = max(s3Toon.z, 1e-3);
    float s3Lit = s3Toon.y > 2.5
        ? 0.5 * smoothstep(0.08 - s3Soft, 0.08 + s3Soft, s3Ratio) + 0.5 * smoothstep(0.5 - s3Soft, 0.5 + s3Soft, s3Ratio)
        : smoothstep(0.2 - s3Soft, 0.2 + s3Soft, s3Ratio);
    vec3 s3Amb = reflectedLight.indirectDiffuse / max(s3Albedo, vec3(1e-4)); // 환경광 조도
    float s3Max = max(max(s3Albedo.r, s3Albedo.g), max(s3Albedo.b, 1e-4));
    vec3 s3ShadowAlbedo = s3Albedo * mix(vec3(1.0), s3Albedo / s3Max, 0.6);
    vec3 s3LitColor = s3Albedo * (s3Amb + s3ToonKey * RECIPROCAL_PI * 0.75);
    vec3 s3ShadowColor = s3ShadowAlbedo * (s3Amb + s3ToonKey * RECIPROCAL_PI * 0.12);
    reflectedLight.directDiffuse = mix(s3ShadowColor, s3LitColor, s3Lit);
    reflectedLight.indirectDiffuse = vec3(0.0);
    float s3Spec = dot(reflectedLight.directSpecular, s3Lum) / s3Key;
    reflectedLight.directSpecular = smoothstep(0.06 - s3Soft * 0.5, 0.06 + s3Soft * 0.5, s3Spec) * s3Lit * (0.35 + 0.65 * material.specularColorBlended) * s3ToonKey * RECIPROCAL_PI * 0.6;
    float s3Env = dot(reflectedLight.indirectSpecular, s3Lum);
    reflectedLight.indirectSpecular *= s3Env > 1e-4 ? floor(s3Env * 3.0 + 0.5) / 3.0 / s3Env : 0.0;
    float s3Rim = smoothstep(0.75 - s3Soft, 0.75 + s3Soft, 1.0 - saturate(dot(normal, geometryViewDir)));
    reflectedLight.directDiffuse += s3Toon.w * s3Rim * s3Lit * s3Albedo * s3ToonKey * RECIPROCAL_PI * 0.5;
}
// 셀 셰이딩 (픽셀 셰이더 옵션, 게임 근거 없는 보기용. 끄면(0) 게임 식 그대로)
// - 확산: 직접광 + 환경광을 합친 밝기(확산색 대비)를 1/s3Cel 단위로 끊어서 면이 단색 띠로 나오게
// - 직접 반사: 밝기 0.3을 넘는 곳만 같은 밝기(1)의 단색 하이라이트로
if (s3Cel > 0.5) {
    const vec3 s3Lum = vec3(0.299, 0.587, 0.114);
    float s3Base = max(dot(material.diffuseContribution, s3Lum), 1e-4);
    float s3Light = dot(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse, s3Lum) / s3Base;
    float s3Scale = s3Light > 1e-4 ? floor(s3Light * s3Cel + 0.5) / s3Cel / s3Light : 0.0;
    reflectedLight.directDiffuse *= s3Scale;
    reflectedLight.indirectDiffuse *= s3Scale;
    float s3Spec = dot(reflectedLight.directSpecular, s3Lum);
    reflectedLight.directSpecular = s3Spec > 0.3 ? reflectedLight.directSpecular / s3Spec : vec3(0.0);
}`)
        // 게임은 환경광(SH + 큐브)에 AO를 그대로 곱함. three.js는 환경맵이 있을 때만 반사에 AO를 (다른 식으로) 곱해서 여기서 곱함
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n#ifdef USE_AOMAP\nif (s3EnvOn > 0.5) reflectedLight.indirectSpecular *= ambientOcclusion;\n#endif');
}

// 인게임 출력: Hoian Viewer의 최종 패스(PlayerViewer/UI/Shaders/Resolve.frag)와 같게 톤맵 없이 clamp → pow(1/2.2)
// 게임 HDR 합성의 톤맵·노출은 노출 값을 확정할 수 없어서 안 씀 (lighting_findings.md §8, §10)
// GAME_EXPOSURE는 게임 값이 아니라 보기용 조절 (전체가 밝아 보여서 사용자 요청으로 살짝 낮춤. 1이면 Hoian과 같음)
const GAME_EXPOSURE = 0.85;
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace('vec3 CustomToneMapping( vec3 color ) { return color; }', `vec3 CustomToneMapping( vec3 color ) {
    vec3 g = pow(clamp(color * toneMappingExposure, 0.0, 1.0), vec3(1.0 / 2.2));
    // 뒤에서 three.js가 sRGB로 인코딩하므로 그만큼 되돌림 (sRGBTransferEOTF는 이 chunk보다 뒤에 선언돼서 직접 계산)
    return mix(pow(g * 0.9478672986 + 0.0521327014, vec3(2.4)), g * 0.0773993808, vec3(lessThanEqual(g, vec3(0.04045))));
}`);

const dirLight2 = new THREE.DirectionalLight(0xffffff, 4);
dirLight2.position.set(-1, 2, 1);
lightRig.add(dirLight2);

const bottomLight = new THREE.DirectionalLight(0xffffff, 0.8);
bottomLight.position.set(1, -2, -1); // 아래에서 위로
lightRig.add(bottomLight);

const bottomLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
bottomLight2.position.set(-1, -2, -1); // 아래에서 위로
lightRig.add(bottomLight2);

const ambientLight = new THREE.AmbientLight(0xffffff, 1); // 전체적인 밝기
scene.add(ambientLight);



const planeGeometry = new THREE.PlaneGeometry(10, 10); // 아주 넓은 바닥
const planeMaterial = new THREE.MeshStandardMaterial({ 
    color: 0x808080, // 회색 바닥
    roughness: 0.8,
    metalness: 0.1
});

planeMaterial.onBeforeCompile = addGameEnv;
const floor = new THREE.Mesh(planeGeometry, planeMaterial);

// 2. 바닥 눕히기 (기본은 서 있는 상태이므로 X축으로 -90도 회전)
floor.rotation.x = -Math.PI / 2;

// 3. 모델보다 살짝 아래에 위치 (모델 위치에 따라 조정)
floor.position.y = -1.3;

// 4. 그림자를 받고 싶다면 (renderer 설정에 shadowMap.enabled = true 필요)
floor.receiveShadow = true;

scene.add(floor);
// 바닥은 숨겨둠 (사용자 요청). 다시 쓰려면 true
const FLOOR_ENABLED = false;
floor.visible = FLOOR_ENABLED;

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

// 조명 프리셋: 기본 = 위의 직접 조명들 + 빈 환경맵, 스튜디오 = RoomEnvironment 환경맵만 (금속 반사용)
// (HDRI 프리셋 쇼핑몰·채석장·바다 노을은 사용자 요청으로 뺌)
const directLights = [hemiLight, dirLight, dirLight2, bottomLight, bottomLight2, ambientLight];
const LIGHT_PRESETS = {
    default: { environment: pmremGenerator.fromScene(new THREE.Scene()).texture, directLights: true },
    studio: { environment: pmremGenerator.fromScene(new RoomEnvironment()).texture, directLights: false },
    // 인게임 = 게임 장비 뷰어의 주광 + SH + 큐브 (위 gameLight, gameEnv). 출력은 Hoian Viewer와 같은 pow(1/2.2) (CustomToneMapping, 톤맵 곡선 없음)
    game: { directLights: false, inGame: true },
};
// 배경 색: 잉크 색 아래 색 선택 (프리셋 흰색·밝은 회색·회색·어두운 회색·검은색 + 직접 고르기). 기본은 원래 배경색 #a0a0a0
const bgColorInput = document.getElementById('bg-color-input');
bgColorInput.addEventListener('input', () => BACKGROUND_COLOR.set(bgColorInput.value));
let presetSeq = 0;
async function applyLightPreset(name) {
    const seq = ++presetSeq;
    const preset = LIGHT_PRESETS[name] ?? LIGHT_PRESETS.game; // 없는 값(브라우저가 기억한 옛 선택 등)이면 인게임
    if (preset.inGame) await loadGameEnvAtlas();
    if (seq !== presetSeq) return; // 받는 동안 다른 프리셋이 선택됨
    scene.environment = preset.environment ?? null;
    renderer.toneMapping = preset.inGame ? THREE.CustomToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = preset.inGame ? GAME_EXPOSURE : 1;
    floor.visible = FLOOR_ENABLED;
    for (const light of directLights) light.visible = preset.directLights;
    gameLight.visible = !!preset.inGame;
    gameEnv.s3EnvOn.value = preset.inGame ? 1 : 0;
}
const lightSelect = document.getElementById('light-preset');
lightSelect.addEventListener('change', () => applyLightPreset(lightSelect.value));
applyLightPreset(lightSelect.value);

// 조명 방향: 수직축 기준으로 직접 조명, 환경맵(조명)을 함께 돌림. 무기 회전과 따로 빛 방향을 정할 수 있음
const lightAngle = document.getElementById('light-angle');
const rad = THREE.MathUtils.degToRad(lightAngle.valueAsNumber);
lightRig.rotation.y = rad;
scene.environmentRotation.y = rad;
gameEnv.s3EnvRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-rad));
lightAngle.addEventListener('input', () => {
    const rad = THREE.MathUtils.degToRad(lightAngle.valueAsNumber);
    lightRig.rotation.y = rad;
    scene.environmentRotation.y = rad;
    gameEnv.s3EnvRot.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(-rad));
});



// 3. 카메라는 이동/확대만 담당하고, 회전은 모델 쪽에서 처리 (아래 modelPivot)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 부드러운 회전 감도
controls.enableRotate = false;

// 모델 중심을 회전축으로 쓰기 위한 부모 그룹 (원점에 고정)
const modelPivot = new THREE.Group();
scene.add(modelPivot);

// 드래그 방향을 카메라 기준 축으로 바꿔 모델을 회전 → 각도 제한 없음
const ROTATE_SPEED = 0.01; // 1px당 라디안
const activePointers = new Set();
let lastX = 0, lastY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || gizmo.enabled) return; // 축 회전 모드에서는 기즈모가 처리
    activePointers.add(e.pointerId);
    lastX = e.clientX;
    lastY = e.clientY;
});
renderer.domElement.addEventListener('pointermove', (e) => {
    if (activePointers.size !== 1 || !activePointers.has(e.pointerId)) return; // 두 손가락은 확대/이동용
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    modelPivot.quaternion
        .premultiply(new THREE.Quaternion().setFromAxisAngle(camUp, dx * ROTATE_SPEED))
        .premultiply(new THREE.Quaternion().setFromAxisAngle(camRight, dy * ROTATE_SPEED));
    showRotation();
});
for (const type of ['pointerup', 'pointercancel']) {
    renderer.domElement.addEventListener(type, (e) => activePointers.delete(e.pointerId));
}

// 회전값 직접 입력 UI (월드 X/Y/Z축, Euler XYZ 순서, 단위: 도)
const rotInputs = ['x', 'y', 'z'].map((axis) => document.getElementById(`rot-${axis}`));
function showRotation() {
    const r = modelPivot.rotation;
    [r.x, r.y, r.z].forEach((rad, i) => {
        if (rotInputs[i] === document.activeElement) return; // 자동 회전 중에도 입력 중인 칸은 덮어쓰지 않음
        rotInputs[i].value = +THREE.MathUtils.radToDeg(rad).toFixed(1);
    });
}
rotInputs.forEach((input, i) => input.addEventListener('input', () => {
    const deg = input.valueAsNumber;
    if (Number.isNaN(deg)) return; // 입력 도중의 빈 값이나 '-'는 무시
    modelPivot.rotation['xyz'[i]] = THREE.MathUtils.degToRad(deg);
}));
document.getElementById('rot-reset').addEventListener('click', () => {
    modelPivot.rotation.set(0, 0, 0);
    showRotation();
});
showRotation();

// 축 회전 모드: 블렌더식 회전 기즈모 (X/Y/Z 링 + 화면 기준 E 링)
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setMode('rotate');
gizmo.attach(modelPivot);
gizmo.enabled = false;
gizmo.getHelper().visible = false;
scene.add(gizmo.getHelper());
gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
gizmo.addEventListener('objectChange', showRotation);

// 안쪽 자유 회전(XYZE)은 쓰지 않으므로 그 영역을 표시하는 회색 원 제거
const rotateHandles = gizmo._gizmo.gizmo.rotate;
rotateHandles.remove(rotateHandles.getObjectByName('XYZE'));

// 링을 정확히 누르지 않아도, 화면상 RING_PICK_PX 이내의 가장 가까운 링을 잡게 함
const RING_PICK_PX = 40;
const ringVertex = new THREE.Vector3();
function nearestRing(pointer) {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    const px = (pointer.x + 1) / 2 * w, py = (1 - pointer.y) / 2 * h;
    let best = null, bestDist = RING_PICK_PX;
    for (const handle of gizmo._gizmo.gizmo.rotate.children) {
        if (!handle.visible) continue;
        const pos = handle.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            ringVertex.fromBufferAttribute(pos, i).applyMatrix4(handle.matrixWorld).project(activeCamera);
            const d = Math.hypot((ringVertex.x + 1) / 2 * w - px, (1 - ringVertex.y) / 2 * h - py);
            if (d < bestDist) { bestDist = d; best = handle.name; }
        }
    }
    return best;
}
const originalPointerHover = gizmo.pointerHover.bind(gizmo);
gizmo.pointerHover = (pointer) => {
    if (gizmo.dragging) return;
    originalPointerHover(pointer);
    if (gizmo.axis === null || gizmo.axis === 'XYZE') gizmo.axis = nearestRing(pointer);
};

// X/Y/Z 링 드래그를 각도 추적 방식으로: 포인터가 링 평면 위에서 중심 기준으로 돈 각도만큼 회전
// (TransformControls 기본은 드래그 직선 거리로 계산해서 손이 링을 따라가지 않음)
const EDGE_ON_COS = 0.15; // 링이 거의 옆으로 보이면 평면 교차가 불안정 → 이때만 기본 방식 사용
const AXIS_VECTORS = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };
const ringDrag = {
    active: false,
    axis: null,
    plane: new THREE.Plane(),
    center: new THREE.Vector3(),
    startVec: new THREE.Vector3(),
    startQuat: new THREE.Quaternion(),
};
const ringRaycaster = new THREE.Raycaster();
const ringHit = new THREE.Vector3();
const ringCross = new THREE.Vector3();
const ringQuat = new THREE.Quaternion();
function ringPlanePoint(pointer) {
    ringRaycaster.setFromCamera(pointer, activeCamera);
    return ringRaycaster.ray.intersectPlane(ringDrag.plane, ringHit);
}
const originalPointerDown = gizmo.pointerDown.bind(gizmo);
gizmo.pointerDown = (pointer) => {
    originalPointerDown(pointer);
    ringDrag.active = false;
    if (!gizmo.dragging || !(gizmo.axis in AXIS_VECTORS)) return;
    ringDrag.axis = AXIS_VECTORS[gizmo.axis];
    modelPivot.getWorldPosition(ringDrag.center);
    const toCamera = ringCross.subVectors(activeCamera.position, ringDrag.center).normalize();
    if (Math.abs(ringDrag.axis.dot(toCamera)) < EDGE_ON_COS) return;
    ringDrag.plane.setFromNormalAndCoplanarPoint(ringDrag.axis, ringDrag.center);
    if (!ringPlanePoint(pointer)) return;
    ringDrag.startVec.subVectors(ringHit, ringDrag.center);
    ringDrag.startQuat.copy(modelPivot.quaternion);
    ringDrag.active = true;
};
const originalPointerMove = gizmo.pointerMove.bind(gizmo);
gizmo.pointerMove = (pointer) => {
    if (!ringDrag.active) return originalPointerMove(pointer);
    if (!ringPlanePoint(pointer)) return;
    const current = ringHit.sub(ringDrag.center);
    const angle = Math.atan2(ringCross.crossVectors(ringDrag.startVec, current).dot(ringDrag.axis), ringDrag.startVec.dot(current));
    modelPivot.quaternion.copy(ringQuat.setFromAxisAngle(ringDrag.axis, angle)).multiply(ringDrag.startQuat);
    gizmo.dispatchEvent({ type: 'objectChange' });
};

const modeButton = document.getElementById('rot-mode');
modeButton.addEventListener('click', () => {
    gizmo.enabled = !gizmo.enabled;
    gizmo.getHelper().visible = gizmo.enabled;
    setText(modeButton, gizmo.enabled ? 'rot.modeAxis' : 'rot.modeFree');
});

// 자동 회전: 월드 Y축(화면 위쪽) 기준 턴테이블 회전
const AUTO_ROTATE_SPEED = Math.PI / 5; // 라디안/초 (10초에 한 바퀴), 슬라이더 배율 1일 때
const speedSlider = document.getElementById('rot-speed'); // 배율 0.66 ~ 4.0
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const autoRotateQuat = new THREE.Quaternion();
let autoRotate = false;
const autoButton = document.getElementById('rot-auto');
autoButton.addEventListener('click', () => {
    autoRotate = !autoRotate;
    setText(autoButton, autoRotate ? 'rot.autoOn' : 'rot.autoOff');
    speedSlider.parentElement.hidden = !autoRotate; // 속도 슬라이더는 자동 회전 중에만 표시
});

// 패널 숨기기/펼치기 (애니메이션과 아이콘 방향은 CSS의 collapsed 클래스가 담당)
// 패널마다 접힘 상태를 localStorage에 기억. 기억한 값이 없으면 좁은 화면(폭 600px 이하)에서는 우측 패널 묶음을 접은 채로 시작 (무기 목록을 가리지 않게)
const COLLAPSE_KEY = 's3viewer-collapsed';
let collapsedSaved = {};
try { collapsedSaved = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) ?? {}; } catch { /* 기억 없이 기본값 */ }
const narrowScreen = matchMedia('(max-width: 600px)').matches;
for (const btn of document.querySelectorAll('.toggle-btn')) {
    const panel = btn.parentElement;
    panel.classList.toggle('collapsed', collapsedSaved[panel.id] ?? (narrowScreen && panel.closest('#right-stack') !== null));
    btn.addEventListener('click', () => {
        collapsedSaved[panel.id] = panel.classList.toggle('collapsed');
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedSaved)); } catch { /* 기억만 못 함 */ }
    });
}



const teamColor = new THREE.Color(0xFEDC0C);

function disposeModel(model) {
    model.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.dispose();
        if (child.isSkinnedMesh) child.skeleton.dispose(); // boneTexture 해제
        for (const mat of [].concat(child.material)) {
            const uniformValues = Object.values(mat.userData).map((u) => u.value);
            for (const v of [...Object.values(mat), ...uniformValues]) {
                if (v?.isTexture) v.dispose();
            }
            mat.dispose();
        }
    });
}

let loadSeq = 0; // 가장 마지막으로 요청한 로드만 씬에 추가하기 위한 번호

function clearModel() {
    if (currentModel) {
        modelPivot.remove(currentModel);
        disposeModel(currentModel);
        currentModel = null;
    }
    for (const m of mixers) {
        m.stopAllAction();
        m.uncacheRoot(m.getRoot());
    }
    mixers = [];
    uvProxies.length = 0;
    // animBar는 여기서 숨기지 않는다. 로드가 끝날 때 한 번에 갱신해서 로드 중에 바가 깜빡이지 않게
}
function hideAnimControls() {
    for (const control of animControls) control.hidden = true;
}
function updateAnimBar() {
    animBar.hidden = animControls.every((control) => control.hidden);
}
// animBar 글자(index.html의 data-i18n-cat)는 무기군마다 따로: i18n.js 키 '<무기군>.<이름>' (예: blaster.fire, charger.fire). 같은 한국어라도 무기군마다 번역을 따로 정함
let animCat = 'shooter';
function setCatText(el, base) {
    el.dataset.i18nCat = base;
    setText(el, `${animCat}.${base}`);
}
function relabelAnimBar(path) {
    animCat = path.match(/Wmn_([A-Za-z]+)_/)[1].toLowerCase();
    for (const el of animBar.querySelectorAll('[data-i18n-cat]')) setCatText(el, el.dataset.i18nCat);
}

// 모델 애니메이션 (게임 데이터, tools/build_glb.py가 glb에 넣음)
// - 두 상태 전환(SWITCHES): 'Open'/'Close' (롤러 접기/펴기, 붓 대기/밀기. 무기군마다 prefix로 따로), 'TransformToWait'/'TransformToAttack' (빈센트), 'Shot_Long_St'/'Shot_Short_St' (소방 FF 사격 모드).
//   본 + 본 보임/숨김(와이드 롤러 빨대, 소방 FF 튜브) + 셰이더 파라미터(와이드 롤러 헤드 UV)
// - 반복: 'Open_Loop'(쿠마 롤러 엔진, 기본 꺼짐), 이름이 '_auto'인 셰이더 파라미터 애니메이션(히어로 슈터 발광, 기본 켜짐),
//   'Shot'(이그재미너 카트리지 보임/숨김, 기본 꺼짐)
// - 한 번 재생(FIRES): 본 애니메이션인 'Shot'(R-PEN Bullet 본 반동, 블래스터 반동 + 라이트·쇼트 M_Body 발광), 'JumpShot'(프리시전 블래스터),
//   'Attack'(빈센트), 'Wmn_Slosher_Coop'(베어표 슬로셔 휘두르기 발광).
//   버튼을 누를 때마다 처음부터
// - 슬라이더(SCRUBS): 'Deform'/'DeformEmm'(쿠겔 슈라이버 본·병 발광), 이름이 '_Charge'인 셰이더 파라미터 애니메이션(소이 튜버·스퀵 클린 차지 발광).
//   슬라이더 값이 재생 위치 (게임에서 차지 양으로 움직이는지는 추측)
//   'Bullet'(R-PEN): 프레임 n에서 Bullet01~0n이 보임 (게임 데이터). 그래서 슬라이더 값을 프레임(탄 수 0~5)으로 씀. 게임이 남은 탄 수로 프레임을 정하는지는 추측
// 양손(머뉴버)이면 모델마다 mixer를 따로 두고 같은 조작을 양쪽에 함께 적용
let mixers = [];
const uvProxies = []; // {proxy, material}: tex_mtx0 이동을 proxy.position으로 재생해서 매 프레임 텍스처에 반영
const animBar = document.getElementById('anim-bar');
// 버튼을 누르면 반대쪽 클립을 한 번 재생하고 끝 자세를 유지. 첫 클립의 끝 자세로 시작하고, labels[상태]가 버튼 글자 (i18n.js 키)
// prefix: 이 무기군 파일에만 적용 (롤러·붓·셸터는 같은 Open/Close 이름이라도 동작이 달라서 무기군마다 따로 둠)
// rest: 첫 클립의 끝 자세가 바인드 자세와 같아서 처음에 재생하지 않음 (빈센트 TransformToWait 끝 = 바인드. 재생해 두면 털 클립과 섞임, 아래 참고)
const SWITCHES = [
    { button: document.getElementById('fold-toggle'), clips: ['Open', 'Close'], labels: ['roller.fold', 'roller.unfold'], prefix: 'Wmn_Roller_' },
    // 붓: Close 끝 = 대기(털 모임)가 기본, Open 끝 = 밀기(털 벌어짐)
    { button: document.getElementById('brush-toggle'), clips: ['Close', 'Open'], labels: ['brush.push', 'brush.wait'], prefix: 'Wmn_Brush_' },
    { button: document.getElementById('shot-toggle'), clips: ['Shot_Long_St', 'Shot_Short_St'], labels: ['shot.toShort', 'shot.toLong'] },
    { button: document.getElementById('pose-toggle'), clips: ['TransformToWait', 'TransformToAttack'], labels: ['brush.toAttack', 'brush.toWait'], prefix: 'Wmn_Brush_', rest: true },
    // 셸터: Open 끝 = 펼친 상태가 기본 (게임 OpenFully 기준값과 차이 0.2% 이내, fska_dump로 비교), Close 끝 = 접힌 우산 모델(Umbrella_Close)만 보임.
    // 사출(shelterEject, 아래 loadGlb) 중에는 안 씀. 베어표 셸터는 애니메이션이 없어서 안 나옴
    // fillVis: 도돌이 우산은 Open에 보임/숨김 커브가 없어서 펼친 상태에서 접힌 우산도 보였음. Close의 첫 프레임(= 펼친 상태)에서 Umbrella_Close가 숨겨져 있으므로
    //   한쪽 클립에 없는 보임/숨김 트랙은 반대쪽 클립의 첫 값으로 채움 (반대쪽 클립은 이 클립의 끝 상태에서 시작함)
    // endFrame: 이 파일들은 두 클립을 해당 프레임에서 끝냄. 도돌이 우산은 게임 원본 Open·Close(15프레임)의 마지막 15프레임 키가 바인드 값으로 튐
    //   (Close: Slider 0.404 → 0.654 등 접힌 자세가 펼친 자세로, Open: Shoelaces). 14프레임에서 멈춤 (사용자 확인: 게임에선 접힌 손잡이가 접힌 모양)
    { button: document.getElementById('shelter-toggle'), clips: ['Open', 'Close'], labels: ['shelter.fold', 'shelter.unfold'], prefix: 'Wmn_Shelter_', when: () => !shelterEject, fillVis: true, endFrame: { Wmn_Shelter_Focus: 14 } },
];
const LOOP_TOGGLES = [
    { input: document.getElementById('anim-glow'), match: (name) => name.endsWith('_auto'), initial: true },
    { input: document.getElementById('anim-engine'), match: (name) => name === 'Open_Loop', initial: false },
    // 이그재미너 Shot: 게임 데이터는 22프레임까지 카트리지가 바뀌고 72프레임까지 B로 멈춤. 사용자 요청으로 바뀌는 구간만 끊김 없이 반복 (seamless)
    // 이름이 같은 R-PEN Shot(본 애니메이션)은 FIRES가 맡으므로 보임/숨김 트랙이 있는 클립만
    { input: document.getElementById('anim-shot'), match: (name, clip) => name === 'Shot' && clip.tracks.some((t) => t.ValueTypeName === 'bool'), initial: false, seamless: true },
];
const FIRES = [
    { button: document.getElementById('fire-button'), match: (name, clip) => name === 'Shot' && clip.tracks.every((t) => t.ValueTypeName !== 'bool') },
    { button: document.getElementById('jump-fire-button'), match: (name) => name === 'JumpShot' },
    { button: document.getElementById('attack-button'), match: (name) => name === 'Attack' },
    // 베어표 슬로셔 'Wmn_Slosher_Coop': M_Body 발광 + 발광 맵 UV1 이동 (게임 액터 AS의 'Swing' 노드가 이 애니메이션을 가리킴). 빈센트 버튼과 별개
    { button: document.getElementById('slosher-swing-button'), match: (name) => name === 'Wmn_Slosher_Coop' },
];
const SCRUBS = [
    { input: document.getElementById('anim-charge'), match: (name) => name === 'Deform' || name === 'DeformEmm' || name.endsWith('_Charge') },
    { input: document.getElementById('anim-bullet'), match: (name) => name === 'Bullet', frames: true },
];
const inkToggle = document.getElementById('anim-ink'); // 해제하면 잉크 칠 영역(롤러 헤드 등)이 칠해지지 않은 상태로 보임. 모델을 바꿔도 유지
const inkPaint = { value: inkToggle.checked ? 1 : 0 }; // 셰이더 uniform
inkToggle.addEventListener('change', () => { inkPaint.value = inkToggle.checked ? 1 : 0; });
const animControls = [...SWITCHES.map((sw) => sw.button), ...FIRES.map((f) => f.button), inkToggle.parentElement, ...LOOP_TOGGLES.map((t) => t.input.parentElement), ...SCRUBS.map((s) => s.input.parentElement)];
const UV_TARGETS = { 16: 'x', 20: 'y' }; // tex_mtx 안의 바이트 오프셋 → 이동 축 (scale x/y, rotate 다음)
// tex_mtx0은 UV0, tex_mtx1은 UV1 이동 (decompile: 쿠겔 슈라이버 M_Bottle에서 알베도 UV0 × tex_mtx0, emission UV1 × tex_mtx1)
const UV_CHANNELS = { tex_mtx0: 0, tex_mtx1: 1 };

// glb에 extras로 들어 있는 보임/숨김·셰이더 파라미터 애니메이션을 three.js 트랙으로 만들어 같은 이름의 클립에 붙임
function buildClips(gltf) {
    const clips = new Map(gltf.animations.map((clip) => [clip.name, clip]));
    const clipFor = (name) => clips.get(name) ?? clips.set(name, new THREE.AnimationClip(name, -1, [])).get(name);
    const materials = new Set();
    gltf.scene.traverse((obj) => {
        for (const [name, keys] of Object.entries(obj.userData.s3?.visibility ?? {})) {
            clipFor(name).tracks.push(new THREE.BooleanKeyframeTrack(`${obj.uuid}.visible`, keys.map((k) => k[0]), keys.map((k) => k[1])));
        }
        if (!obj.isMesh || materials.has(obj.material)) return;
        materials.add(obj.material);
        for (const [name, anim] of Object.entries(obj.material.userData.s3?.param_anims ?? {})) {
            for (const track of anim.tracks) {
                if (track.param === 'emission_intensity') {
                    clipFor(name).tracks.push(new THREE.NumberKeyframeTrack(`${obj.uuid}.material.emissiveIntensity`, track.times, track.values));
                } else if (track.param in UV_CHANNELS && track.target in UV_TARGETS) {
                    const channel = UV_CHANNELS[track.param];
                    let entry = uvProxies.find((e) => e.material === obj.material && e.channel === channel);
                    if (!entry) {
                        entry = { proxy: new THREE.Object3D(), material: obj.material, channel };
                        entry.proxy.position.set(...(obj.material.userData.texSrt?.[channel]?.translate ?? [0, 0]), 0); // 멈추면 mixer가 정적 이동 값으로 되돌림
                        gltf.scene.add(entry.proxy);
                        uvProxies.push(entry);
                    }
                    clipFor(name).tracks.push(new THREE.NumberKeyframeTrack(`${entry.proxy.uuid}.position[${UV_TARGETS[track.target]}]`, track.times, track.values));
                }
            }
        }
    });
    for (const clip of clips.values()) clip.resetDuration();
    return clips;
}

function setupAnimations(gltfs, path) {
    hideAnimControls();
    mixers = gltfs.map((gltf) => new THREE.AnimationMixer(gltf.scene));
    const clipSets = gltfs.map(buildClips);
    for (const gltf of gltfs) {
        gltf.scene.traverse((obj) => { if (obj.isMesh && obj.material.userData.paintMap?.value) inkToggle.parentElement.hidden = false; }); // 잉크 칠 영역이 있는 모델
    }
    for (const sw of SWITCHES) {
        if ((sw.prefix && !path.includes(sw.prefix)) || (sw.when && !sw.when()) || !sw.clips.every((name) => clipSets[0].has(name))) continue;
        const endFrame = Object.entries(sw.endFrame ?? {}).find(([file]) => path.includes(file))?.[1];
        if (endFrame !== undefined) {
            for (const clips of clipSets) {
                for (const name of sw.clips) {
                    const clip = clips.get(name);
                    clip.duration = endFrame / 60 + 1e-4; // 키 시각이 float32라 살짝 여유
                    clip.trim(); // duration 뒤의 키를 지움
                }
            }
        }
        if (sw.fillVis) {
            for (const clips of clipSets) {
                const pair = sw.clips.map((name) => clips.get(name));
                pair.forEach((clip, k) => {
                    const names = new Set(clip.tracks.map((t) => t.name));
                    for (const t of pair[1 - k].tracks) {
                        if (t.ValueTypeName === 'bool' && !names.has(t.name)) clip.tracks.push(new THREE.BooleanKeyframeTrack(t.name, [0], [t.values[0]]));
                    }
                });
            }
        }
        sw.actions = sw.clips.map((name) => clipSets.map((clips, i) => {
            const action = mixers[i].clipAction(clips.get(name));
            action.setLoop(THREE.LoopOnce);
            action.clampWhenFinished = true; // 끝 자세 유지
            return action;
        }));
        if (sw.rest) {
            sw.state = 0;
            setText(sw.button, sw.labels[0]);
        } else {
            playSwitch(sw, 0, true);
        }
        sw.button.hidden = false;
    }
    // 와이퍼 클립('Shot', 'Wmn_Saber_Light_Charge' 등)은 이름이 겹쳐도 아래 범용 조작에 넣지 않음. 와이퍼 조작은 setupSaber (무기군별 별개)
    const generic = !path.includes('Wmn_Saber_');
    for (const toggle of LOOP_TOGGLES) {
        toggle.actions = clipSets.flatMap((clips, i) => [...clips.values()].filter((c) => generic && toggle.match(c.name, c)).map((c) => {
            if (toggle.seamless) c.duration = seamlessDuration(c);
            return mixers[i].clipAction(c);
        }));
        if (!toggle.actions.length) continue;
        toggle.input.checked = toggle.initial;
        toggle.input.parentElement.hidden = false;
        if (toggle.initial) for (const action of toggle.actions) action.play();
    }
    for (const fire of FIRES) {
        fire.actions = clipSets.flatMap((clips, i) => [...clips.values()].filter((c) => generic && fire.match(c.name, c)).map((c) => {
            const action = mixers[i].clipAction(c);
            action.setLoop(THREE.LoopOnce); // 끝나면 멈추고 원래 자세로 돌아감
            return action;
        }));
        fire.button.hidden = !fire.actions.length;
    }
    if (!poseSwitch.button.hidden) attackFire.button.hidden = true; // 빈센트 Attack은 공격 자세에서 시작하고 끝남 (게임 데이터). 공격 자세일 때만
    for (const scrub of SCRUBS) {
        scrub.actions = clipSets.flatMap((clips, i) => [...clips.values()].filter((c) => generic && scrub.match(c.name)).map((c) => mixers[i].clipAction(c)));
        if (!scrub.actions.length) continue;
        for (const action of scrub.actions) {
            action.play();
            action.paused = true; // 재생하지 않고 슬라이더 위치에 고정
        }
        scrub.input.value = 0;
        applyScrub(scrub);
        scrub.input.parentElement.hidden = false;
    }
    return clipSets;
}
// 보임/숨김 반복 클립에서 값이 바뀌는 구간만: 마지막으로 바뀐 시각 + 그 직전 간격 (이그재미너 Shot: 22 + 2 = 24프레임, 6프레임 주기 4번)
function seamlessDuration(clip) {
    const changes = new Set();
    for (const track of clip.tracks) {
        for (let k = 1; k < track.times.length; k++) if (track.values[k] !== track.values[k - 1]) changes.add(track.times[k]);
    }
    const times = [0, ...changes].sort((a, b) => a - b);
    if (times.length < 2) return clip.duration;
    return times.at(-1) + (times.at(-1) - times.at(-2));
}
function applyScrub(scrub) {
    // frames: 슬라이더 값이 프레임 번호. 키 프레임 경계에서 어느 쪽 값인지 애매하지 않게 반 프레임 뒤를 봄
    for (const action of scrub.actions) action.time = scrub.frames ? (scrub.input.valueAsNumber + 0.5) / 60 : scrub.input.valueAsNumber * action.getClip().duration;
    for (const m of mixers) m.update(0);
    applyUvProxies();
}
for (const scrub of SCRUBS) scrub.input.addEventListener('input', () => applyScrub(scrub));
// R-PEN: 발사할 때마다 탄 수 슬라이더를 1 줄임 (사용자 요청. 게임 데이터의 Shot과 Bullet이 이렇게 연결되는지는 확인 못 함)
const bulletScrub = SCRUBS.find((s) => s.input.id === 'anim-bullet');
for (const fire of FIRES) {
    fire.button.addEventListener('click', () => {
        for (const action of fire.actions) action.reset().play();
        showFirstFrame();
        if (!bulletScrub.input.parentElement.hidden && bulletScrub.input.valueAsNumber > 0) {
            bulletScrub.input.value = bulletScrub.input.valueAsNumber - 1;
            applyScrub(bulletScrub);
        }
    });
}
for (const toggle of LOOP_TOGGLES) {
    toggle.input.addEventListener('change', () => {
        for (const action of toggle.actions) {
            if (toggle.input.checked) action.reset().play();
            else action.stop(); // 멈추면 원래 값으로 돌아감 (mixer가 원래 상태를 복원)
        }
        showFirstFrame();
    });
}

// tex_mtx 이동 → 그 머티리얼에서 같은 UV를 쓰는 텍스처 offset. UV0이면 Tcl/2cl용 uniform도, tex_mtx1이면 Resource 맵용 uniform도
function applyUvProxies() {
    for (const { proxy, material, channel } of uvProxies) setUvTransform(material, channel, proxy.position.x, proxy.position.y);
}
// tex_mtx0은 UV0, tex_mtx1은 UV1 맵에 (UV_CHANNELS). tx, ty: 이동 성분 (정적 값 또는 애니메이션 값)
// 정적 SRT(material.userData.s3.tex_srt, 지금은 와이퍼만. build_glb TEX_SRT_PREFIXES)가 있으면 게임 식: UV' = M·(u, v, 1). g3d Maya 모드 회전 0이면
//   u' = sx·(u − tx), v' = sy·(v + ty − 1) + 1 (Hoian BfshaRenderer.CalculateSRT2x3, s3_shader_analysis build_glb_audit 2.6. 예: 와이퍼 M_Stamp 세로 4배)
// tex_srt가 없는 머티리얼은 예전대로 이동 값을 그대로 더함 (위 식과 X 부호가 반대. 다른 무기군은 다시 변환하며 확인하기 전까지 그대로)
function setUvTransform(material, channel, tx, ty) {
    const srt = material.userData.texSrt?.[channel];
    const [sx, sy] = srt ? srt.scale : [1, 1];
    const ox = srt ? -sx * tx : tx;
    const oy = srt ? sy * (ty - 1) + 1 : ty;
    for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'emissiveMap']) {
        if (material[key]?.channel === channel) {
            material[key].repeat.set(sx, sy);
            material[key].offset.set(ox, oy);
        }
    }
    const [scale, offset] = channel === 0 ? [material.userData.uvScale, material.userData.uvOffset] : [material.userData.resUvScale, material.userData.resUvOffset];
    scale.value.set(sx, sy);
    offset.value.set(ox, oy);
}
// 버튼을 누른 그 프레임에 첫 프레임(또는 instant면 끝 자세)을 바로 반영. 다음 루프의 dt만큼 건너뛰지 않게
function showFirstFrame() {
    for (const m of mixers) m.update(0);
    applyUvProxies();
}
function playSwitch(sw, state, instant = false) {
    sw.state = state;
    for (const action of sw.actions[1 - state]) action.stop();
    for (const action of sw.actions[state]) {
        action.reset().play();
        if (instant) action.time = action.getClip().duration;
    }
    showFirstFrame();
    setText(sw.button, sw.labels[state]);
}
for (const sw of SWITCHES) sw.button.addEventListener('click', () => playSwitch(sw, 1 - sw.state));
// 빈센트: 털 클립(Open/Close)과 머리 클립(TransformTo*, Attack)이 둘 다 Brush_1·Brush_2 본 커브를 가짐. 같이 걸어 두면 three.js가 평균을 내서
// 게임 데이터에 없는 자세가 됨. 게임 AS(WeaponBrushHeavy.root.asb)가 둘을 어떻게 섞는지는 확인 못 해서, 나중에 누른 쪽 클립만 남긴다.
// 머리 쪽을 누르면 털 클립을 멈춤 (머리 클립 끝의 털 = Close 끝 = 바인드라 '대기' 상태), 털 쪽을 누르면 머리 클립을 멈춤 (바인드 = 대기 자세)
const brushSwitch = SWITCHES.find((sw) => sw.button.id === 'brush-toggle');
const poseSwitch = SWITCHES.find((sw) => sw.button.id === 'pose-toggle');
const attackFire = FIRES.find((f) => f.button.id === 'attack-button');
for (const button of [poseSwitch.button, attackFire.button]) {
    button.addEventListener('click', () => {
        attackFire.button.hidden = poseSwitch.state !== 1;
        for (const action of brushSwitch.actions.flat()) action.stop();
        brushSwitch.state = 0;
        setText(brushSwitch.button, brushSwitch.labels[0]);
    });
}
brushSwitch.button.addEventListener('click', () => {
    if (poseSwitch.button.hidden) return;
    for (const action of [...poseSwitch.actions.flat(), ...attackFire.actions]) action.stop();
    poseSwitch.state = 0;
    setText(poseSwitch.button, poseSwitch.labels[0]);
    attackFire.button.hidden = true;
});

// 모델을 중앙에 두고, 크기에 맞춘 기본 시점을 계산. 카메라는 첫 모델일 때만 옮기고, 무기를 바꿀 때는 보던 시점을 유지 (사용자 요청)
// depthPad: 카메라 쪽(-X)으로 튀어나온 만큼 카메라를 더 뒤로 (양손: 카메라 쪽 무기가 한 개일 때보다 가까워지는 만큼)
const defaultView = new THREE.Vector3();
let viewPlaced = false;
function resetView() {
    camera.position.copy(defaultView);
    controls.target.set(0, 0, 0);
    controls.update();
}
document.getElementById('view-reset').addEventListener('click', resetView); // 지금 모델 크기에 맞춘 기본 시점으로
function placeModel(object, depthPad = 0) {
    currentModel = object;
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)); // 모델이 화면에 꽉 차는 거리
    defaultView.set(-2 * cameraZ - depthPad, cameraZ / 2, 0); // 정측면(-X)에서 약간 위
    if (!viewPlaced) resetView();
    viewPlaced = true;
    modelPivot.add(object); // 회전은 이전 모델 것을 유지
}

// glb 머티리얼: 텍스처 역할(셰이더 샘플러 이름), render state, 파라미터는 변환 때 material.userData.s3에 기록됨 (tools/build_glb.py)
// 아래 규칙은 게임 셰이더(Hoian_UBER)를 decompile해서 확인한 계산을 따른다
const S3_MAPS = { roughnessMap: '_r0', metalnessMap: '_m0', aoMap: '_ao0', alphaMap: '_op0', emissiveMap: '_e0' };
async function setupS3Material(material, parser) {
    const { textures, options, render, params } = material.userData.s3;
    const load = (key) => textures[key] ? parser.getDependency('texture', textures[key].index) : null;
    for (const [prop, key] of Object.entries(S3_MAPS)) {
        const tex = await load(key);
        if (tex) material[prop] = tex;
    }
    // 맵이 없을 때는 Hoian_UBER 셰이더 기본값(roughness 0, metalness 0), 맵이 있으면 맵 값을 그대로 쓰도록 계수 1
    material.roughness = material.roughnessMap ? 1 : 0;
    material.metalness = material.metalnessMap ? 1 : 0;
    // 불투명이 아닌 머티리얼: alpha = opacity × opacity 맵. translucent·custom은 alpha blend, mask는 alpha test
    if (render) {
        material.opacity = params.opacity;
        material.transparent = render.blend;
        material.depthWrite = render.depth_write;
        if (render.alpha_test !== null) material.alphaTest = render.alpha_test;
    }
    // emission = 기준 색 × emission 맵 × emission_intensity. 기준 색은 emission_color_type 1: 알베도, 2: 잉크 색, 그 외: emission_color
    const emissionType = options.enable_emission === 'True' ? (options.emission_color_type ?? '0') : null;
    // emission 맵을 두 번째 UV로 읽음 (decompile: 쿠겔 슈라이버 M_Bottle의 cTexEmission은 UV0이 아닌 다른 정점 UV를 읽음)
    if (options.texcoord_select_emmmap === '2' && material.emissiveMap) material.emissiveMap.channel = 1;
    if (emissionType !== null) {
        material.emissive.fromArray(emissionType === '1' || emissionType === '2' ? [1, 1, 1] : params.emission_color);
        material.emissiveIntensity = params.emission_intensity;
    }
    // 조명 없는 머티리얼 (decompile: 래피드 블래스터 엘리트 M_Ray, program 12569): 색 = albedo_color × (1 + emission 맵 × intensity), 알베도 텍스처 없음
    // build_glb가 이 조합(enable_shading False, 알베도 텍스처 없음, emission_color_type 1)에만 albedo_color를 넣음
    const unlit = params?.albedo_color !== undefined;
    if (unlit) material.color.fromArray(params.albedo_color);
    // calc_color0: replace_color 2면 emission 맵 값 자리에 피연산자 A, B, C를 조합한 값을 씀
    // decompile 확인: 소이 튜버 M_Body (계산 5, A 3, B 9, C 50) = Emm × 잉크 색 + Resource0, 스퀵 클린 M_Bottle (계산 2, A 3, B 10) = Emm × Resource1
    //   블래스터 쇼트 M_Body (계산 1, A 50, B 3) = 잉크 색 × Emm + 잉크 색
    // 피연산자 3: emission 맵, 9/10: Resource0/1 맵, 50: 잉크 색. 계산 1: A × B + A, 2: A × B, 5: A × C + B. 확인한 조합만 쓰고 나머지 머티리얼은 emission 맵 그대로
    // Resource 맵은 texcoord_select_resN 2일 때 셰이더 정점 입력 _u2 × tex_mtx1로 읽음 (decompile 두 머티리얼 공통)
    const calc = options.enable_calc_color0 === 'True' && options.blitz_calc_color0_replace_color === '2'
        ? { type: options.blitz_calc_color0_calc_type, A: options.blitz_calc_color0_A, B: options.blitz_calc_color0_B, C: options.blitz_calc_color0_C } : null;
    const RES = { 9: 0, 10: 1 }; // 피연산자 → Resource 번호
    const resIndex = calc ? [calc.A, calc.B, calc.C].map((op) => RES[op]).find((i) => i !== undefined) : undefined;
    const resMap = resIndex !== undefined && options[`texcoord_select_res${resIndex}`] === '2' ? await load(`_re${resIndex}`) : null;
    const OPERANDS = { 3: 's3Emm', 9: 's3Res', 10: 's3Res', 50: 'teamColor' };
    const calcOps = calc && { 1: [calc.A, calc.B], 2: [calc.A, calc.B], 5: [calc.A, calc.B, calc.C] }[calc.type];
    const calcExpr = !calcOps || !calcOps.every((op) => op in OPERANDS) || (resIndex !== undefined && !resMap) ? null
        : { 1: `${OPERANDS[calc.A]} * ${OPERANDS[calc.B]} + ${OPERANDS[calc.A]}`, 2: `${OPERANDS[calc.A]} * ${OPERANDS[calc.B]}`, 5: `${OPERANDS[calc.A]} * ${OPERANDS[calc.C]} + ${OPERANDS[calc.B]}` }[calc.type];
    // normalize_emission (decompile: 블래스터 쇼트 M_Body. 확인한 건 calc_color0 계산 1과 함께 쓰는 이 머티리얼뿐이라 이 조합만. 스트링거 Coop M_Receiver는 미확인이라 그대로)
    // - emission = Emm × 계산 결과. 기준 색·emission_intensity는 곱하지 않음 (emission_normalize_offset도 더하지만 이 머티리얼은 0)
    // - 그다음 최종 색 C(조명 + emission)를 N = C × (1 + k × (I / 밝기(C) − 1))로 맞춤. k = clamp(|Emm|), I = emission_intensity.
    //   I > 1이면 N, 아니면 C와 N을 I로 섞음. 평소(I = 0)엔 C 그대로이고, 발사 때 I가 커지면 Emm 영역의 밝기가 I가 됨
    const normalize = options.normalize_emission === 'True' && calc?.type === '1' && calcExpr !== null;
    // 셰이더 _u2 자리에 들어가는 정점 속성: _u0이면 UV0, 아니면 두 번째 UV (스퀵 클린 M_Bottle은 _u2 그대로라 glb의 두 번째 UV)
    const resUv = (material.userData.s3.attributes?._u2 ?? '_u2') === '_u0' ? 'uv' : 'uv1';
    material.userData.resMap = { value: resMap };
    material.userData.resUvOffset = { value: new THREE.Vector2() }; // tex_mtx1 이동·크기 (setUvTransform)
    material.userData.resUvScale = { value: new THREE.Vector2(1, 1) };
    const tclMap = await load('_su0');
    // 알베도 텍스처를 끈 머티리얼만 전체가 잉크 색 (예: 스플랫 슈터 병). team_color_map_type 3이어도 알베도가 있으면 알베도 그대로 (예: 새싹/단풍 슈터 캡·스티커)
    const fullTeamColor = options.team_color_map_type === '3' && options.enable_albedo_tex === 'False';
    // 잉크가 묻는 표면 (롤러 헤드, 붓 털 등): 2cl 맵의 흰 영역이 잉크로 덮여서 잉크 색이 됨
    // decompile: 칠 양 = clamp(2cl + 칠 세기 − 1). 칠 세기 자리의 bfres 값은 롤러와 노틸러스 모두 0이라 게임 코드가 채우는 것으로 보임.
    // 그래서 무기 자체에 늘 잉크가 묻어 있는 enable_private_paint_thickness 머티리얼만 칠함 (노틸러스 몸통은 2cl이 전부 흰색이지만 이 옵션이 없고, 게임에서도 칠해져 있지 않음)
    const paintMap = options.blitz_paint_type === '4' && options.enable_private_paint_thickness === 'True' ? await load('_cp0') : null;
    material.userData.tclMap = { value: tclMap }; // userData에 둬야 disposeModel이 해제함
    material.userData.paintMap = { value: paintMap };
    material.userData.uvOffset = { value: new THREE.Vector2() }; // tex_mtx0 이동·크기 (Tcl/2cl 맵용. 나머지 맵은 texture.offset·repeat, setUvTransform)
    material.userData.uvScale = { value: new THREE.Vector2(1, 1) };
    const tcl = tclMap ? 'texture2D(tclMap, vS3Uv).r' : fullTeamColor ? '1.0' : '0.0';
    const paint = paintMap ? 'texture2D(paintMap, vS3Uv).r * inkPaint' : '0.0';
    const emissionBase = { '1': 's3Albedo', '2': 'teamColor' }[emissionType] ?? 'vec3(1.0)';
    // manual fresnel: 반사율(F0)을 metalness 대신 manual_fresnel × manual_fresnel_color로 고정 (예: 볼드 마커 유리는 1.0이라 거울처럼 반사)
    // three.js에서 실제 F0로 쓰이는 값은 specularColorBlended (specularColor를 metalness로 섞은 값)
    const f0 = options.enable_manual_fresnel === 'True'
        ? `vec3(${params.manual_fresnel_color.map((c) => (c * params.manual_fresnel).toFixed(4)).join(', ')})` : null;
    // transfilm / edge light / transmission (decompile: 스퍼터리 OWL M_Twins_Short_Cstm02, 프라임 슈터 계열 M_Body)
    // - transfilm: film = sat(NoV^film_transmission_power × film_transmission_rate × Fxm). 확산색 = mix(albedo × (1 − metal), 막 색, film),
    //   SH를 읽는 법선 = mix(normal, 정점 법선, film). 정면일수록 막 색이 보임 (스퍼터리 OWL의 갈색)
    //   막 색 = under_film_color × (under_film_multicolor 0: 1, 1: albedo (머뉴버 롱 M_Body), 2: 잉크 색 (머뉴버 NormalT M_Bottle)). 3, 20, 30, 40은 미확인이라 transfilm을 안 함
    // - edge light: 확산색 += SH(−V) × edge_light_color × (1 − NoV)^edge_light_power × edge_light_intens × Fxm. 게임 SH가 있는 인게임 프리셋에서만
    // - transmission (enable_edge_transmission일 때): 직접광의 확산·반사 × (1 − t), t = transmission_rate × (1 − film).
    //   대신 t × 투과색 × 빛 세기 × (1 − NoV × sat(−NoL))^edge_transmission_power × ((s − 1)² × (sat(V·빛 진행 방향)^(1/s) − 0.2) + 0.2)를 더함 (s = scattering_rate)
    //   투과색 = Trm 맵 × transmission_color_backlight × (transmission_multi_color 1: 잉크 섞은 albedo, 2: 잉크 색). 0, 20, 30, 40은 미확인이라 안 함
    //   게임은 빛 색 대신 세기(gsys_environment row 5.w)만 곱함 → 빛 색의 최댓값으로 씀
    //   투과광의 그림자 = sat(1 − (1 − 그림자) × fp_c7[36].w), 뷰어 덤프 값 0.7 (first.a.frag:567). 빛 반대쪽 면도 30%는 비쳐 보임 (새싹 슈터 몸통)
    const S3_FIXED = (v) => Number(v).toFixed(5);
    const S3_VEC3 = (v) => `vec3(${v.map(S3_FIXED).join(', ')})`;
    const underFilm = params?.under_film_color && { '0': '', '1': ' * s3AlbedoInk', '2': ' * teamColor' }[options.under_film_multicolor ?? '0'];
    const film = options.enable_transfilm === 'True' && params?.film_transmission_rate !== undefined && underFilm !== undefined;
    const edgeLight = options.enable_edge_light === 'True' && params?.edge_light_intens !== undefined;
    const transColor = { '1': 's3AlbedoInk', '2': 'teamColor' }[options.transmission_multi_color];
    const trmMap = options.enable_taransmission === 'True' && options.enable_edge_transmission === 'True' && options.enable_transmission_map === 'True'
        && transColor && params?.transmission_rate !== undefined ? await load('_t0') : null;
    if (trmMap) trmMap.colorSpace = THREE.SRGBColorSpace; // 게임 텍스처 포맷이 BC1 SRGB
    // transmission_mask: t에 곱하는 마스크 (decompile: 이 옵션만 다른 프로그램 쌍 비교). 0: _re0, 1: _re1, 2: _fm0, 3(기본): 없음, 4: _re2 (r 채널, UV0)
    const transMaskKey = { '0': '_re0', '1': '_re1', '2': '_fm0', '4': '_re2' }[options.transmission_mask ?? '3'];
    const transMask = trmMap && transMaskKey ? await load(transMaskKey) : null; // 마스크 텍스처가 없으면 게임이 무엇을 읽는지 몰라서 투과를 끔 (t = 0)
    material.userData.transMaskMap = { value: transMask };
    const fmMap = (film || edgeLight || f0) && options.enable_sfxmask === 'True' ? await load('_fm0') : null;
    material.userData.trmMap = { value: trmMap };
    material.userData.fmMap = { value: fmMap };
    const fm = fmMap ? 'texture2D(fmMap, vS3Uv).r' : '1.0';
    // manual fresnel 마스크: enable_sfxmask면 F0 = mix(일반 F0(metalness로 0.04와 albedo를 섞은 값), manual F0, Fxm), 아니면 전체가 manual F0
    // (decompile: 이 옵션만 다른 프로그램 1905 ↔ 2003 비교. 소방 FF M_Body는 노란 고리 부분만 금색 반사)
    const f0Code = !f0 ? '' : options.enable_sfxmask === 'True'
        ? (fmMap ? `material.specularColorBlended = mix(material.specularColorBlended, ${f0}, ${fm});` : '') // Fxm 맵이 없으면 무엇을 읽는지 몰라서 manual fresnel을 안 씀
        : `material.specularColorBlended = ${f0};`;
    const filmCode = !film && !edgeLight ? '' : `float s3NoV = dot(normal, normalize(vViewPosition));
float s3Fm = ${fm};
${film ? `float s3Film = saturate(pow(saturate(max(s3NoV, 1e-3)), ${S3_FIXED(params.film_transmission_power)}) * ${S3_FIXED(params.film_transmission_rate)} * s3Fm);
material.diffuseContribution = mix(material.diffuseContribution, ${S3_VEC3(params.under_film_color)}${underFilm}, s3Film);
s3AmbNormal = mix(normal, nonPerturbedNormal, s3Film);
s3AmbNormalSet = true;` : 'float s3Film = 0.0;'}
${edgeLight ? `if (s3EnvOn > 0.5) material.diffuseContribution += max(s3ShIrradiance(s3EnvRot * transformDirectionByInverseViewMatrix(-normalize(vViewPosition), viewMatrix)), 0.0)
    * ${S3_VEC3(params.edge_light_color)} * pow(saturate(1.0 - s3NoV), ${S3_FIXED(params.edge_light_power)}) * ${S3_FIXED(params.edge_light_intens)} * s3Fm;` : ''}
`;
    const transCode = !trmMap ? '' : `s3TransRate = ${S3_FIXED(params.transmission_rate)}${transMask ? ' * texture2D(transMaskMap, vS3Uv).r' : transMaskKey ? ' * 0.0' : ''} * (1.0 - ${film ? 's3Film' : '0.0'});
s3TransColor = texture2D(trmMap, vS3Uv).rgb * ${S3_VEC3(params.transmission_color_backlight)} * ${transColor};
`;
    const transGlsl = !trmMap ? '' : `float s3TransRate = 0.0;
vec3 s3TransColor = vec3(0.0);
vec3 s3LightRaw = vec3(0.0); // 그림자를 곱하기 전 빛 색
void s3Direct(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
    ReflectedLight s3L = ReflectedLight(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0));
    RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, s3L);
    reflectedLight.directDiffuse += s3L.directDiffuse * (1.0 - s3TransRate);
    reflectedLight.directSpecular += s3L.directSpecular * (1.0 - s3TransRate);
    float s = ${S3_FIXED(params.scattering_rate)};
    float s1 = (s - 1.0) * (s - 1.0);
    float edge = pow(saturate(1.0 - dot(geometryNormal, geometryViewDir) * saturate(-dot(geometryNormal, directLight.direction))), ${S3_FIXED(params.edge_transmission_power)});
    float scatter = s1 * pow(saturate(max(dot(geometryViewDir, -directLight.direction), 1e-3)), 1.0 / s) - 0.2 * s1 + 0.2;
    float raw = max(max(s3LightRaw.r, s3LightRaw.g), s3LightRaw.b);
    float shadow = raw > 0.0 ? max(max(directLight.color.r, directLight.color.g), directLight.color.b) / raw : 1.0;
    reflectedLight.directDiffuse += s3TransColor * raw * saturate(1.0 - (1.0 - shadow) * 0.7) * edge * scatter * s3TransRate;
}
`;
    material.customProgramCacheKey = () => [tcl, paint, emissionBase, f0, calcExpr, resMap && resUv, normalize, unlit, f0Code, filmCode, transCode, transGlsl].join('|'); // 기본 키(onBeforeCompile 소스)는 머티리얼마다 같아서 셰이더가 섞일 수 있음
    material.onBeforeCompile = (shader) => {
        shader.uniforms.teamColor = { value: teamColor };
        shader.uniforms.tclMap = material.userData.tclMap;
        shader.uniforms.paintMap = material.userData.paintMap;
        shader.uniforms.inkPaint = inkPaint;
        shader.uniforms.s3UvOffset = material.userData.uvOffset;
        shader.uniforms.s3UvScale = material.userData.uvScale;
        shader.uniforms.s3ResUvScale = material.userData.resUvScale;
        shader.uniforms.resMap = material.userData.resMap;
        shader.uniforms.s3ResUvOffset = material.userData.resUvOffset;
        shader.uniforms.trmMap = material.userData.trmMap;
        shader.uniforms.fmMap = material.userData.fmMap;
        shader.uniforms.transMaskMap = material.userData.transMaskMap;
        // uv1은 three.js가 두 번째 UV를 쓰는 맵이 있을 때만 선언함
        shader.vertexShader = '#ifndef USE_UV1\nattribute vec2 uv1;\n#endif\nuniform vec2 s3UvOffset;\nuniform vec2 s3ResUvOffset;\nuniform vec2 s3UvScale;\nuniform vec2 s3ResUvScale;\nvarying vec2 vS3Uv;\nvarying vec2 vS3ResUv;\n' + shader.vertexShader.replace(
            '#include <uv_vertex>', `#include <uv_vertex>\nvS3Uv = uv * s3UvScale + s3UvOffset;\nvS3ResUv = ${resMap ? resUv : 'uv'} * s3ResUvScale + s3ResUvOffset;`);
        // 게임은 emission 맵 값을 계산 결과로 바꾼 뒤 기준 색 × emission_intensity를 곱함. three.js의 emissivemap_fragment가 emission 맵을 곱하는 자리를 바꿈
        const emissive = calcExpr
            ? `vec3 s3Emm = texture2D(emissiveMap, vEmissiveMapUv).rgb;\nvec3 s3Res = texture2D(resMap, vS3ResUv).rgb;\n`
                + (normalize ? `totalEmissiveRadiance = s3Emm * (${calcExpr});` : `totalEmissiveRadiance *= (${calcExpr}) * ${emissionBase};`)
            : `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= ${emissionBase};`;
        // 밝기 가중치 (0.298912, 0.586611, 0.114478)와 0 나눗셈 방지 1e-8: 블래스터 쇼트 프로그램의 상수 버퍼(fp_c1)에서 확인
        // three.js는 emission_intensity를 emissive 색에 곱해서 넘김. 이 머티리얼은 기준 색이 잉크 색이라 emissive 색이 흰색 → emissive.r이 intensity
        const normalizeCode = normalize ? 'float s3I = emissive.r;\nfloat s3K = clamp(length(s3Emm), 0.0, 1.0);\n'
            + 'vec3 s3N = outgoingLight * (1.0 + s3K * (s3I / max(dot(outgoingLight, vec3(0.298912, 0.586611, 0.114478)), 1e-8) - 1.0));\n'
            + 'outgoingLight = s3I > 1.0 ? s3N : mix(outgoingLight, s3N, s3I);\n' : '';
        shader.fragmentShader = 'uniform vec3 teamColor;\nuniform sampler2D tclMap;\nuniform sampler2D paintMap;\nuniform sampler2D resMap;\nuniform sampler2D trmMap;\nuniform sampler2D fmMap;\nuniform sampler2D transMaskMap;\nuniform float inkPaint;\nvarying vec2 vS3Uv;\nvarying vec2 vS3ResUv;\n' + shader.fragmentShader
            .replace('#include <map_fragment>',
                `#include <map_fragment>\nvec3 s3Albedo = diffuseColor.rgb;\ndiffuseColor.rgb = mix(diffuseColor.rgb, teamColor, max(${tcl}, ${paint}));\nvec3 s3AlbedoInk = diffuseColor.rgb;`)
            .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${transGlsl}`)
            .replace('#include <lights_fragment_begin>', trmMap ? THREE.ShaderChunk.lights_fragment_begin.replaceAll('RE_Direct( directLight,', 's3Direct( directLight,')
                .replace(/(get(?:Directional|Point|Spot)LightInfo\([^;]*;)/g, '$1\ns3LightRaw = directLight.color;') : '#include <lights_fragment_begin>')
            .replace('#include <emissivemap_fragment>', emissive)
            .replace('#include <opaque_fragment>', `${unlit ? 'outgoingLight = diffuseColor.rgb + totalEmissiveRadiance;\n' : ''}${normalizeCode}#include <opaque_fragment>`)
            .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${f0Code}\n${filmCode}${transCode}`);
        addGameEnv(shader);
    };
    // 정적 tex_mtx (setUvTransform). 회전이 있는 값은 무기에 없어서(build_glb_audit 2.6) 식을 확인 안 함 → 적용 안 함
    const texSrt = material.userData.s3.tex_srt;
    if (texSrt) {
        material.userData.texSrt = {};
        for (const [param, channel] of Object.entries(UV_CHANNELS)) {
            const srt = texSrt[param];
            if (!srt || srt.rotate !== 0) continue;
            material.userData.texSrt[channel] = srt;
            setUvTransform(material, channel, ...srt.translate);
        }
    }
    material.needsUpdate = true;
}

async function readGlb(path) {
    const gltf = await new GLTFLoader().loadAsync(path);
    const materials = new Set();
    gltf.scene.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.userData.s3?.hidden) child.visible = false; // 게임에서 기본으로 숨겨진 부품 (붙은 본이 invisible)
        materials.add(child.material);
        // GLTFLoader는 COLOR_0이 있으면 vertex color를 albedo에 곱하지만, 게임 셰이더는 vertex color를 입력으로 받지 않음
        // (decompile: 스플랫 머뉴버 M_Body, L3 릴 건 D 스티커). 머뉴버는 값이 거의 0이라 무기가 검게 나왔음
        child.material.vertexColors = false;
        // 그림자 전용 머티리얼 (render info gsys_dynamic_depth_shadow_only 1, 예: 스파이 가젯·도돌이 우산 M_Shadow): 화면에는 안 그리고 그림자만 드리움
        // (그림자 맵은 three.js가 따로 만든 깊이 머티리얼로 그려서 colorWrite와 무관)
        if (child.material.userData.s3?.shadow_only) {
            child.material.colorWrite = false;
            child.material.depthWrite = false;
        }
    });
    await Promise.all([...materials].map((m) => setupS3Material(m, gltf.parser)));
    return gltf;
}

// 양손 무기(머뉴버): 오른손은 <이름>.glb, 왼손은 <이름>_L.glb (게임 모델에 _L이 없으면 변환 때 오른손을 X축 대칭해서 만듦)
const handSelect = document.getElementById('hand-select');
const staggerToggle = document.getElementById('hand-stagger'); // 사선 배치 (양손일 때만)
animControls.push(handSelect.parentElement, staggerToggle.parentElement);
let lastGlb = null;
// 셸터 우산막 사출: 'canopy' 날아가는 우산막, 'handle' 손잡이, 'both' 둘 다 (거리를 두고), null 사출 안 함
// 게임 'Fly'(반복)는 본 커브만 있고 보임/숨김 커브가 없어서, 우산막(Umbrella_Open 셰이프)과 손잡이(Gun 셰이프)를 뷰어가 나눠 보여줌.
// Fly가 없는 우산(스파이 가젯, 베어표)은 사출 버튼을 숨김. 사출/회복 버튼으로 켜고 끄고, 사출 중에만 우산막/손잡이/모두 메뉴가 나옴
const ejectToggle = document.getElementById('shelter-eject-toggle');
const ejectSelect = document.getElementById('shelter-eject');
animControls.push(ejectToggle, ejectSelect.parentElement);
let ejected = false; // 사출 버튼 상태. 모델을 바꿔도 유지
// 히어로 슈터 레벨: 목록에는 하나만 두고 Msn0Lv0~2 파일을 슬라이더로 바꿔 불러옴
const HERO_LEVEL = /(Wmn_Shooter_Msn0Lv)(\d)/;
const heroLevel = document.getElementById('hero-level');
const heroLevelText = document.getElementById('hero-level-text');
animControls.push(heroLevel.parentElement);
heroLevel.addEventListener('input', () => {
    heroLevelText.textContent = `Lv${heroLevel.value}`;
    loadGlb(lastGlb.path.replace(HERO_LEVEL, `$1${heroLevel.value}`), lastGlb.twoHanded);
});
let shelterEject = null;
// 셰이프 이름 '<본>__<머티리얼>'의 본 (Gun, Umbrella_Open, Umbrella_Close)
function shelterPart(obj) {
    for (let o = obj; o; o = o.parent) {
        const m = o.name.match(/^(Gun|Umbrella_Open|Umbrella_Close)__/);
        if (m) return m[1];
    }
    return null;
}
// 보이는 메시만 감싸는 상자 (Box3.setFromObject는 숨긴 메시도 넣음)
function visibleBox(object) {
    const box = new THREE.Box3();
    object.updateMatrixWorld(true);
    object.traverse((obj) => { if (obj.isMesh && obj.visible) box.union(new THREE.Box3().setFromObject(obj)); });
    return box;
}
// 날아가는 우산막: Fly 트랙 + Fly에 커브가 없는 본·보임/숨김은 Open 끝 값으로 고정.
// 게임 Fly에서 커브가 없는 본의 기준값은 OpenFully와 같음 (fska_dump로 노멀·와이드·도돌이 비교), Open 끝 ≈ OpenFully (위 SWITCHES 참고)
function ejectClip(clips) {
    const fly = clips.get('Fly');
    const flyNames = new Set(fly.tracks.map((t) => t.name));
    const hold = clips.get('Open').tracks.filter((t) => !flyNames.has(t.name)).map((t) => {
        const size = t.getValueSize();
        return new t.constructor(t.name, [0], t.values.slice(-size));
    });
    return new THREE.AnimationClip('Fly_Eject', fly.duration, [...fly.tracks, ...hold]);
}

async function loadGlb(path, twoHanded = false) {
    const seq = ++loadSeq;
    lastGlb = { path, twoHanded };
    clearModel();
    const hand = twoHanded ? handSelect.value : 'R';
    const paths = { R: [path], L: [path.replace(/\.glb$/, '_L.glb')], both: [path, path.replace(/\.glb$/, '_L.glb')] }[hand];
    const shelter = path.includes('Wmn_Shelter_');
    try {
        const gltfs = await Promise.all(paths.map(readGlb));
        if (seq !== loadSeq) return; // 그 사이 다른 모델이 요청됨
        const canEject = shelter && gltfs[0].animations.some((clip) => clip.name === 'Fly');
        shelterEject = canEject && ejected ? ejectSelect.value : null;
        if (shelterEject === 'both') {
            gltfs.push(await readGlb(path)); // 우산막용으로 한 번 더 (첫 번째는 손잡이)
            if (seq !== loadSeq) return;
        }
        const clipSets = setupAnimations(gltfs, path);
        setupStringer(clipSets, path);
        setupSaber(gltfs, clipSets, path);
        // 일시정지/재생은 재생할 애니메이션이 있는 모델만 (머뉴버는 양손 선택 때문에 animBar가 떠도 애니메이션이 없음)
        pauseButton.hidden = !clipSets.some((clips) => [...clips.values()].some((clip) => clip.tracks.length));
        const level = path.match(HERO_LEVEL)?.[2];
        heroLevel.parentElement.hidden = level === undefined;
        if (level !== undefined) {
            heroLevel.value = level;
            heroLevelText.textContent = `Lv${level}`;
        }
        handSelect.parentElement.hidden = !twoHanded;
        staggerToggle.parentElement.hidden = !twoHanded || gltfs.length === 1;
        ejectToggle.hidden = !canEject;
        setText(ejectToggle, ejected ? 'shelter.recover' : 'shelter.eject');
        updateEjectToggle();
        ejectSelect.parentElement.hidden = !shelterEject;
        relabelAnimBar(path);
        updateAnimBar();
        if (shelterEject) {
            const [handle, canopy] = { canopy: [null, 0], handle: [0, null], both: [0, 1] }[shelterEject].map((i) => i === null ? null : gltfs[i]);
            if (handle) handle.scene.traverse((obj) => { if (obj.isMesh && shelterPart(obj) !== 'Gun') obj.visible = false; });
            if (canopy) {
                const i = gltfs.indexOf(canopy);
                mixers[i].clipAction(ejectClip(clipSets[i])).play();
                // 손잡이와 접힌 우산은 숨김 (도돌이 우산은 Open에 보임/숨김 커브가 없어서 Umbrella_Close도 직접 숨겨야 함. SWITCHES fillVis 참고)
                canopy.scene.traverse((obj) => { if (obj.isMesh && shelterPart(obj) !== 'Umbrella_Open') obj.visible = false; });
                showFirstFrame();
            }
            if (shelterEject !== 'both') {
                placeModel(gltfs[0].scene);
                return;
            }
            // 모두: 보이는 부분끼리 Z(우산 축)로 겹치지 않게 우산막을 우산막 쪽으로 옮기고, 손잡이 길이의 0.15만큼 더 띄움. 보기 위한 값 (게임 근거 없음)
            const handleBox = visibleBox(handle.scene);
            const canopyBox = visibleBox(canopy.scene);
            const gap = handleBox.getSize(new THREE.Vector3()).z * 0.15;
            canopy.scene.position.z += canopyBox.getCenter(new THREE.Vector3()).z > handleBox.getCenter(new THREE.Vector3()).z
                ? handleBox.max.z - canopyBox.min.z + gap : handleBox.min.z - canopyBox.max.z - gap;
            placeModel(new THREE.Group().add(handle.scene, canopy.scene));
            return;
        }
        if (gltfs.length === 1) {
            placeModel(gltfs[0].scene);
            return;
        }
        // 양손: 대칭면(X = 0)을 사이에 두고 오른손은 -X, 왼손은 +X. 간격은 보기 위한 값 (게임 근거 없음)
        const [right, left] = gltfs.map((g) => g.scene);
        const box = new THREE.Box3().setFromObject(right);
        const shift = box.getSize(new THREE.Vector3()).x * 0.25 + box.max.x;
        right.position.x -= shift;
        left.position.x += shift;
        // 무기 한 개일 때 폭 w → 양손 묶음 폭 2.5w. 카메라 쪽 무기 면이 (2.5w - w) / 2만큼 카메라에 가까워짐
        const width = box.getSize(new THREE.Vector3()).x;
        placeModel(new THREE.Group().add(right, left), width * 0.75);
        // 사선 배치: 왼손을 위(+Y)로 높이의 1/4, 앞(+Z, 총구 쪽)으로 길이의 1/10. 보기 위한 값
        // placeModel 뒤에 옮겨서 카메라 거리·중심은 사선 배치를 안 했을 때와 같게 둠 (체크해도 화면이 멀어지지 않게)
        if (staggerToggle.checked) {
            const size = box.getSize(new THREE.Vector3());
            left.position.y += size.y * 0.25;
            left.position.z += size.z * 0.1;
        }
    } catch (error) {
        console.error('에러 발생:', error);
    }
}
handSelect.addEventListener('change', () => loadGlb(lastGlb.path, lastGlb.twoHanded));
staggerToggle.addEventListener('change', () => loadGlb(lastGlb.path, lastGlb.twoHanded));
ejectSelect.addEventListener('change', () => loadGlb(lastGlb.path, lastGlb.twoHanded));
// 사출은 펼친 상태일 때만 (사용자 요청). 회복은 언제나
const shelterSwitch = SWITCHES.find((sw) => sw.button.id === 'shelter-toggle');
function updateEjectToggle() {
    ejectToggle.disabled = !ejected && shelterSwitch.state === 1;
}
shelterSwitch.button.addEventListener('click', updateEjectToggle);
ejectToggle.addEventListener('click', () => {
    ejected = !ejected;
    loadGlb(lastGlb.path, lastGlb.twoHanded);
});

// 스트링거: 기본(Default) / 가로 차지(ChargeWidth) / 세로 차지(Charge) 라디오와 발사(Shoot) 버튼. 다른 무기군 버튼과 로직을 공유하지 않음
// 게임 데이터 (fska_dump): Charge·ChargeWidth는 0프레임부터 당긴 자세이고 약 18프레임 동안 흔들리다 멈춤. 발광(M_Body·M_String)은 10→42프레임에 0 → 0.519,
//   M_String tex_mtx0(줄 텍스처)이 이동. Shoot은 반쯤 당긴 자세에서 시작해 30프레임에 Default 자세로 끝나고, 발광이 11.54까지 튐.
//   베어표는 차지 중 M_Receiver 'Charge_Light'(반복), 발사 때 'Shoot_Light'.
// 상태 사이를 잇는 전환 애니메이션은 게임 데이터에 없음. 게임 AS(WeaponStringer.root.asb)에 변수 ChargeRate·TiltDeg가 있어서
//   차지 양·기울기로 클립을 섞는 것으로 보이지만(추측), 섞는 방식은 확인 못 함. 그래서 뷰어는 클립 비중을 서서히 바꿔서 이음 (크로스페이드)
//   기본 → 차지: 무기별 차지 시간 동안 (사용자가 알려 준 값, 60f = 1초. 오더·컬래버는 기본 무기와 같게. ChargeRate가 이렇게 비중을 정하는지는 추측)
//   그 외 (가로 ↔ 세로, 차지 → 기본): STRINGER_FADE초 (보기 위한 값, 게임 근거 없음)
const STRINGER_CHARGE_FRAMES = { Normal: 72, Short: 34, Explosion: 80, Coop: 62 };
// Default 클립은 기준값이 바인드 자세와 다른 무기만 있음 (플루이드 V·LACT-450의 Reel 등. 트라이 스트링거는 없어서 바인드 자세가 기본)
const STRINGER_FADE = 0.3;
// 트라이 스트링거 계열: 차지하면 위아래 사선 잉크통(ReelT·ReelU에 붙음)이 가운데 잉크통처럼 정면으로 돈다 (사용자 확인, 게임 화면).
//   이 계열의 Charge·ChargeWidth 데이터에는 ReelT·ReelU 회전이 없어서 게임 코드(spl::WeaponStringer)가 돌리는 것으로 보임 (AS·액터 파라미터에는 없음).
//   LACT-450은 Charge 데이터 기준값에 이 회전이 있음: ReelT X −20° → −1.6°, ReelU X 160° → 178.4° (+18.4°, ChargeWidth +16.9°).
//   그래서 차지 클립에 ReelT·ReelU 회전이 없는 무기만, 두 본을 로컬 X로 STRINGER_REEL_DEG만큼 돌린 자세를 차지 상태에 같이 섞음.
//   바인드가 ReelT −20°, ReelU 160°라서 +20°면 정확히 정면 (사용자가 준 값). 베어표는 본 구성(ReelT_1~4)이 달라서 안 함
const STRINGER_REEL_DEG = 20;
const stringerState = document.getElementById('stringer-state');
const stringerFire = document.getElementById('stringer-fire-button');
animControls.push(stringerState, stringerFire);
const stringer = { actions: null, shoot: [], reel: [], current: 'Default', shooting: false, chargeFrames: 72 };
function setupStringer(clipSets, path) {
    stringer.actions = null;
    if (!path.includes('Wmn_Stringer_') || !clipSets[0].has('Shoot')) return;
    stringer.chargeFrames = STRINGER_CHARGE_FRAMES[path.match(/Wmn_Stringer_(Normal|Short|Explosion|Coop)/)[1]];
    const once = (action) => { action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; return action; };
    const actionsFor = (names, loop = false) => clipSets.flatMap((clips, i) => names.filter((n) => clips.has(n)).map((n) => {
        const action = mixers[i].clipAction(clips.get(n));
        return loop ? action : once(action);
    }));
    const light = actionsFor(['Charge_Light'], true);
    const reel = clipSets.flatMap((clips, i) => {
        if (['Charge', 'ChargeWidth'].some((n) => clips.get(n)?.tracks.some((t) => /^Reel[TU]\./.test(t.name)))) return [];
        const tracks = ['ReelT', 'ReelU'].map((name) => mixers[i].getRoot().getObjectByName(name)).filter(Boolean).map((bone) => {
            const q = bone.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(STRINGER_REEL_DEG)));
            return new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, [0], q.toArray());
        });
        return tracks.length === 2 ? [once(mixers[i].clipAction(new THREE.AnimationClip('Stringer_ReelFront', 1 / 60, tracks)))] : [];
    });
    stringer.reel = reel;
    stringer.actions = {
        Default: actionsFor(['Default']),
        ChargeWidth: [...actionsFor(['ChargeWidth']), ...light, ...reel],
        Charge: [...actionsFor(['Charge']), ...light, ...reel],
    };
    stringer.shoot = actionsFor(['Shoot', 'Shoot_Light']);
    // Shoot이 끝나면 기본 상태로 (Shoot 끝 자세 = Default 자세라 끊김 없음)
    for (const m of mixers) m.addEventListener('finished', (e) => { if (stringer.shooting && stringer.shoot.includes(e.action) && stringer.shoot.every((a) => !a.isRunning())) setStringerState('Default', true); });
    // 무기를 바꿔도 고른 상태를 유지하고, 그 상태의 끝 자세로 바로 시작
    setStringerState(stringer.current, true);
    stringerState.hidden = false;
    stringerFire.hidden = false;
}
// instant: 페이드 없이 끝 자세로 (로드할 때, 발사가 끝났을 때)
function setStringerState(state, instant = false) {
    const fade = stringer.current === 'Default' && state !== 'Default' ? stringer.chargeFrames / 60 : STRINGER_FADE;
    stringer.current = state;
    stringer.shooting = false;
    stringerState.querySelector(`input[value="${state}"]`).checked = true;
    const next = stringer.actions[state];
    // isScheduled: 재생 중이거나 끝 자세로 멈춰 있는 클립 (clampWhenFinished)
    for (const action of [...Object.values(stringer.actions).flat(), ...stringer.shoot]) {
        if (next.includes(action)) continue;
        if (instant || !action.isScheduled()) action.stop();
        else action.fadeOut(fade);
    }
    for (const action of next) {
        if (!instant && action.isScheduled() && action.enabled && action.getEffectiveWeight() > 0) continue; // 이미 이 상태 (Charge_Light는 두 차지에 공통)
        action.reset().play();
        if (instant) {
            if (action.loop === THREE.LoopOnce) action.time = action.getClip().duration;
        } else {
            action.fadeIn(fade);
        }
    }
    showFirstFrame();
}
stringerState.addEventListener('change', (e) => setStringerState(e.target.value));
// 발사: 어느 상태든 Shoot을 처음부터 재생하고, 끝나면 기본 상태로 (사용자 요청)
// 잉크통 회전(stringer.reel)도 발사하면 바로 원래 각도로 (사용자 요청)
stringerFire.addEventListener('click', () => {
    for (const action of Object.values(stringer.actions).flat()) action.stop();
    for (const action of stringer.shoot) action.reset().play();
    stringer.shooting = true;
    showFirstFrame();
});

// 와이퍼: 기본 / 차지 / 공격 라디오 (사용자 요청)와 덴탈 와이퍼 케이스 켜기/끄기. 다른 무기군 버튼과 로직을 공유하지 않음
// 게임 데이터 (animlist, fska_dump):
// - 사무·베어표 'Charge'(37f 반복): Wave 본 + StampA/B 보임/숨김 + M_Stamp tex_mtx0 X 이동(0 → 0.947), 베어표는 M_Coil 발광도. 'Shot'(35f): 같은 대상
// - 드라이브 'Charge'(30f 반복)·'Shot'(60f): Body_00·Blade_00 본. 'Wmn_Saber_Light_Charge'(100f, 반복 없음): M_Body_Tube 발광 0.5 → 15 + tex_mtx1 Y 이동.
//   이름으로 보아 차지 때 같이 재생 (게임이 어떻게 묶는지는 확인 못 함)
// - 덴탈 'Charge_SberHeavy00_St'(100f, 차지 시작) → 'Charge_SberHeavy00'(96f 반복), 'ChargeAttack_SberHeavy00'(90f): 10~66프레임 동안 Case 숨김
//   (게임은 그동안 따로 된 Case 모델을 보여 줌. 사용자 요청으로 Case 모델은 안 씀)
// - 오더 와이퍼는 애니메이션이 움직이는 본(Wave_1·2, StampA/B)이 모델에 없어서 게임에서도 안 움직임 → 라디오 없음
// 상태 사이 전환 애니메이션은 게임 데이터에 없음 → 바로 바꿈. 공격은 한 번 재생하고 끝나면 기본으로 (스트링거 발사와 같은 방식)
const saberState = document.getElementById('saber-state');
const saberPart = document.getElementById('saber-part'); // 덴탈 와이퍼: 케이스만 / 몸체만 / 모두 (사용자 요청, 기본 모두)
animControls.push(saberState, saberPart);
const saber = { states: null, heavy: false, current: 'Default', caseMeshes: [], bodyMeshes: [] };
function setupSaber(gltfs, clipSets, path) {
    saber.states = null;
    saber.caseMeshes = [];
    saber.bodyMeshes = [];
    if (!path.includes('Wmn_Saber_')) return;
    // 덴탈 와이퍼 케이스: 셰이프 이름 'Case__<머티리얼>', 나머지는 몸체. 모델을 바꿔도 고른 값 유지
    for (const gltf of gltfs) gltf.scene.traverse((obj) => { if (obj.isMesh) (obj.name.startsWith('Case__') ? saber.caseMeshes : saber.bodyMeshes).push(obj); });
    saberPart.hidden = !saber.caseMeshes.length;
    applySaberPart();
    // 반복 클립은 트랙 길이별로 나눠서 각자 자기 길이로 반복 (loopClips)
    const actionsFor = (names, loop) => clipSets.flatMap((clips, i) => names.filter((n) => clips.has(n)).flatMap((n) => {
        if (loop) return loopClips(clips.get(n)).map((clip) => mixers[i].clipAction(clip));
        const action = mixers[i].clipAction(clips.get(n));
        action.setLoop(THREE.LoopOnce);
        action.clampWhenFinished = true;
        return [action];
    }));
    // 사무·베어표 StampA/B 보임/숨김 (사용자 요청: stamp를 숨기지 말 것. 차지는 A·B 번갈아, 공격은 A만)
    // 게임 데이터: Charge는 0~6프레임 둘 다 숨김, 7~30 A 깜빡임(B 숨김), 31~37 B 깜빡임(A 숨김). Shot은 A·B 번갈아
    // - Charge: 게임에서 깜빡이는 간격(1프레임)으로 A, B를 처음부터 끝까지 번갈아 보여 줌 (사용자 요청. 둘 다 숨는 구간과 A·B 순서는 게임 값을 안 따름)
    // - Shot: 보임/숨김을 빼서 기본 상태처럼 A만
    clipSets.forEach((clips, i) => {
        const stamp = {};
        gltfs[i].scene.traverse((obj) => { const m = obj.isMesh && obj.name.match(/^Stamp([AB])_low__/); if (m) stamp[m[1]] = `${obj.uuid}.visible`; });
        const charge = clips.get('Charge');
        if (charge && stamp.A && stamp.B) {
            const times = [0, 1 / 60, 2 / 60]; // 2프레임 주기로 반복 (loopClips가 따로 나눔)
            charge.tracks = [...charge.tracks.filter((t) => t.ValueTypeName !== 'bool'),
                new THREE.BooleanKeyframeTrack(stamp.A, times, [true, false, true]),
                new THREE.BooleanKeyframeTrack(stamp.B, times, [false, true, false])];
        }
        const shot = clips.get('Shot');
        if (shot && stamp.A) {
            shot.tracks = shot.tracks.filter((t) => t.ValueTypeName !== 'bool');
            shot.resetDuration();
        }
    });
    const heavy = saber.heavy = clipSets[0].has('ChargeAttack_SberHeavy00');
    if (!heavy && !clipSets[0].has('Charge')) return;
    saber.states = {
        Default: { start: [], loop: [] },
        Charge: heavy ? { start: actionsFor(['Charge_SberHeavy00_St']), loop: actionsFor(['Charge_SberHeavy00'], true) }
            : { start: actionsFor(['Wmn_Saber_Light_Charge']), loop: actionsFor(['Charge'], true) }, // 드라이브 발광은 끝 값을 유지
        Attack: { start: actionsFor([heavy ? 'ChargeAttack_SberHeavy00' : 'Shot']), loop: [] },
    };
    for (const m of mixers) {
        m.addEventListener('finished', (e) => {
            const state = saber.states?.[saber.current];
            if (!state?.start.includes(e.action) || state.start.some((a) => a.isRunning())) return;
            if (saber.current === 'Attack') setSaberState('Default');
            else if (saber.current === 'Charge' && heavy) for (const action of state.loop) action.reset().play(); // 차지 시작이 끝나면 반복
        });
    }
    setSaberState(saber.current === 'Attack' ? 'Default' : saber.current);
    saberState.hidden = false;
}
// 게임은 같은 이름이라도 스켈레탈·셰이더 파라미터·본 보임/숨김 애니메이션이 각자 frameCount로 반복함.
// 사무·베어표 'Charge'는 본·tex_mtx0이 37f, StampA/B 보임/숨김이 48f라 한 클립(48f)으로 반복하면 37~48f 동안 본이 멈췄다가 처음으로 튐 (끊김).
// → 보임/숨김은 따로 반복 (지금은 setupSaber가 만든 2프레임 주기)
// → 마지막 키 시각(= 그 애니메이션의 frameCount, build_glb가 끝까지 키를 넣음)이 같은 트랙끼리 클립을 나눔
function loopClips(clip) {
    const groups = new Map();
    for (const track of clip.tracks) {
        const end = Math.round(track.times.at(-1) * 60);
        if (!groups.has(end)) groups.set(end, []);
        groups.get(end).push(track);
    }
    if (groups.size === 1) return [clip];
    return [...groups].map(([end, tracks]) => new THREE.AnimationClip(`${clip.name}_${end}f`, end / 60, tracks));
}
function setSaberState(state) {
    saber.current = state;
    saberState.querySelector(`input[value="${state}"]`).checked = true;
    for (const { start, loop } of Object.values(saber.states)) for (const action of [...start, ...loop]) action.stop();
    const { start, loop } = saber.states[state];
    for (const action of start) action.reset().play();
    if (!(state === 'Charge' && saber.heavy)) for (const action of loop) action.reset().play(); // 덴탈 차지는 시작 클립이 끝난 뒤 (setupSaber finished)
    showFirstFrame();
}
saberState.addEventListener('change', (e) => setSaberState(e.target.value));
// 고르지 않은 부분은 공격 애니메이션의 보임/숨김 트랙과 상관없이 안 보이게: 카메라·그림자가 안 보는 레이어 1로 옮김
function applySaberPart() {
    if (!saber.caseMeshes.length) return;
    const part = saberPart.querySelector('input:checked').value;
    for (const mesh of saber.caseMeshes) mesh.layers.set(part !== 'body' ? 0 : 1);
    for (const mesh of saber.bodyMeshes) mesh.layers.set(part !== 'case' ? 0 : 1);
}
saberPart.addEventListener('change', applySaberPart);

// 4. 팀 컬러 변경 UI
const colorInput = document.getElementById('team-color-input');

colorInput.addEventListener('input', (e) => {
    const hex = e.target.value;
    // 전역 teamColor 객체 업데이트
    teamColor.set(hex); 
    
    // 현재 모델의 모든 메쉬 유니폼 업데이트
    if (currentModel) {
        currentModel.traverse((child) => {
            if (child.isMesh && child.material.userData.teamColor) {
                child.material.userData.teamColor.value.set(hex);
            }
        });
    }
});

// 셰이더 종류: 인게임 = 위의 게임 셰이더 그대로
// 픽셀 = 같은 셰이더로 낮은 해상도 렌더 타겟에 그린 뒤 최근접으로 화면에 늘림. 머티리얼을 안 건드려서 잉크·emission·애니메이션은 그대로
// - 렌더 타겟은 MSAA 없이 그려서 도트 경계가 섞이지 않음. HDR 값이 남도록 HalfFloat
// - three.js는 렌더 타겟에 그릴 때 톤맵·sRGB를 안 하므로, 화면에 옮기는 패스에서 같은 톤맵(인게임이면 CustomToneMapping)과 sRGB를 적용
// - 외곽선: 렌더 타겟 깊이로 실루엣(뒤가 멀리 떨어진 앞쪽 픽셀)을 찾아 1도트 어둡게. 1/z는 평면에서 화면상 선형이라 2차 차분으로 평면(바닥 등)은 걸러냄
// - 팔레트: 화면 색(sRGB)을 HSV로 바꿔 명도·채도는 단계 수로, 색상은 24단계로 끊음. RGB 채널별로 끊으면 회색이 붉게 갈라지는 등 색조가 틀어져서
//   디더링을 켜면 4×4 Bayer 무늬로 명도 단계 사이를 섞음
// - 회전 기즈모는 픽셀 처리 없이 화면 해상도로 마지막에 따로 그림
// 게임 셰이더 근거가 없는 보기용 효과라 인게임 기본값에는 영향 없음 (ProPixelizer의 실루엣 외곽선·팔레트·디더를 참고)
const shaderSelect = document.getElementById('shader-mode');
const pixelSizeSlider = document.getElementById('pixel-size');
const pixelSizeText = document.getElementById('pixel-size-text');
const outlineToggle = document.getElementById('pixel-outline');
const quantizeToggle = document.getElementById('pixel-quantize');
const quantizeSlider = document.getElementById('pixel-levels');
const quantizeText = document.getElementById('pixel-levels-text');
const ditherToggle = document.getElementById('pixel-dither');
const projectionSelect = document.getElementById('projection-mode');
const celToggle = document.getElementById('pixel-cel');
const CEL_STEPS = 3; // 셀 셰이딩 명암 단계 (그늘 / 중간 / 밝음 + 0)
const snapToggle = document.getElementById('pixel-snap');
// 깊이로 부품 경계(앞뒤로 떨어진 곳)를 찾는 GLSL. 픽셀 외곽선과 선화가 같이 씀
const DEPTH_EDGE_GLSL = `#include <packing>
uniform sampler2D tDepth;
uniform vec2 size;
uniform float cameraNear;
uniform float cameraFar;
uniform float ortho;
const float OUTLINE_GAP = 0.03; // 앞뒤 거리 차이가 이 비율보다 크면 경계
// 평면 위에서 화면 좌표에 대해 선형인 깊이 값 (클수록 가까움). 원근: 1/거리, 직교: −거리. 배경은 아주 먼 값
float invDepth(vec2 p) {
    float d = texture2D(tDepth, (p + 0.5) / size).x;
    if (ortho > 0.5) return d >= 1.0 ? -1e6 : orthographicDepthToViewZ(d, cameraNear, cameraFar);
    return d >= 1.0 ? 0.0 : -1.0 / perspectiveDepthToViewZ(d, cameraNear, cameraFar);
}
// 이웃 n이 c보다 충분히 멀고(거리 비율), 반대쪽 이웃 o까지 셋이 한 평면이 아니면 경계 (평면은 1/z가 선형이라 2차 차분으로 걸러냄)
bool edge(float c, float n, float o) {
    float scale = OUTLINE_GAP * (ortho > 0.5 ? -c : c);
    return c - n > scale && abs(n + o - 2.0 * c) > scale;
}
`;
const pixelTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
pixelTarget.depthTexture = new THREE.DepthTexture(1, 1);
const pixelMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tScene: { value: pixelTarget.texture },
        tDepth: { value: pixelTarget.depthTexture },
        size: { value: new THREE.Vector2(1, 1) },
        cameraNear: { value: 1 },
        cameraFar: { value: 1 },
        ortho: { value: 0 },
        outline: { value: 1 },
        levels: { value: 0 },
        dither: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `${DEPTH_EDGE_GLSL}
uniform sampler2D tScene;
uniform float outline;
uniform float levels;
uniform float dither;
varying vec2 vUv;
const float OUTLINE_DARK = 0.3; // 외곽선 = 원래 색 × 이 값
// 4×4 Bayer 행렬 (0~15) / 16. 렌더 타겟 픽셀 좌표 기준이라 무늬도 도트 크기를 따름
float bayer4(vec2 p) {
    vec2 a = mod(p, 4.0);
    vec2 b = mod(floor(a * 0.5), 2.0);
    vec2 c = mod(a, 2.0);
    // 2×2 Bayer [0 2; 3 1] = mod(2x + 3y, 4). 4×4 = 4 × (하위 비트의 2×2) + (상위 비트의 2×2)
    return (4.0 * mod(2.0 * c.x + 3.0 * c.y, 4.0) + mod(2.0 * b.x + 3.0 * b.y, 4.0)) / 16.0;
}
vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
    vec2 p = floor(vUv * size);
    gl_FragColor = texture2D(tScene, (p + 0.5) / size);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb = clamp(gl_FragColor.rgb, 0.0, 1.0);
    if (outline > 0.5) {
        float c = invDepth(p);
        float l = invDepth(p - vec2(1.0, 0.0)), r = invDepth(p + vec2(1.0, 0.0));
        float d = invDepth(p - vec2(0.0, 1.0)), u = invDepth(p + vec2(0.0, 1.0));
        if (texture2D(tDepth, (p + 0.5) / size).x < 1.0 && (edge(c, l, r) || edge(c, r, l) || edge(c, d, u) || edge(c, u, d))) gl_FragColor.rgb *= OUTLINE_DARK;
    }
    if (levels > 1.0) {
        vec3 hsv = rgb2hsv(gl_FragColor.rgb);
        float offset = dither > 0.5 ? bayer4(p) - 0.46875 : 0.0; // 평균이 0이 되도록 (0~15/16의 평균 = 7.5/16)
        float steps = levels - 1.0;
        hsv.x = floor(hsv.x * 24.0 + 0.5) / 24.0;
        hsv.y = clamp(floor(hsv.y * steps + 0.5) / steps, 0.0, 1.0);
        hsv.z = clamp(floor(hsv.z * steps + 0.5 + offset) / steps, 0.0, 1.0);
        gl_FragColor.rgb = hsv2rgb(hsv);
    }
}`,
    depthTest: false,
    depthWrite: false,
});
const pixelQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), pixelMaterial);
pixelQuad.frustumCulled = false;
const pixelCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
// 투영: 원근 = 기존 카메라. 직교 = 원근 카메라를 매 프레임 따라가는 직교 카메라
// - OrbitControls는 원근 카메라를 그대로 움직이고, 직교 화면 높이를 (타깃까지 거리 × tan(fov/2))로 맞춰서 확대·이동·전환 시 보이는 크기가 같음
// - 직교 카메라는 ORTHO_BACK만큼 뒤에서 그려서, 확대해서 원근 카메라가 모델에 가까워져도 앞이 잘리지 않음
const ORTHO_BACK = 50;
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, camera.near, camera.far + ORTHO_BACK);
const orthoBack = new THREE.Vector3();
let activeCamera = camera;
// 픽셀 크립 제거 (ProPixelizer처럼 직교에서만): 직교 카메라 위치를 화면 평면에서 도트 1칸 단위로 맞춤
// → 이동(팬)해도 같은 월드 위치가 항상 같은 도트에 떨어져서 도트가 기어다니지 않음. 모델 회전·확대 중에는 남음
const snapRight = new THREE.Vector3(), snapUp = new THREE.Vector3();
function syncOrthoCamera(pixelW = 0, pixelH = 0) {
    const halfH = camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const halfW = pixelH ? halfH * pixelW / pixelH : halfH * camera.aspect; // 픽셀 모드: 렌더 타겟 비율에 맞춰 도트를 정사각형으로
    orthoCamera.left = -halfW;
    orthoCamera.right = halfW;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.updateProjectionMatrix();
    orthoCamera.quaternion.copy(camera.quaternion);
    orthoCamera.position.copy(camera.position).add(orthoBack.set(0, 0, ORTHO_BACK).applyQuaternion(camera.quaternion));
    if (pixelH && snapToggle.checked) {
        const cell = 2 * halfH / pixelH; // 도트 1칸의 월드 크기
        snapRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
        snapUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
        const x = orthoCamera.position.dot(snapRight), y = orthoCamera.position.dot(snapUp);
        orthoCamera.position.addScaledVector(snapRight, Math.round(x / cell) * cell - x).addScaledVector(snapUp, Math.round(y / cell) * cell - y);
    }
    orthoCamera.updateMatrixWorld();
}
function applyProjection() {
    activeCamera = projectionSelect.value === 'ortho' ? orthoCamera : camera;
    if (activeCamera === orthoCamera) syncOrthoCamera();
    gizmo.camera = activeCamera;
}
projectionSelect.addEventListener('change', applyProjection);
let pixelMode = false;
let lineMode = false;
let toonMode = false;
// 셰이더를 바꾸면 투영도 기본값으로 (인게임: 원근, 픽셀: 직교). 그 뒤에 투영만 따로 바꿀 수 있음
shaderSelect.addEventListener('change', () => {
    if (shaderSelect.value === 'line') return; // 선화는 보던 투영 그대로
    projectionSelect.value = shaderSelect.value === 'pixel' ? 'ortho' : 'persp';
    applyProjection();
});
function applyShaderMode() {
    pixelMode = shaderSelect.value === 'pixel';
    lineMode = shaderSelect.value === 'line';
    toonMode = shaderSelect.value === 'toon';
    document.getElementById('line-options').hidden = !lineMode;
    document.getElementById('toon-options').hidden = !toonMode;
    gameEnv.s3Toon.value.x = toonMode ? 1 : 0;
    gameEnv.s3Cel.value = pixelMode && celToggle.checked ? CEL_STEPS : 0;
    snapToggle.parentElement.hidden = projectionSelect.value !== 'ortho';
    document.getElementById('pixel-options').hidden = !pixelMode;
    quantizeSlider.parentElement.hidden = !quantizeToggle.checked;
    ditherToggle.parentElement.hidden = !quantizeToggle.checked;
    pixelSizeText.textContent = pixelSizeSlider.value;
    quantizeText.textContent = quantizeSlider.value;
    pixelMaterial.uniforms.outline.value = outlineToggle.checked ? 1 : 0;
    pixelMaterial.uniforms.levels.value = quantizeToggle.checked ? quantizeSlider.valueAsNumber : 0;
    pixelMaterial.uniforms.dither.value = ditherToggle.checked ? 1 : 0;
}
for (const el of [shaderSelect, outlineToggle, quantizeToggle, ditherToggle, celToggle, projectionSelect]) el.addEventListener('change', applyShaderMode);
for (const el of [pixelSizeSlider, quantizeSlider]) el.addEventListener('input', applyShaderMode);
applyShaderMode();
applyProjection();
const drawSize = new THREE.Vector2();
const gizmoHelper = gizmo.getHelper();
// 선화: 트레이스 밑그림용. 게임 셰이더 대신 노멀만 그리는 머티리얼로 화면 해상도 렌더 타겟에 한 번 그리고(색 계산이 없어서 인게임보다 가벼움)
// 깊이·노멀에서 선을 찾음 → 선 두께만큼 넓혀서 채우기와 합침
// - 바깥선: 모델이 배경과 닿는 안쪽 1px
// - 부품선: 깊이로 앞뒤가 떨어진 경계 (픽셀 외곽선과 같은 식)
// - 접힘선: 같은 깊이 면에서 노멀이 LINE_CREASE_COS보다 크게 꺾인 곳
// - 노멀 머티리얼에 원래 머티리얼의 alphaMap·alphaTest·side를 옮겨서 구멍(alpha test)은 그대로, 그림자 전용 머티리얼은 안 그림
// - 텍스처에 그려진 무늬는 형상이 아니라서 선으로 안 나옴
const LINE_CREASE_COS = Math.cos(THREE.MathUtils.degToRad(35)); // 이보다 크게 꺾이면 접힘선
const lineOutlineToggle = document.getElementById('line-outline');
const linePartToggle = document.getElementById('line-part');
const lineCreaseToggle = document.getElementById('line-crease');
const lineFillSelect = document.getElementById('line-fill');
const lineWidthSlider = document.getElementById('line-width');
const lineWidthText = document.getElementById('line-width-text');
const lineTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
lineTarget.depthTexture = new THREE.DepthTexture(1, 1);
const edgeTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const lineNormalMaterials = new WeakMap();
function lineNormalMaterial(material) {
    let m = lineNormalMaterials.get(material);
    if (!m) {
        m = new THREE.MeshNormalMaterial({ side: material.side });
        // MeshNormalMaterial 셰이더에는 alpha 맵·alpha test가 없어서 끼워 넣음 (uniform은 three.js가 공통으로 채움)
        m.alphaMap = material.alphaMap;
        m.alphaTest = material.alphaTest;
        m.colorWrite = material.colorWrite;
        m.depthWrite = material.depthWrite;
        m.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <clipping_planes_pars_fragment>', '#include <clipping_planes_pars_fragment>\n#include <alphamap_pars_fragment>\n#include <alphatest_pars_fragment>')
                .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n#include <alphamap_fragment>\n#include <alphatest_fragment>');
        };
        lineNormalMaterials.set(material, m);
    }
    return m;
}
const lineSwapped = [];
function swapToNormalMaterials() {
    modelPivot.traverse((child) => {
        if (!child.isMesh) return;
        lineSwapped.push(child, child.material);
        child.material = Array.isArray(child.material) ? child.material.map(lineNormalMaterial) : lineNormalMaterial(child.material);
    });
}
function restoreMaterials() {
    for (let i = 0; i < lineSwapped.length; i += 2) lineSwapped[i].material = lineSwapped[i + 1];
    lineSwapped.length = 0;
}
const lineQuadVertex = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
// 1단계: 픽셀마다 선 종류를 r(바깥) g(부품) b(접힘)에 기록
const edgeMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tNormal: { value: lineTarget.texture },
        tDepth: { value: lineTarget.depthTexture },
        size: { value: new THREE.Vector2(1, 1) },
        cameraNear: { value: 1 },
        cameraFar: { value: 1 },
        ortho: { value: 0 },
        creaseCos: { value: LINE_CREASE_COS },
    },
    vertexShader: lineQuadVertex,
    fragmentShader: `${DEPTH_EDGE_GLSL}
uniform sampler2D tNormal;
uniform float creaseCos;
varying vec2 vUv;
bool covered(vec2 p) { return texture2D(tDepth, (p + 0.5) / size).x < 1.0; }
vec3 nrm(vec2 p) { return texture2D(tNormal, (p + 0.5) / size).xyz * 2.0 - 1.0; }
void main() {
    vec2 p = floor(vUv * size);
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    if (!covered(p)) return;
    vec2 o[4] = vec2[4](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));
    float c = invDepth(p);
    vec3 n = nrm(p);
    for (int i = 0; i < 4; i++) {
        vec2 q = p + o[i];
        if (!covered(q)) { gl_FragColor.r = 1.0; continue; }
        if (edge(c, invDepth(q), invDepth(p - o[i]))) gl_FragColor.g = 1.0;
        // 접힘선은 한쪽(+x, +y 이웃과 비교)에만 그려서 1px
        else if (i % 2 == 0 && dot(n, nrm(q)) < creaseCos) gl_FragColor.b = 1.0;
    }
}`,
    depthTest: false,
    depthWrite: false,
});
// 2단계: 켠 선 종류를 선 두께 반경 안에서 찾아 넓히고, 채우기·배경과 합침
const lineMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tEdge: { value: edgeTarget.texture },
        tDepth: { value: lineTarget.depthTexture },
        size: { value: new THREE.Vector2(1, 1) },
        mask: { value: new THREE.Vector3(1, 1, 1) },
        radius: { value: 1 },
        fill: { value: 0 }, // 0: 흰색, 1: 없음(배경), 2: 실루엣
        background: { value: new THREE.Color() },
        clear: { value: 0 }, // 1: 저장용 투명 배경 (배경·채우기 없음 자리는 알파 0)
    },
    vertexShader: lineQuadVertex,
    fragmentShader: `uniform sampler2D tEdge;
uniform sampler2D tDepth;
uniform vec2 size;
uniform vec3 mask;
uniform float radius;
uniform float fill;
uniform vec3 background;
uniform float clear;
varying vec2 vUv;
const int MAX_RADIUS = 3; // 선 두께 4px까지
void main() {
    vec2 p = floor(vUv * size);
    bool line = false;
    for (int y = -MAX_RADIUS; y <= MAX_RADIUS; y++) {
        for (int x = -MAX_RADIUS; x <= MAX_RADIUS; x++) {
            vec2 d = vec2(x, y);
            if (line || dot(d, d) > radius * radius + 0.5) continue;
            if (dot(texture2D(tEdge, (p + d + 0.5) / size).rgb, mask) > 0.5) line = true;
        }
    }
    bool covered = texture2D(tDepth, (p + 0.5) / size).x < 1.0;
    vec3 color = background;
    if (covered && fill < 0.5) color = vec3(1.0);
    if (covered && fill > 1.5) color = vec3(0.0);
    if (line) color = fill > 1.5 && covered ? vec3(1.0) : vec3(0.0); // 실루엣 채우기 위에서는 흰 선
    gl_FragColor = vec4(color, 1.0);
    if (clear > 0.5 && !line && !(covered && (fill < 0.5 || fill > 1.5))) gl_FragColor = vec4(0.0);
    #include <colorspace_fragment>
}`,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
});
const edgeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edgeMaterial);
edgeQuad.frustumCulled = false;
const lineQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lineMaterial);
lineQuad.frustumCulled = false;
function applyLineOptions() {
    lineWidthText.textContent = lineWidthSlider.value;
    lineMaterial.uniforms.mask.value.set(lineOutlineToggle.checked ? 1 : 0, linePartToggle.checked ? 1 : 0, lineCreaseToggle.checked ? 1 : 0);
    lineMaterial.uniforms.radius.value = lineWidthSlider.valueAsNumber - 1;
    lineMaterial.uniforms.fill.value = { white: 0, none: 1, silhouette: 2 }[lineFillSelect.value];
}
for (const el of [lineOutlineToggle, linePartToggle, lineCreaseToggle, lineFillSelect]) el.addEventListener('change', applyLineOptions);
lineWidthSlider.addEventListener('input', applyLineOptions);
applyLineOptions();
function renderLine() {
    renderer.getDrawingBufferSize(drawSize);
    const w = drawSize.x, h = drawSize.y;
    if (lineTarget.width !== w || lineTarget.height !== h) {
        lineTarget.setSize(w, h);
        edgeTarget.setSize(w, h);
        edgeMaterial.uniforms.size.value.set(w, h);
        lineMaterial.uniforms.size.value.set(w, h);
    }
    if (activeCamera === orthoCamera) syncOrthoCamera();
    edgeMaterial.uniforms.cameraNear.value = activeCamera.near;
    edgeMaterial.uniforms.cameraFar.value = activeCamera.far;
    edgeMaterial.uniforms.ortho.value = activeCamera === orthoCamera ? 1 : 0;
    lineMaterial.uniforms.background.value.copy(scene.background?.isColor ? scene.background : BACKGROUND_COLOR);
    const gizmoVisible = gizmoHelper.visible;
    const background = scene.background;
    gizmoHelper.visible = false;
    scene.background = null;
    swapToNormalMaterials();
    renderer.setRenderTarget(lineTarget);
    renderer.render(scene, activeCamera);
    restoreMaterials();
    scene.background = background;
    renderer.setRenderTarget(edgeTarget);
    renderer.render(edgeQuad, pixelCamera);
    renderer.setRenderTarget(null);
    renderer.render(lineQuad, pixelCamera);
    gizmoHelper.visible = gizmoVisible;
    if (gizmoVisible) {
        renderer.autoClear = false;
        renderer.render(gizmoHelper, activeCamera);
        renderer.autoClear = true;
    }
}

// 카툰: 게임 셰이더 패치 끝의 카툰 분기(s3Toon)로 셀 셰이딩하고, 선화의 깊이 검출로 색 외곽선(그 자리 색 × TOON_LINE_DARK)을 덧그림 (길티기어식)
// - 4x MSAA 렌더 타겟에 그린 뒤 깊이로 바깥선·부품선을 찾음. 노멀 패스는 안 써서 장면은 1번만 그림 (접힘선 없음)
// - 렌더 타겟에 그리므로 톤맵·sRGB는 화면에 옮기는 패스에서 적용 (픽셀과 같음)
const TOON_LINE_DARK = 0.35;
const toonStepsSelect = document.getElementById('toon-steps');
const toonSoftSlider = document.getElementById('toon-soft');
const toonRimToggle = document.getElementById('toon-rim');
const toonOutlineToggle = document.getElementById('toon-outline');
const toonWidthSlider = document.getElementById('toon-width');
const toonWidthText = document.getElementById('toon-width-text');
const toonTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
toonTarget.depthTexture = new THREE.DepthTexture(1, 1);
const toonEdgeMaterial = edgeMaterial.clone();
toonEdgeMaterial.uniforms.tNormal.value = toonTarget.texture;
toonEdgeMaterial.uniforms.tDepth.value = toonTarget.depthTexture;
toonEdgeMaterial.uniforms.creaseCos.value = -2; // 접힘선 없음
const toonEdgeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), toonEdgeMaterial);
toonEdgeQuad.frustumCulled = false;
const toonMaterial = new THREE.ShaderMaterial({
    uniforms: {
        tScene: { value: toonTarget.texture },
        tEdge: { value: edgeTarget.texture },
        size: { value: new THREE.Vector2(1, 1) },
        radius: { value: 1 },
        outline: { value: 1 },
    },
    vertexShader: lineQuadVertex,
    fragmentShader: `uniform sampler2D tScene;
uniform sampler2D tEdge;
uniform vec2 size;
uniform float radius;
uniform float outline;
varying vec2 vUv;
const int MAX_RADIUS = 3; // 선 두께 4px까지
void main() {
    vec2 p = floor(vUv * size);
    vec2 src = p;
    bool line = false;
    if (outline > 0.5) {
        for (int y = -MAX_RADIUS; y <= MAX_RADIUS; y++) {
            for (int x = -MAX_RADIUS; x <= MAX_RADIUS; x++) {
                vec2 d = vec2(x, y);
                if (line || dot(d, d) > radius * radius + 0.5) continue;
                if (dot(texture2D(tEdge, (p + d + 0.5) / size).rg, vec2(1.0)) > 0.5) { line = true; src = p + d; }
            }
        }
    }
    // 선은 선이 검출된 (모델 쪽) 픽셀의 색을 어둡게 해서 씀
    gl_FragColor = texture2D(tScene, (src + 0.5) / size);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    if (line) gl_FragColor.rgb *= ${TOON_LINE_DARK.toFixed(2)};
}`,
    depthTest: false,
    depthWrite: false,
});
const toonQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), toonMaterial);
toonQuad.frustumCulled = false;
function applyToonOptions() {
    toonWidthText.textContent = toonWidthSlider.value;
    toonWidthSlider.parentElement.hidden = !toonOutlineToggle.checked;
    gameEnv.s3Toon.value.set(toonMode ? 1 : 0, Number(toonStepsSelect.value), toonSoftSlider.valueAsNumber, toonRimToggle.checked ? 1 : 0);
    toonMaterial.uniforms.outline.value = toonOutlineToggle.checked ? 1 : 0;
    toonMaterial.uniforms.radius.value = toonWidthSlider.valueAsNumber - 1;
}
for (const el of [toonStepsSelect, toonRimToggle, toonOutlineToggle]) el.addEventListener('change', applyToonOptions);
for (const el of [toonSoftSlider, toonWidthSlider]) el.addEventListener('input', applyToonOptions);
applyToonOptions();
// 카툰 명암의 기준 = 지금 켜진 직접광 중 가장 밝은 것 (인게임: 게임 주광)
const toonKeyLights = [dirLight, dirLight2, bottomLight, bottomLight2, gameLight];
const toonKeyColor = new THREE.Color();
function updateToonKey() {
    let best = 0;
    gameEnv.s3ToonKey.value.setRGB(0, 0, 0);
    for (const light of toonKeyLights) {
        if (!light.visible) continue;
        toonKeyColor.copy(light.color).multiplyScalar(light.intensity);
        const lum = toonKeyColor.r * 0.299 + toonKeyColor.g * 0.587 + toonKeyColor.b * 0.114;
        if (lum > best) {
            best = lum;
            gameEnv.s3ToonKey.value.copy(toonKeyColor);
        }
    }
}
function renderToon() {
    renderer.getDrawingBufferSize(drawSize);
    const w = drawSize.x, h = drawSize.y;
    if (toonTarget.width !== w || toonTarget.height !== h) {
        toonTarget.setSize(w, h);
        toonMaterial.uniforms.size.value.set(w, h);
    }
    if (edgeTarget.width !== w || edgeTarget.height !== h) edgeTarget.setSize(w, h);
    toonEdgeMaterial.uniforms.size.value.set(w, h);
    if (activeCamera === orthoCamera) syncOrthoCamera();
    toonEdgeMaterial.uniforms.cameraNear.value = activeCamera.near;
    toonEdgeMaterial.uniforms.cameraFar.value = activeCamera.far;
    toonEdgeMaterial.uniforms.ortho.value = activeCamera === orthoCamera ? 1 : 0;
    updateToonKey();
    const gizmoVisible = gizmoHelper.visible;
    gizmoHelper.visible = false;
    renderer.setRenderTarget(toonTarget);
    renderer.render(scene, activeCamera);
    if (toonOutlineToggle.checked) {
        renderer.setRenderTarget(edgeTarget);
        renderer.render(toonEdgeQuad, pixelCamera);
    }
    renderer.setRenderTarget(null);
    renderer.render(toonQuad, pixelCamera);
    gizmoHelper.visible = gizmoVisible;
    if (gizmoVisible) {
        renderer.autoClear = false;
        renderer.render(gizmoHelper, activeCamera);
        renderer.autoClear = true;
    }
}

function renderFrame() {
    if (lineMode) {
        renderLine();
        return;
    }
    if (toonMode) {
        renderToon();
        return;
    }
    if (!pixelMode) {
        if (activeCamera === orthoCamera) syncOrthoCamera();
        renderer.render(scene, activeCamera);
        return;
    }
    renderer.getDrawingBufferSize(drawSize);
    const n = pixelSizeSlider.valueAsNumber;
    const w = Math.max(1, Math.round(drawSize.x / n)), h = Math.max(1, Math.round(drawSize.y / n));
    if (pixelTarget.width !== w || pixelTarget.height !== h) {
        pixelTarget.setSize(w, h);
        pixelMaterial.uniforms.size.value.set(w, h);
    }
    if (activeCamera === orthoCamera) syncOrthoCamera(w, h);
    pixelMaterial.uniforms.cameraNear.value = activeCamera.near;
    pixelMaterial.uniforms.cameraFar.value = activeCamera.far;
    pixelMaterial.uniforms.ortho.value = activeCamera === orthoCamera ? 1 : 0;
    const gizmoVisible = gizmoHelper.visible;
    gizmoHelper.visible = false;
    renderer.setRenderTarget(pixelTarget);
    renderer.render(scene, activeCamera);
    renderer.setRenderTarget(null);
    renderer.render(pixelQuad, pixelCamera);
    gizmoHelper.visible = gizmoVisible;
    if (gizmoVisible) {
        renderer.autoClear = false;
        renderer.render(gizmoHelper, activeCamera);
        renderer.autoClear = true;
    }
}

// 애니메이션 일시정지: 모든 무기군 공통. 시간만 멈추고 버튼·슬라이더(차지 등)는 그대로 동작
let animPaused = false;
const pauseButton = document.getElementById('anim-pause');
pauseButton.addEventListener('click', () => {
    animPaused = !animPaused;
    setCatText(pauseButton, animPaused ? 'play' : 'pause');
});

// 저장 (PNG·GIF·WebP, 화면은 export.js): 지금 셰이더·투영 그대로, 캔버스 크기로, 배경은 투명하게, 회전 기즈모는 빼고 그림
// 배경(scene.background)만 빼면 렌더러(alpha: true)가 투명하게 지움. 픽셀·카툰은 렌더 타겟의 알파가 그대로 화면까지 옴, 선화는 lineMaterial.clear로 배경 칠을 끔
const grabCanvas = document.createElement('canvas');
const grabContext = grabCanvas.getContext('2d', { willReadFrequently: true });
function grabTransparent() {
    const background = scene.background;
    const gizmoVisible = gizmoHelper.visible;
    scene.background = null;
    gizmoHelper.visible = false;
    lineMaterial.uniforms.clear.value = 1;
    renderFrame();
    scene.background = background;
    gizmoHelper.visible = gizmoVisible;
    lineMaterial.uniforms.clear.value = 0;
    const { width, height } = renderer.domElement;
    if (!width || !height) return null; // 창이 접혀 크기가 0
    if (grabCanvas.width !== width || grabCanvas.height !== height) {
        grabCanvas.width = width;
        grabCanvas.height = height;
    } else {
        grabContext.clearRect(0, 0, width, height);
    }
    grabContext.drawImage(renderer.domElement, 0, 0); // 그린 직후(같은 작업 안)라 preserveDrawingBuffer 없이 읽힘
    return grabContext.getImageData(0, 0, width, height);
}
let exportName = 'weapon';
const exportCropToggle = document.getElementById('export-crop');
document.getElementById('save-png').addEventListener('click', () => {
    const image = grabTransparent();
    renderFrame(); // 화면은 다시 배경 있게
    if (image) savePng(image, exportCropToggle.checked, safeName(exportName));
});
// 움짤 녹화: 정해진 fps로 시간을 딱 1/fps씩 진행하면서(애니메이션·자동 회전 모두) 매 프레임을 캡처. 화면 갱신도 그 fps로 맞춰서 실제 속도로 보임
// 녹화 중에 버튼(발사 등)을 누르거나 끌어서 돌리면 그대로 담김. 녹화 중 화면은 투명 배경(체크무늬)
// 프레임은 투명 여백을 잘라서 보관. 메모리 보호로 REC_MAX_BYTES를 넘으면 거기서 멈춤
const REC_MAX_BYTES = 1.5e9;
const recFps = document.getElementById('rec-fps');
const recLength = document.getElementById('rec-length');
const recTurn = document.getElementById('rec-turn');
const recButton = document.getElementById('rec-start');
let recording = null; // { fps, step, acc, frames, bytes, total, width, height, smooth }
function startRecording() {
    const fps = Number(recFps.value);
    const { width, height } = renderer.domElement;
    recording = { fps, step: 1 / fps, acc: 1 / fps, frames: [], bytes: 0, total: Math.max(1, Math.round(recLength.valueAsNumber * fps) || 1), width, height, smooth: !pixelMode };
    recButton.classList.add('recording');
    setText(recButton, 'export.stop');
}
function stopRecording() {
    const rec = recording;
    recording = null;
    recButton.classList.remove('recording');
    setText(recButton, 'export.rec');
    renderFrame();
    if (rec.frames.length) openSequenceEditor({ ...rec, name: safeName(exportName) });
}
function captureFrame() {
    const image = grabTransparent();
    if (!image) return;
    const frame = cropFrame(image);
    recording.frames.push(frame);
    recording.bytes += frame.image?.data.length ?? 0;
    recButton.textContent = t('export.stopCount', { n: recording.frames.length, total: recording.total });
    if (recording.frames.length >= recording.total) stopRecording();
    else if (recording.bytes > REC_MAX_BYTES) {
        stopRecording();
        alert(t('export.memory'));
    }
}
recButton.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
// 자동 회전 중이면 한 바퀴(= 처음과 끝이 이어지는 길이)를 녹화 길이로 넣는 버튼을 보임
function updateRecTurn() { recTurn.hidden = !autoRotate; }
autoButton.addEventListener('click', updateRecTurn);
updateRecTurn();
recTurn.addEventListener('click', () => {
    recLength.value = (2 * Math.PI / (AUTO_ROTATE_SPEED * speedSlider.valueAsNumber)).toFixed(2);
});

// 5. 애니메이션 루프
const timer = new THREE.Timer();
function animate(timestamp) {
    requestAnimationFrame(animate);
    timer.update(timestamp);
    let dt = timer.getDelta();
    if (editor.open) return; // 움짤 편집 중에는 3D 화면을 안 그림 (편집기가 가림)
    if (recording) {
        // 녹화 fps 간격이 될 때만 진행. 느린 기기에서 밀린 시간은 버려서 프레임 간격은 항상 1/fps
        recording.acc += dt;
        if (recording.acc < recording.step) return;
        recording.acc = Math.min(recording.acc - recording.step, recording.step);
        dt = recording.step;
    }
    if (autoRotate) {
        modelPivot.quaternion.premultiply(autoRotateQuat.setFromAxisAngle(WORLD_UP, AUTO_ROTATE_SPEED * speedSlider.valueAsNumber * dt));
        showRotation();
    }
    if (mixers.length && !animPaused) {
        for (const m of mixers) m.update(dt);
        applyUvProxies();
    }
    controls.update(); // 컨트롤러 업데이트
    if (recording) captureFrame();
    else renderFrame();
}
animate();

// 우측 패널 묶음(셰이더·저장·조명·회전)을 하단 바(카테고리 바) 바로 위에 둠. 패널 높이가 바뀌어도 위로만 늘어나서 하단 바와 안 겹치고,
// 화면 위쪽 여백(20px)을 넘지 않게 max-height를 걸어 둠 (넘치면 셰이더 패널만 줄어듦)
const rightStack = document.getElementById('right-stack');
const bottomBar = document.getElementById('bottom-bar');
const topRight = document.getElementById('top-right'); // 우측 최상단 언어 선택·저작권·문의. 우측 패널 묶음은 그 아래까지만
function placeRightStack() {
    const ui = rightStack.offsetParent.getBoundingClientRect();
    const bar = bottomBar.getBoundingClientRect();
    rightStack.style.bottom = `${ui.bottom - bar.top + 10}px`;
    rightStack.style.maxHeight = `${Math.max(0, bar.top - 10 - topRight.getBoundingClientRect().bottom - 10)}px`;
}
// 하단 바의 위치는 같은 세로 흐름의 다른 칸(무기 목록·언어 선택) 크기에 따라서도 밀릴 수 있어서 함께 지켜봄
const stackObserver = new ResizeObserver(placeRightStack);
for (const el of [bottomBar, document.getElementById('side-panel'), document.getElementById('left-bottom'), topRight]) stackObserver.observe(el);
window.addEventListener('resize', placeRightStack);
placeRightStack();

// 창 크기 조절 대응
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});




const weaponData = [
    { id: 'Shooter', img: 'IconTypeWpn_00.png',
        items: [  
                {file: 'Blaze', img: 'Path_Wst_Shooter_Blaze_00.png'},
                {file: 'Blaze_Cstm01', img: 'Path_Wst_Shooter_Blaze_01.png'},
                {file: 'Blaze_Cstm02', img: 'Path_Wst_Shooter_Blaze_02.png'},
                {file: 'Expert', img: 'Path_Wst_Shooter_Expert_00.png'},
                {file: 'Expert_Cstm01', img: 'Path_Wst_Shooter_Expert_01.png'},
                {file: 'Expert_Cstm02', img: 'Path_Wst_Shooter_Expert_02.png'},
                {file: 'First', img: 'Path_Wst_Shooter_First_00.png'},
                {file: 'First_Cstm01', img: 'Path_Wst_Shooter_First_01.png'},
                {file: 'Flash', img: 'Path_Wst_Shooter_Flash_00.png'},
                {file: 'Flash_Cstm01', img: 'Path_Wst_Shooter_Flash_01.png'},
                {file: 'Gravity', img: 'Path_Wst_Shooter_Gravity_00.png'},
                {file: 'Gravity_Cstm01', img: 'Path_Wst_Shooter_Gravity_01.png'},
                {file: 'Heavy', img: 'Path_Wst_Shooter_Heavy_00.png'},
                {file: 'Heavy_Cstm01', img: 'Path_Wst_Shooter_Heavy_01.png'},
                {file: 'Heavy_Cstm02', img: 'Path_Wst_Shooter_Heavy_02.png'},
                {file: 'Long', img: 'Path_Wst_Shooter_Long_00.png'},
                {file: 'Long_Cstm01', img: 'Path_Wst_Shooter_Long_01.png'},
                {file: 'Long_Cstm02', img: 'Path_Wst_Shooter_Long_02.png'},
                {file: 'Msn0Lv0', img: 'Path_Wst_Shooter_Normal_H.png'}, // Lv1·Lv2는 animBar의 레벨 슬라이더로
                //name: '스플랫 슈터(Splatoon1)', file: 'Normal'},
                //name: '스플랫 슈터 컬래버(Splatoon1)', file: 'Normal_Cstm'},
                //name: '스플랫 슈터(Splatoon2)', file: 'NormalB'},
                //name: '스플랫 슈터 컬래버(Splatoon1)', file: 'Normal_Cstm'},
                {file: 'NormalT', img: 'Path_Wst_Shooter_Normal_00.png'},
                {file: 'NormalT_Cstm01', img: 'Path_Wst_Shooter_Normal_01.png'},
                {file: 'NormalT_Cstm02', img: 'Path_Wst_Shooter_Normal_02.png'},
                {file: 'Normal_SprlA', img: 'Path_Wst_Shooter_Normal_S.png'},
                {file: 'RvSdodr', img: 'Path_Wst_Shooter_Normal_Oct.png'},
                {file: 'NormalSdodr', img: 'Path_Wst_Shooter_Normal_O.png'},
                {file: 'QuickLong', img: 'Path_Wst_Shooter_QuickLong_00.png'},
                {file: 'QuickLong_Cstm01', img: 'Path_Wst_Shooter_QuickLong_01.png'},
                {file: 'QuickMiddle', img: 'Path_Wst_Shooter_QuickMiddle_00.png'},
                {file: 'QuickMiddle_Cstm01', img: 'Path_Wst_Shooter_QuickMiddle_01.png'},
                {file: 'Short', img: 'Path_Wst_Shooter_Short_00.png'},
                {file: 'Short_Cstm01', img: 'Path_Wst_Shooter_Short_01.png'},
                {file: 'Precision', img: 'Path_Wst_Shooter_Precision_00.png'},
                {file: 'Short_Cstm11', img: 'Path_Wst_Shooter_Precision_01.png'},
                {file: 'Short_Cstm12', img: 'Path_Wst_Shooter_Precision_02.png'},
                {file: 'TripleQuick', img: 'Path_Wst_Shooter_TripleQuick_00.png'},
                {file: 'TripleQuick_Cstm01', img: 'Path_Wst_Shooter_TripleQuick_01.png'},
                {file: 'TripleQuick_Cstm02', img: 'Path_Wst_Shooter_TripleQuick_02.png'},
                {file: 'TripleMiddle', img: 'Path_Wst_Shooter_TripleMiddle_00.png'},
                {file: 'TripleMiddle_Cstm01', img: 'Path_Wst_Shooter_TripleMiddle_01.png'},
                {file: 'TripleMiddle_Cstm02', img: 'Path_Wst_Shooter_TripleMiddle_02.png'},
                //{name: '스플랫 슈터(적,Lv0)', file: 'RvLv0'},
                //{name: '스플랫 슈터(적,Lv1)', file: 'RvLv1'},
                //{name: '스플랫 슈터(적,사이드오더)', file: 'RvSdodr'},
        ]
     },
    { id: 'Blaster', img: 'IconTypeWpn_01.png',
        items: [
            {file: 'Short', img: 'Path_Wst_Blaster_Short_00.png'},
            {file: 'Short_Cstm01', img: 'Path_Wst_Blaster_Short_01.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Blaster_Short_O.png'},
            {file: 'Middle', img: 'Path_Wst_Blaster_Middle_00.png'},
            {file: 'Middle_Cstm01', img: 'Path_Wst_Blaster_Middle_01.png'},
            {file: 'Middle_Cstm02', img: 'Path_Wst_Blaster_Middle_02.png'},
            {file: 'LightShort', img: 'Path_Wst_Blaster_LightShort_00.png'},
            {file: 'LightShort_Cstm01', img: 'Path_Wst_Blaster_LightShort_01.png'},
            {file: 'Light', img: 'Path_Wst_Blaster_Light_00.png'},
            {file: 'Light_Cstm01', img: 'Path_Wst_Blaster_Light_01.png'},
            {file: 'Long', img: 'Path_Wst_Blaster_Long_00.png'},
            {file: 'Long_Cstm01', img: 'Path_Wst_Blaster_Long_01.png'},
            {file: 'LightLong', img: 'Path_Wst_Blaster_LightLong_00.png'},
            {file: 'LightLong_Cstm11', img: 'Path_Wst_Blaster_LightLong_01.png'},
            {file: 'LightLong_Cstm12', img: 'Path_Wst_Blaster_LightLong_02.png'},
            {file: 'Precision', img: 'Path_Wst_Blaster_Precision_00.png'},
            {file: 'Precision_Cstm01', img: 'Path_Wst_Blaster_Precision_01.png'},
            {file: 'Coop', img: 'Path_Wst_Blaster_Bear.png'},
        ]
     },
    { id: 'Maneuver', img: 'IconTypeWpn_02.png',   // 머누버 아닌가요? 응 아니야
        items: [
            {file: 'NormalT', img: 'Path_Wst_Maneuver_Normal_00.png'},
            {file: 'NormalT_Cstm01', img: 'Path_Wst_Maneuver_Normal_01.png'},
            {file: 'NormalT_Cstm02', img: 'Path_Wst_Maneuver_Normal_02.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Maneuver_Normal_O.png'},
            {file: 'Short', img: 'Path_Wst_Maneuver_Short_00.png'},
            {file: 'Short_Cstm01', img: 'Path_Wst_Maneuver_Short_01.png'},
            {file: 'Short_Cstm02', img: 'Path_Wst_Maneuver_Short_02.png'},
            {file: 'Stepper', img: 'Path_Wst_Maneuver_Stepper_00.png'},
            {file: 'Stepper_Cstm01', img: 'Path_Wst_Maneuver_Stepper_01.png'},
            {file: 'Long', img: 'Path_Wst_Maneuver_Long_00.png'},
            {file: 'Long_Cstm01', img: 'Path_Wst_Maneuver_Long_01.png'},
            {file: 'Dual', img: 'Path_Wst_Maneuver_Dual_00.png'},
            {file: 'Dual_Cstm01', img: 'Path_Wst_Maneuver_Dual_01.png'},
            {file: 'Dual_Cstm02', img: 'Path_Wst_Maneuver_Dual_02.png'},
            {file: 'Gallon', img: 'Path_Wst_Maneuver_Gallon_00.png'},
            {file: 'Gallon_Cstm01', img: 'Path_Wst_Maneuver_Gallon_01.png'},
            {file: 'Coop', img: 'Path_Wst_Maneuver_Bear.png'},
        ]
    },
    { id: 'Spinner', img: 'IconTypeWpn_03.png',
        items: [
            {file: 'StandardT', img: 'Path_Wst_Spinner_Standard_00.png'},
            {file: 'StandardT_Cstm01', img: 'Path_Wst_Spinner_Standard_01.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Spinner_Standard_O.png'},
            {file: 'Downpour', img: 'Path_Wst_Spinner_Downpour_00.png'},
            {file: 'Downpour_Cstm01', img: 'Path_Wst_Spinner_Downpour_01.png'},
            {file: 'HyperShort', img: 'Path_Wst_Spinner_HyperShort_00.png'},
            {file: 'HyperShort_Cstm01', img: 'Path_Wst_Spinner_HyperShort_01.png'},
            {file: 'HyperT', img: 'Path_Wst_Spinner_Hyper_00.png'},
            {file: 'HyperT_Cstm01', img: 'Path_Wst_Spinner_Hyper_01.png'},
            {file: 'HyperT_Cstm02', img: 'Path_Wst_Spinner_Hyper_02.png'},
            {file: 'QuickT', img: 'Path_Wst_Spinner_Quick_00.png'},
            {file: 'QuickT_Cstm01', img: 'Path_Wst_Spinner_Quick_01.png'},
            {file: 'QuickT_Cstm02', img: 'Path_Wst_Spinner_Quick_02.png'},
            {file: 'Serein', img: 'Path_Wst_Spinner_Serein_00.png'},
            {file: 'Serein_Cstm01', img: 'Path_Wst_Spinner_Serein_01.png'},
        ]
     },
    { id: 'Charger', img: 'IconTypeWpn_04.png',
        items: [
            {file: 'Keeper', img: 'Path_Wst_Charger_Keeper_00.png'},
            {file: 'Keeper_Cstm01', img: 'Path_Wst_Charger_Keeper_01.png'},
            {file: 'Light', img: 'Path_Wst_Charger_Light_00.png'},
            {file: 'Light_Cstm01', img: 'Path_Wst_Charger_Light_01.png'},
            {file: 'Long', img: 'Path_Wst_Charger_Long_00.png'},
            {file: 'Long_Cstm01', img: 'Path_Wst_Charger_Long_01.png'},
            {file: 'LongScope', img: 'Path_Wst_Charger_LongScope_00.png'},
            {file: 'LongScope_Cstm01', img: 'Path_Wst_Charger_LongScope_01.png'},
            // {name: '리터 4K(Splatoon 2)', file: 'LongB'}, 
            {file: 'NormalSdodr', img: 'Path_Wst_Charger_Normal_O.png'},
            {file: 'NormalT', img: 'Path_Wst_Charger_Normal_00.png'},
            {file: 'NormalT_Cstm01', img: 'Path_Wst_Charger_Normal_01.png'},
            {file: 'NormalT_Cstm02', img: 'Path_Wst_Charger_Normal_02.png'},
            {file: 'NormalTScope', img: 'Path_Wst_Charger_NormalScope_00.png'},
            {file: 'NormalTScope_Cstm01', img: 'Path_Wst_Charger_NormalScope_01.png'},
            {file: 'NormalTScope_Cstm02', img: 'Path_Wst_Charger_NormalScope_02.png'},
            {file: 'Pencil', img: 'Path_Wst_Charger_Pencil_00.png'},
            {file: 'Pencil_Cstm01', img: 'Path_Wst_Charger_Pencil_01.png'},
            {file: 'Quick', img: 'Path_Wst_Charger_Quick_00.png'},
            {file: 'Quick_Cstm01', img: 'Path_Wst_Charger_Quick_01.png'},
            {file: 'Coop', img: 'Path_Wst_Charger_Bear.png'},
        ]
     },
    { id: 'Roller', img: 'IconTypeWpn_05.png',
        items: [
            // {name: '호쿠사이?', file: 'BrushNormal'},    // 호쿠사이가 Roller 태그를 갖고있음. 이유는 알수없음. Wmn_Brush_Normal과 무슨차이인지도 알 수 없음.
            // {name: '호쿠사이 휴?', file: 'BrushNormal_Cstm'},    // 제외사유 동일
            {file: 'NormalT', img: 'Path_Wst_Roller_Normal_00.png'},
            {file: 'NormalT_Cstm01', img: 'Path_Wst_Roller_Normal_01.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Roller_Normal_O.png'},
            {file: 'Compact', img: 'Path_Wst_Roller_Compact_00.png'},
            {file: 'Compact_Cstm01', img: 'Path_Wst_Roller_Compact_01.png'},
            {file: 'Compact_Cstm02', img: 'Path_Wst_Roller_Compact_02.png'},
            {file: 'Heavy', img: 'Path_Wst_Roller_Heavy_00.png'},             // 다이너모 아닌가요? 응 아니야
            {file: 'Heavy_Cstm01', img: 'Path_Wst_Roller_Heavy_01.png'},
            {file: 'Heavy_Cstm02', img: 'Path_Wst_Roller_Heavy_02.png'},
            {file: 'Hunter', img: 'Path_Wst_Roller_Hunter_00.png'},
            {file: 'Hunter_Cstm01', img: 'Path_Wst_Roller_Hunter_01.png'},
            {file: 'Wide', img: 'Path_Wst_Roller_Wide_00.png'},
            {file: 'Wide_Cstm01', img: 'Path_Wst_Roller_Wide_01.png'},
            {file: 'Wide_Cstm02', img: 'Path_Wst_Roller_Wide_02.png'},
            {file: 'Coop', img: 'Path_Wst_Roller_Bear.png'},
        ]
     },
    { id: 'Brush', img: 'IconTypeWpn_06.png',
        items: [
            {file: 'Normal', img: 'Path_Wst_Brush_Normal_00.png'},
            {file: 'Normal_Cstm01', img: 'Path_Wst_Brush_Normal_01.png'},
            {file: 'Normal_Cstm02', img: 'Path_Wst_Brush_Normal_02.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Brush_Normal_O.png'},
            {file: 'Mini', img: 'Path_Wst_Brush_Mini_00.png'},
            {file: 'Mini_Cstm01', img: 'Path_Wst_Brush_Mini_01.png'},
            {file: 'Heavy', img: 'Path_Wst_Brush_Heavy_00.png'},
            {file: 'Heavy_Cstm01', img: 'Path_Wst_Brush_Heavy_01.png'},
            {file: 'Heavy_Cstm02', img: 'Path_Wst_Brush_Heavy_02.png'},
        ] },
    { id: 'Slosher', img: 'IconTypeWpn_07.png',
        items: [
            {file: 'StrongT', img: 'Path_Wst_Slosher_Strong_00.png'},
            {file: 'StrongT_Cstm01', img: 'Path_Wst_Slosher_Strong_01.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Slosher_Strong_O.png'},
            {file: 'Diffusion', img: 'Path_Wst_Slosher_Diffusion_00.png'},
            {file: 'Diffusion_Cstm01', img: 'Path_Wst_Slosher_Diffusion_01.png'},
            {file: 'Diffusion_Cstm02', img: 'Path_Wst_Slosher_Diffusion_02.png'},
            {file: 'Double', img: 'Path_Wst_Slosher_Double_00.png'},
            {file: 'Double_Cstm01', img: 'Path_Wst_Slosher_Double_01.png'},
            {file: 'Double_Cstm02', img: 'Path_Wst_Slosher_Double_02.png'},
            {file: 'Launcher', img: 'Path_Wst_Slosher_Launcher_00.png'},
            {file: 'Launcher_Cstm01', img: 'Path_Wst_Slosher_Launcher_01.png'},
            {file: 'Bathtub', img: 'Path_Wst_Slosher_Bathtub_00.png'},
            {file: 'Bathtub_Cstm01', img: 'Path_Wst_Slosher_Bathtub_01.png'},
            {file: 'Washtub', img: 'Path_Wst_Slosher_Washtub_00.png'},
            {file: 'Washtub_Cstm01', img: 'Path_Wst_Slosher_Washtub_01.png'},
            {file: 'Coop', img: 'Path_Wst_Slosher_Bear.png'},
        ] },
    { id: 'Shelter', img: 'IconTypeWpn_08.png',
        items: [
            {file: 'Normal', img: 'Path_Wst_Shelter_Normal_00.png'},
            {file: 'Normal_Cstm01', img: 'Path_Wst_Shelter_Normal_01.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Shelter_Normal_O.png'},
            {file: 'Compact', img: 'Path_Wst_Shelter_Compact_00.png'},
            {file: 'Compact_Cstm01', img: 'Path_Wst_Shelter_Compact_01.png'},
            {file: 'Compact_Cstm02', img: 'Path_Wst_Shelter_Compact_02.png'},
            {file: 'Wide', img: 'Path_Wst_Shelter_Wide_00.png'},
            {file: 'Wide_Cstm01', img: 'Path_Wst_Shelter_Wide_01.png'},
            {file: 'Wide_Cstm02', img: 'Path_Wst_Shelter_Wide_02.png'},
            {file: 'Focus', img: 'Path_Wst_Shelter_Focus_00.png'},
            {file: 'Focus_Cstm01', img: 'Path_Wst_Shelter_Focus_01.png'},
            {file: 'Coop', img: 'Path_Wst_Shelter_Bear.png'},
        ] },
    { id: 'Stringer', img: 'IconTypeWpn_09.png',
        items: [
            {file: 'Normal', img: 'Path_Wst_Stringer_Normal_00.png'},
            {file: 'Normal_Cstm01', img: 'Path_Wst_Stringer_Normal_01.png'},
            {file: 'Normal_Cstm02', img: 'Path_Wst_Stringer_Normal_02.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Stringer_Normal_O.png'},
            {file: 'Short', img: 'Path_Wst_Stringer_Short_00.png'},
            {file: 'Short_Cstm01', img: 'Path_Wst_Stringer_Short_01.png'},
            {file: 'Short_Cstm02', img: 'Path_Wst_Stringer_Short_02.png'},
            {file: 'Explosion', img: 'Path_Wst_Stringer_Explosion_00.png'},
            {file: 'Explosion_Cstm01', img: 'Path_Wst_Stringer_Explosion_01.png'},
            {file: 'Coop', img: 'Path_Wst_Stringer_Bear.png'},
        ] },
    { id: 'Saber', img: 'IconTypeWpn_10.png',
        items: [
            {file: 'Normal', img: 'Path_Wst_Saber_Normal_00.png'},
            {file: 'Normal_Cstm01', img: 'Path_Wst_Saber_Normal_01.png'},
            {file: 'Normal_Cstm02', img: 'Path_Wst_Saber_Normal_02.png'},
            {file: 'NormalSdodr', img: 'Path_Wst_Saber_Normal_O.png'},
            {file: 'Light', img: 'Path_Wst_Saber_Lite_00.png'},
            {file: 'Light_Cstm01', img: 'Path_Wst_Saber_Lite_01.png'},
            {file: 'Light_Cstm02', img: 'Path_Wst_Saber_Lite_02.png'},
            {file: 'Heavy', img: 'Path_Wst_Saber_Heavy_00.png'}, // 케이스는 따로 된 Case 모델 대신 본 모델의 Case 부품을 켜고 끔 (사용자 요청, setupSaber)
            {file: 'Heavy_Cstm01', img: 'Path_Wst_Saber_Heavy_01.png'},
            {file: 'Coop', img: 'Path_Wst_Saber_Bear.png'},
        ] }
];

const listTitle = document.getElementById('list-title');
const modelList = document.getElementById('model-list');
const categoryBar = document.getElementById('category-bar');

// 무기 이미지: img/weapon_flat/의 item.img. 아직 못 찾은 무기는 'Dummy.png' (weaponData에서 img를 바꾸면 됨)
let currentCat = null;
weaponData.forEach(cat => {
    const btn = document.createElement('div');
    btn.className = 'cat-btn';
    btn.style.backgroundImage = `url(img/wpntypes/${cat.img})`;
    
    btn.onclick = () => {
        currentCat = btn;
        for (const other of categoryBar.children) other.classList.toggle('active', other === btn);
        // console.log(`${cat.name} 카테고리 선택됨`);
        
        listTitle.removeAttribute('data-i18n'); // 처음 글자('무기')만 i18n 키, 이후는 무기군 이름
        listTitle.textContent = categoryName(cat.id);
        modelList.innerHTML = '';
        cat.items.forEach(item => {
            const li = document.createElement('li');
            const img = document.createElement('img');
            img.src = `img/weapon_flat/${item.img}`;
            img.alt = '';
            img.loading = 'lazy';
            img.draggable = false; // 이미지를 끌면 드래그 스크롤 대신 이미지 끌기가 됨
            const label = document.createElement('span');
            label.textContent = weaponName(`${cat.id}_${item.file}`);
            li.append(img, label);
            li.dataset.file = item.file;
            const name = `Wmn_${cat.id}_${item.file}`;
            li.onclick = () => {
                exportName = englishWeaponName(`${cat.id}_${item.file}`) ?? name; // 저장 파일 이름은 언어와 상관없이 영어 무기 이름 (없으면 모델 파일 이름)
                loadGlb(`glb/${name}.glb`, cat.id === 'Maneuver');
            };
            modelList.appendChild(li);
        });
    };
    categoryBar.appendChild(btn);
});
// 무기 목록 마우스 드래그 스크롤 (터치는 브라우저 기본 스와이프). 몇 px 이상 끌었으면 놓을 때의 클릭은 무기 선택으로 치지 않음
const LIST_DRAG_PX = 5;
let listDrag = null;
modelList.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    listDrag = { y: e.clientY, scroll: modelList.scrollTop, moved: false };
});
window.addEventListener('pointermove', (e) => {
    if (!listDrag) return;
    const dy = e.clientY - listDrag.y;
    if (!listDrag.moved && Math.abs(dy) < LIST_DRAG_PX) return;
    listDrag.moved = true;
    modelList.scrollTop = listDrag.scroll - dy;
});
window.addEventListener('pointerup', () => {
    if (!listDrag?.moved) { listDrag = null; return; }
    setTimeout(() => { listDrag = null; }); // 바로 뒤따르는 click을 아래에서 막은 다음 풀어 줌
});
modelList.addEventListener('click', (e) => { if (listDrag?.moved) e.stopPropagation(); }, true);
onLangChange(() => {
    // 목록을 다시 그려도 스크롤 위치는 유지
    const scroll = modelList.scrollTop;
    currentCat?.onclick();
    modelList.scrollTop = scroll;
});
mountLangPicker(document.getElementById('lang-picker'));

// 첫 화면: 슈터 목록을 펼치고 스플랫 슈터를 불러옴
categoryBar.firstChild.click();
[...modelList.children].find((li) => li.dataset.file === 'NormalT').click();