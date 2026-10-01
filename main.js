import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

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

const renderer = new THREE.WebGLRenderer({ antialias: true });
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
dirLight.castShadow = true;
// 그림자 범위 설정 (모델 크기에 맞춰 조정 필요)
dirLight.shadow.camera.left = -1;
dirLight.shadow.camera.right = 1;
dirLight.shadow.camera.top = 1;
dirLight.shadow.camera.bottom = -1;
dirLight.shadow.mapSize.width = 2048; // 그림자 해상도
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.001;
dirLight.shadow.camera.far = 10;
dirLight.shadow.bias = -0.0001;
lightRig.add(dirLight);

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

const floor = new THREE.Mesh(planeGeometry, planeMaterial);

// 2. 바닥 눕히기 (기본은 서 있는 상태이므로 X축으로 -90도 회전)
floor.rotation.x = -Math.PI / 2;

// 3. 모델보다 살짝 아래에 위치 (모델 위치에 따라 조정)
floor.position.y = -1.3;

// 4. 그림자를 받고 싶다면 (renderer 설정에 shadowMap.enabled = true 필요)
floor.receiveShadow = true;

scene.add(floor);

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

// 조명 프리셋: 기본 = 위의 직접 조명들 + 빈 환경맵, 스튜디오 = RoomEnvironment 환경맵만 (금속 반사용)
// HDRI = 배경과 조명(환경맵)을 같은 HDRI 한 장으로. 파일은 처음 선택할 때만 받음 (Poly Haven, CC0. three.js 예제에 포함된 1k 버전)
const directLights = [hemiLight, dirLight, dirLight2, bottomLight, bottomLight2, ambientLight];
const LIGHT_PRESETS = {
    default: { environment: pmremGenerator.fromScene(new THREE.Scene()).texture, directLights: true },
    studio: { environment: pmremGenerator.fromScene(new RoomEnvironment()).texture, directLights: false },
    esplanade: { hdri: 'hdri/royal_esplanade_1k.hdr' },
    quarry: { hdri: 'hdri/quarry_01_1k.hdr' },
    sunset: { hdri: 'hdri/venice_sunset_1k.hdr' },
};
const HDRI_BLUR = 0.1; // 배경 흐림 정도 (0 = 선명, 1 = 최대)
const hdriCache = new Map();
function loadHdri(path) {
    if (!hdriCache.has(path)) {
        hdriCache.set(path, new HDRLoader().loadAsync(path).then((texture) => {
            texture.mapping = THREE.EquirectangularReflectionMapping;
            return texture;
        }));
    }
    return hdriCache.get(path);
}
let presetSeq = 0;
async function applyLightPreset(name) {
    const seq = ++presetSeq;
    const preset = LIGHT_PRESETS[name];
    const hdri = preset.hdri ? await loadHdri(preset.hdri) : null;
    if (seq !== presetSeq) return; // 받는 동안 다른 프리셋이 선택됨
    scene.environment = hdri ?? preset.environment;
    scene.background = hdri ?? BACKGROUND_COLOR;
    scene.backgroundBlurriness = hdri ? HDRI_BLUR : 0;
    // HDRI는 1보다 밝은 값(해, 하늘)이 있어서 tone mapping으로 눌러야 자연스러움
    renderer.toneMapping = hdri ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    floor.visible = !hdri; // 회색 바닥은 HDRI 배경과 안 어울림
    for (const light of directLights) light.visible = !hdri && preset.directLights;
}
const lightSelect = document.getElementById('light-preset');
lightSelect.addEventListener('change', () => applyLightPreset(lightSelect.value));
applyLightPreset(lightSelect.value);

// 조명 방향: 수직축 기준으로 직접 조명, 환경맵(조명), HDRI 배경을 함께 돌림. 무기 회전과 따로 빛 방향을 정할 수 있음
const lightAngle = document.getElementById('light-angle');
lightAngle.addEventListener('input', () => {
    const rad = THREE.MathUtils.degToRad(lightAngle.valueAsNumber);
    lightRig.rotation.y = rad;
    scene.environmentRotation.y = rad;
    scene.backgroundRotation.y = rad;
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
            ringVertex.fromBufferAttribute(pos, i).applyMatrix4(handle.matrixWorld).project(camera);
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
    ringRaycaster.setFromCamera(pointer, camera);
    return ringRaycaster.ray.intersectPlane(ringDrag.plane, ringHit);
}
const originalPointerDown = gizmo.pointerDown.bind(gizmo);
gizmo.pointerDown = (pointer) => {
    originalPointerDown(pointer);
    ringDrag.active = false;
    if (!gizmo.dragging || !(gizmo.axis in AXIS_VECTORS)) return;
    ringDrag.axis = AXIS_VECTORS[gizmo.axis];
    modelPivot.getWorldPosition(ringDrag.center);
    const toCamera = ringCross.subVectors(camera.position, ringDrag.center).normalize();
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
    modeButton.textContent = gizmo.enabled ? '모드: 축 회전' : '모드: 자유 회전';
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
    autoButton.textContent = autoRotate ? '자동 회전: 켬' : '자동 회전: 끔';
    speedSlider.parentElement.hidden = !autoRotate; // 속도 슬라이더는 자동 회전 중에만 표시
});

// 패널 숨기기/펼치기 (애니메이션과 아이콘 방향은 CSS의 collapsed 클래스가 담당)
const help = document.getElementById('controls-help');
for (const btn of document.querySelectorAll('.toggle-btn')) {
    if (btn.parentElement === help) continue;
    btn.addEventListener('click', () => btn.parentElement.classList.toggle('collapsed'));
}

// 조작 가이드: 접속 시 3초 보여준 뒤 숨김, 버튼으로 다시 열면 3초 뒤 다시 숨김
const HELP_SHOW_MS = 3000;
let helpTimer = setTimeout(() => help.classList.add('collapsed'), HELP_SHOW_MS);
help.querySelector('.toggle-btn').addEventListener('click', () => {
    clearTimeout(helpTimer);
    if (help.classList.toggle('collapsed')) return; // 보이던 중에 누르면 바로 숨김
    helpTimer = setTimeout(() => help.classList.add('collapsed'), HELP_SHOW_MS);
});



const teamColor = new THREE.Color(0xFEDC0C);

function safeLoad(loader, path) {
    return new Promise(function(resolve) {
        // 1. 원본 경로 시도
        console.log(`텍스처 로드 시도: ${path}`);
        loader.load(path, function(tex) {
            resolve(tex); // 성공 시 반환
        }, undefined, function() {
            // 2. 실패 시 Cstm 제거 후 마지막 시도
            var fallback = path.replaceAll(/_Cstm\d{2}/g, '');
            console.log(`대체 텍스처 로드 시도: ${fallback}`);
            loader.load(fallback, function(tex) {
                resolve(tex);
            }, undefined, function() {
                resolve(null); // 둘 다 실패 시 null
            });
        });
    });
}

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
}

// 모델을 중앙에 두고, 크기에 맞춰 카메라 위치 설정
function placeModel(object) {
    currentModel = object;
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    object.position.sub(center);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2)); // 모델이 화면에 꽉 차는 거리
    camera.position.set(-2 * cameraZ, cameraZ / 2, cameraZ / 2);
    camera.lookAt(center);
    controls.target.set(0, 0, 0);
    controls.update();
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
    if (emissionType !== null) {
        material.emissive.fromArray(emissionType === '1' || emissionType === '2' ? [1, 1, 1] : params.emission_color);
        material.emissiveIntensity = params.emission_intensity;
    }
    const tclMap = await load('_su0');
    // 알베도 텍스처를 끈 머티리얼만 전체가 잉크 색 (예: 스플랫 슈터 병). team_color_map_type 3이어도 알베도가 있으면 알베도 그대로 (예: 새싹/단풍 슈터 캡·스티커)
    const fullTeamColor = options.team_color_map_type === '3' && options.enable_albedo_tex === 'False';
    // 잉크가 묻는 표면 (롤러 헤드, 붓 털 등): 2cl 맵의 흰 영역이 잉크로 덮여서 잉크 색이 됨
    const paintMap = options.blitz_paint_type === '4' ? await load('_cp0') : null;
    material.userData.tclMap = { value: tclMap }; // userData에 둬야 disposeModel이 해제함
    material.userData.paintMap = { value: paintMap };
    const tcl = tclMap ? 'texture2D(tclMap, vS3Uv).r' : fullTeamColor ? '1.0' : '0.0';
    const paint = paintMap ? 'texture2D(paintMap, vS3Uv).r' : '0.0';
    const emissionBase = { '1': 's3Albedo', '2': 'teamColor' }[emissionType] ?? 'vec3(1.0)';
    // manual fresnel: 반사율(F0)을 metalness 대신 manual_fresnel × manual_fresnel_color로 고정 (예: 볼드 마커 유리는 1.0이라 거울처럼 반사)
    // three.js에서 실제 F0로 쓰이는 값은 specularColorBlended (specularColor를 metalness로 섞은 값)
    const f0 = options.enable_manual_fresnel === 'True'
        ? `vec3(${params.manual_fresnel_color.map((c) => (c * params.manual_fresnel).toFixed(4)).join(', ')})` : null;
    material.customProgramCacheKey = () => [tcl, paint, emissionBase, f0].join('|'); // 기본 키(onBeforeCompile 소스)는 머티리얼마다 같아서 셰이더가 섞일 수 있음
    material.onBeforeCompile = (shader) => {
        shader.uniforms.teamColor = { value: teamColor };
        shader.uniforms.tclMap = material.userData.tclMap;
        shader.uniforms.paintMap = material.userData.paintMap;
        shader.vertexShader = 'varying vec2 vS3Uv;\n' + shader.vertexShader.replace(
            '#include <uv_vertex>', '#include <uv_vertex>\nvS3Uv = uv;');
        shader.fragmentShader = 'uniform vec3 teamColor;\nuniform sampler2D tclMap;\nuniform sampler2D paintMap;\nvarying vec2 vS3Uv;\n' + shader.fragmentShader
            .replace('#include <map_fragment>',
                `#include <map_fragment>\nvec3 s3Albedo = diffuseColor.rgb;\ndiffuseColor.rgb = mix(diffuseColor.rgb, teamColor, max(${tcl}, ${paint}));`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= ${emissionBase};`)
            .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${f0 ? `material.specularColorBlended = ${f0};` : ''}`);
    };
    material.needsUpdate = true;
}

function loadGlb(path) {
    const seq = ++loadSeq;
    clearModel();
    new GLTFLoader().load(path, async (gltf) => {
        const materials = new Set();
        gltf.scene.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            if (child.userData.s3?.hidden) child.visible = false; // 게임에서 기본으로 숨겨진 부품 (붙은 본이 invisible)
            materials.add(child.material);
        });
        await Promise.all([...materials].map((m) => setupS3Material(m, gltf.parser)));
        if (seq !== loadSeq) return; // 그 사이 다른 모델이 요청됨
        placeModel(gltf.scene);
    }, undefined, (error) => console.error('에러 발생:', error));
}

// 2. 모델을 화면에 띄우는 함수 (FBX, glb로 옮기기 전 무기군용)
function loadModel(fileName) {
    const seq = ++loadSeq;
    clearModel();
    const textureLoader = new THREE.TextureLoader();
    const loader = new FBXLoader();

    loader.load(`models/${fileName}`, (object) => {
        if (seq !== loadSeq) return; // 그 사이 다른 모델이 요청됨
        

        const folderPath = fileName.substring(0, fileName.lastIndexOf('/') + 1);
        console.log(`경로: ${folderPath}, 파일명: ${fileName}`);
        object.traverse((child) => {
            if (child.isMesh) {
                console.log(`메시 발견: ${child.name}`);
                // 1. 이미 로드된 Alb 파일의 전체 경로(URL)를 가져옴
                child.castShadow = true;    
                child.receiveShadow = true; 

                const prevMat = child.material;
                const newMat = new THREE.MeshStandardMaterial({
                    map: prevMat.map,
                    transparent: false,
                    opacity: prevMat.opacity,
                    side: prevMat.side,
                    roughness: 0.7,
                    metalness: 0.1,
                });
                
                var albFileName = "";
                var isBottle = false;
                if (child.material.map) {
                    albFileName = child.material.map.name;
                }
                else{
                    if (child.name.includes('Body')){
                        albFileName = "M_Body_Alb";
                    }
                    else if (child.name.includes('Bottle')){
                        isBottle = true;
                        if (fileName.includes('Expert')){   // 프라임 슈터
                            albFileName = "M_Body_Alb";
                        }
                        else{
                            albFileName = "M_Bottle_Alb";
                        }
                    }
                    else if (child.name.includes('Logo')){
                        albFileName = "M_Logo_Alb";
                    }
                    else if (child.name.includes('Case_Clear')){
                        albFileName = "M_Case_Clear_Alb";
                    }
                    else if (child.name.includes('Case')){
                        albFileName = "M_Case_Alb";
                    }
                    if (child.name.includes("Cstm01")){
                        albFileName = albFileName.replace("Alb","Cstm01_Alb");
                    }
                }
                
                
                
                
                console.log(`${albFileName} : 알베도 맵 감지됨`);
                // 3. 파일명이 규칙(BB_Alb.png)을 따른다면 치환
                if (albFileName.includes('_Alb')) {
                    if (albFileName.includes('_Cstm')) {
                        console.log(`${albFileName} : 커스텀 버전 감지됨`);
                    }
                    // const orgAlbFileName = albFileName.replace(/_Cstm\d{2}/,'');
                    // const orgFolderPath = folderPath.replace(/_Cstm\d{2}/,'');

                    const rghName = albFileName.replace('_Alb', '_Rgh')+".png";
                    const mtlName = albFileName.replace('_Alb', '_Mtl')+".png";
                    const tclName = albFileName.replace('_Alb', '_Tcl')+".png";
                    const opaName = albFileName.replace('_Alb', '_Opa')+".png";
                    const trmName = albFileName.replace('_Alb', '_Trm')+".png";
                    const nrmName = albFileName.replace('_Alb', '_Nrm') + ".png";
                    const aoName  = albFileName.replace('_Alb', '_Ao') + ".png";
                    const emmName = albFileName.replace('_Alb', '_Emm') + ".png";

                    // 2. 셰이더 수정 준비 (onBeforeCompile을 즉시 정의)
                    newMat.userData.tclMap = { value: null };
                    newMat.userData.opaMap = { value: null}; 
                    newMat.userData.trmMap = { value: null }; 
                    newMat.userData.teamColor = { value: teamColor };

                    newMat.onBeforeCompile = (shader) => {
                        shader.uniforms.tclMap = newMat.userData.tclMap;
                        shader.uniforms.trmMap = newMat.userData.trmMap;
                        shader.uniforms.opaMap = newMat.userData.opaMap;
                        shader.uniforms.teamColor = newMat.userData.teamColor;

                        // 1. Vertex Shader 수정: vCustomUv를 정의하고 전달
                        shader.vertexShader = `
                            varying vec2 vCustomUv;
                        ` + shader.vertexShader;

                        shader.vertexShader = shader.vertexShader.replace(
                            `#include <uv_vertex>`,
                            `#include <uv_vertex>
                            vCustomUv = uv;`
                        );

                        // 2. Fragment Shader 수정: vCustomUv를 사용하여 팀 컬러 믹스
                        shader.fragmentShader = `
                            uniform sampler2D tclMap;
                            uniform sampler2D trmMap;
                            uniform sampler2D opaMap;
                            uniform vec3 teamColor;
                            varying vec2 vCustomUv;
                        ` + shader.fragmentShader;

                        shader.fragmentShader = shader.fragmentShader.replace(
                            `#include <map_fragment>`,
                            `
                            #include <map_fragment>
                            #ifdef USE_MAP
                                // tclMap에서 마스크 추출 (vCustomUv 사용)
                                vec4 tclData = texture2D(tclMap, vCustomUv);
                                diffuseColor.rgb = mix(diffuseColor.rgb, teamColor, tclData.r);

                                // trmMap에서 광택/반사 보정
                                vec4 trmData = texture2D(trmMap, vCustomUv);
                                diffuseColor.rgb += trmData.rgb * 0.1; // 광택 보정
                                
                                // opaMap에서 투명도 추출
                                vec4 opaData = texture2D(opaMap, vCustomUv);
                                //if (opaData.g>0.01 && opaData.g < 0.05) discard; // 일정 값 이하 픽셀은 버림 
                                diffuseColor.a *= opaData.g;
                            #endif
                            `
                        );
                    };

                    const targetMesh = child;

                    if(!newMat.map){
                        safeLoad(textureLoader, `models/${folderPath}${albFileName}.png`).then((albTex) => {
                            if (albTex) {
                                newMat.map = albTex;
                                newMat.needsUpdate = true;
                            }
                        }, undefined, () => {console.log("Alb Map 없음");});
                    }

                    // --- TCl 로드 시도 ---
                    
                    safeLoad(textureLoader, `models/${folderPath}${tclName}`).then((tclTex) => {
                        if (tclTex && !fileName.includes('NormalT_Cstm')) {
                            console.log(`${tclName} : TCl Map 로드됨`);
                            newMat.userData.tclMap.value = tclTex;
                            newMat.needsUpdate = true;
                        }
                    }, null, () => {console.log("TCl Map 없음");});

                    // --- Opa 로드 시도 ---
                    safeLoad( textureLoader, `models/${folderPath}${opaName}`).then((opaTex) => {
                        if (opaTex) {
                            newMat.userData.opaMap.value = opaTex;

                            newMat.transparent = true;
                            newMat.side = THREE.DoubleSide;
                            newMat.depthWrite = false;
                            newMat.depthTest = true;
                            newMat.alphaTest = 0;
                            targetMesh.scale.set(2,2,2);
                            targetMesh.renderOrder = 999;
                            newMat.polygonOffset = true;
                            newMat.polygonOffsetFactor = -4; // -1~-4 사이 조정 (음수일수록 카메라 쪽으로 당겨짐)
                            newMat.polygonOffsetUnits = -4;

                            newMat.needsUpdate = true;
                            console.log(`${opaName} : Opa Map 로드됨`);
                        }
                    }, undefined, () => {
                        newMat.depthWrite = true;
                        child.renderOrder = 0;
                        console.log("Opa Map 없음");
                    });

                    // --- Trm 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${trmName}`).then((trmTex) => {
                        if (trmTex) {
                            newMat.userData.trmMap.value = trmTex;
                            newMat.needsUpdate = true;
                        }
                    }, undefined, () => {console.log("Trm Map 없음");});

                    // --- Roughness 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${rghName}`).then((rghTex) => {
                        if (rghTex) {
                            newMat.roughnessMap = rghTex;
                            child.material.roughness = 0.5;
                            child.material.needsUpdate = true;
                        }
                    }, undefined, () => {console.log("Roughness Map 없음");});

                    // --- AO Map 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${aoName}`).then((aoTex) => {
                        if (aoTex) {
                            newMat.aoMap = aoTex;
                            newMat.aoMapIntensity = 0.3;
                        }
                    }, undefined, () => {console.log("AO Map 없음");});

                    // --- Metalness 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${mtlName}`).then((mtlTex) => {
                        if (mtlTex) {
                            newMat.metalnessMap = mtlTex;
                            newMat.metalness = 0.9;
                            newMat.needsUpdate = true;
                        }
                    }, undefined, () => {console.log("Metalness Map 없음");});


                    // --- Normal Map 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${nrmName}`).then((nrmTex) => {
                        if (nrmTex) {
                            newMat.normalMap = nrmTex;
                            newMat.normalScale.set(1.0, 1.0);
                        }
                    }, undefined, () => {console.log("Normal Map 없음");});

                    // --- Emissive Map 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${emmName}`).then((emmTex) => { // 성공 시
                        if (emmTex) {
                            newMat.emissiveMap = emmTex;
                            newMat.emissive = new THREE.Color(0x000000); // 발광 색상/강도
                            newMat.needsUpdate = true;
                        }
                    }, undefined, () => {console.log("Emissive Map 없음");});

                    // 최종적으로 새 매터리얼 할당
                    
                    child.material = newMat;
                    
                    console.log(`자동 매핑 성공: ${rghName}, ${mtlName}, ${tclName}`);
                }
            }
        });

        placeModel(object);
    }, (xhr) => {
        console.log((xhr.loaded / xhr.total * 100) + '% 로딩 중');
    }, (error) => {
        console.error('에러 발생:', error);
    }); 
}

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

// 5. 애니메이션 루프
const timer = new THREE.Timer();
function animate(timestamp) {
    requestAnimationFrame(animate);
    timer.update(timestamp);
    const dt = timer.getDelta();
    if (autoRotate) {
        modelPivot.quaternion.premultiply(autoRotateQuat.setFromAxisAngle(WORLD_UP, AUTO_ROTATE_SPEED * speedSlider.valueAsNumber * dt));
        showRotation();
    }
    controls.update(); // 컨트롤러 업데이트
    renderer.render(scene, camera);
}
animate();

// 창 크기 조절 대응
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});




const weaponData = [
    { id: 'Shooter', name: '슈터', img: 'wpntypes/IconTypeWpn_00.png', format: 'glb',
        items: [  
                {name: '프로모델러 MG', file: 'Blaze'},
                {name: '프로모델러 RG', file: 'Blaze_Cstm01'},
                {name: '컬러 프로모델러', file: 'Blaze_Cstm02'},
                {name: '프라임 슈터', file: 'Expert'},
                {name: '프라임 슈터 컬래버', file: 'Expert_Cstm01'},
                {name: '프라임 슈터 FRZN', file: 'Expert_Cstm02'},
                {name: '새싹 슈터', file: 'First'},
                {name: '단풍 슈터', file: 'First_Cstm01'},
                {name: '보틀 가이저', file: 'Flash'},
                {name: '포일 보틀 가이저', file: 'Flash_Cstm01'},
                {name: '.52 갤런', file: 'Gravity'},
                {name: '.52 갤런 데코', file: 'Gravity_Cstm01'},
                {name: '.96 갤런', file: 'Heavy'},
                {name: '.96 갤런 데코', file: 'Heavy_Cstm01'},
                {name: '클로 .96 갤런', file: 'Heavy_Cstm02'},
                {name: '제트 스위퍼', file: 'Long'},
                {name: '커스텀 제트 스위퍼', file: 'Long_Cstm01'},
                {name: '제트 스위퍼 COBR', file: 'Long_Cstm02'},
                {name: '히어로 슈터(Lv0)', file: 'Msn0Lv0'},
                {name: '히어로 슈터(Lv1)', file: 'Msn0Lv1'},
                {name: '히어로 슈터(Lv2)', file: 'Msn0Lv2'},
                //name: '스플랫 슈터(Splatoon1)', file: 'Normal'},
                //name: '스플랫 슈터 컬래버(Splatoon1)', file: 'Normal_Cstm'},
                //name: '스플랫 슈터(Splatoon2)', file: 'NormalB'},
                //name: '스플랫 슈터 컬래버(Splatoon1)', file: 'Normal_Cstm'},
                {name: '스플랫 슈터', file: 'NormalT'},
                {name: '스플랫 슈터 컬래버', file: 'NormalT_Cstm01'},
                {name: '글램 스플랫 슈터', file: 'NormalT_Cstm02'},
                {name: '옥타 슈터 레플리카', file: 'RvSdodr'},
                {name: '오더 슈터 레플리카', file: 'NormalSdodr'},
                {name: '스페이스 슈터', file: 'QuickLong'},
                {name: '스페이스 슈터 컬래버', file: 'QuickLong_Cstm01'},
                {name: 'N-ZAP85', file: 'QuickMiddle'},
                {name: 'N-ZAP89', file: 'QuickMiddle_Cstm01'},
                {name: '볼드 마커', file: 'Short'},
                {name: '볼드 마커 네오', file: 'Short_Cstm01'},
                {name: '샤프 마커', file: 'Precision'},
                {name: '샤프 마커 네오', file: 'Short_Cstm11'},
                {name: '샤프 마커 GECK', file: 'Short_Cstm12'},
                {name: 'L3 릴 건', file: 'TripleQuick'},
                {name: 'L3 릴 건 D', file: 'TripleQuick_Cstm01'},
                {name: '글리터 L3 릴 건', file: 'TripleQuick_Cstm02'},
                {name: 'H3 릴 건', file: 'TripleMiddle'},
                {name: 'H3 릴 건 D', file: 'TripleMiddle_Cstm01'},
                {name: 'H3 릴 건 SNAK', file: 'TripleMiddle_Cstm02'},
                //{name: '스플랫 슈터(적,Lv0)', file: 'RvLv0'},
                //{name: '스플랫 슈터(적,Lv1)', file: 'RvLv1'},
                //{name: '스플랫 슈터(적,사이드오더)', file: 'RvSdodr'},
        ]
     },
    { id: 'Blaster', name: '블래스터', img: 'wpntypes/IconTypeWpn_01.png',
        items: [
            {name: '노바 블래스터', file: 'Short'},
            {name: '네오 노바 블래스터', file: 'Short_Cstm01'},
            {name: '오더 블래스터 레플리카', file: 'NormalSdodr'},
            {name: '핫 블래스터', file: 'Middle'},
            {name: '커스텀 핫 블래스터', file: 'Middle_Cstm01'},
            {name: '크래시 블래스터', file: 'LightShort'},
            {name: '네오 크래시 블래스터', file: 'LightShort_Cstm01'},
            {name: '래피드 블래스터', file: 'Light'},
            {name: '래피드 블래스터 데코', file: 'Light_Cstm01'},
            {name: '롱 블래스터', file: 'Long'},
            {name: 'R 블래스터 엘리트 데코', file: 'LightLong_Cstm11'},
            {name: 'S-BLAST92', file: 'Precision'},
            {name: 'S-BLAST91', file: 'Precision_Cstm01'},
            {name: 'Mr. 베어표 블래스터', file: 'Coop'},
        ]
     },
    { id: 'Maneuver', name: '머뉴버(우)', img: 'wpntypes/IconTypeWpn_02.png',
        items: [
            {name: '스플랫 머뉴버', file: 'NormalT'},
            {name: '스플랫 머뉴버 컬래버', file: 'NormalT_Cstm01'},
            {name: '오더 머뉴버 레플리카', file: 'NormalSdodr'},
            {name: '스퍼터리', file: 'Short'},
            {name: '스퍼터리 휴', file: 'Short_Cstm01'},
            {name: '블랙 쿼드 호퍼', file: 'Stepper'},
            {name: '화이트 쿼드 호퍼', file: 'Stepper_Cstm01'},
            {name: '소방 FF', file: 'Long'},
            {name: '듀얼 스위퍼', file: 'Dual'},
            {name: '커스텀 듀얼 스위퍼', file: 'Dual_Cstm01'},
            {name: '켈빈 525', file: 'Gallon'},
            {name: '켈빈 525 데코', file: 'Gallon_Cstm01'},
            {name: 'Mr. 베어표 머뉴버', file: 'Coop'},
        ]
    },
    { id: 'Spinner', name: '스피너', img: 'wpntypes/IconTypeWpn_03.png',
        items: [
            {name: '배럴 스피너', file: 'StandardT'},
            {name: '배럴 스피너 데코', file: 'StandardT_Cstm01'},
            {name: '오더 스피너 레플리카', file: 'NormalSdodr'},
            {name: '쿠겔 슈라이버', file: 'Downpour'},
            {name: '쿠겔 슈라이버 휴', file: 'Downpour_Cstm01'},
            {name: '이그재미너', file: 'HyperShort'},
            {name: '하이드런트', file: 'HyperT'},
            {name: '스플랫 스피너', file: 'QuickT'},
            {name: '스플랫 스피너 컬래버', file: 'QuickT_Cstm01'},
            {name: '노틸러스 47', file: 'Serein'},
            {name: '노틸러스 49', file: 'Serein_Cstm01'},
        ]
     },
    { id: 'Charger', name: '차저', img: 'wpntypes/IconTypeWpn_04.png',
        items: [
            {name: '소이 튜버', file: 'Keeper'},
            {name: '커스텀 소이 튜버', file: 'Keeper_Cstm01'},
            {name: '14식 대나무 총 갑', file: 'Light'},
            {name: '리터 4K', file: 'Long'},
            // {name: 'a', file: 'LongB'}, 
            {name: '커스텀 리터 4K', file: 'Long_Cstm01'},
            {name: '오더 차저 레플리카', file: 'NormalSdodr'},
            {name: '스플랫 차저', file: 'NormalT'},
            {name: '스플랫 차저 컬래버', file: 'NormalT_Cstm01'},
            {name: 'R-PEN/5H', file: 'Pencil'},
            {name: 'R-PEN/5B', file: 'Pencil_Cstm01'},
            {name: '스퀵 클린 α', file: 'Quick'},
            {name: '스퀵 클린 β', file: 'Quick_Cstm01'},
            {name: 'Mr. 베어표 차저', file: 'Coop'},
        ]
     },
    { id: 'Roller', name: '롤러', img: 'wpntypes/IconTypeWpn_05.png', format: 'glb',
        items: [
            // {name: '호쿠사이?', file: 'BrushNormal'},    // 호쿠사이가 Roller 태그를 갖고있음. 이유는 알수없음. Wmn_Brush_Normal과 무슨차이인지도 알 수 없음.
            // {name: '호쿠사이 휴?', file: 'BrushNormal_Cstm'},    // 제외사유 동일
            {name: '스플랫 롤러', file: 'NormalT'},
            {name: '스플랫 롤러 컬래버', file: 'NormalT_Cstm01'},
            {name: '오더 롤러 레플리카', file: 'NormalSdodr'},
            {name: '카본 롤러', file: 'Compact'},
            {name: '카본 롤러 데코', file: 'Compact_Cstm01'},
            {name: '카본 롤러 ANGL', file: 'Compact_Cstm02'},
            {name: '다이나모 롤러', file: 'Heavy'},             // 다이너모 아닌가요? 응 아니야
            {name: '골드 다이나모 롤러', file: 'Heavy_Cstm01'},
            {name: '스타 다이나모 롤러', file: 'Heavy_Cstm02'},
            {name: '베리어블 롤러', file: 'Hunter'},
            {name: '포일 베리어블 롤러', file: 'Hunter_Cstm01'},
            {name: '와이드 롤러', file: 'Wide'},
            {name: '와이드 롤러 컬래버', file: 'Wide_Cstm01'},
            {name: '플래닛 와이드 롤러', file: 'Wide_Cstm02'},
            {name: '쿠마 롤러', file: 'Coop'},
        ]
     },
    { id: 'Brush', name: '붓', img: 'wpntypes/IconTypeWpn_06.png',
        items: [
            {name: '호쿠사이', file: 'Normal'},
            {name: '호쿠사이 휴', file: 'Normal_Cstm01'},
            {name: '오더 브러시 레플리카', file: 'NormalSdodr'},
            {name: '파블로', file: 'Mini'},
            {name: '파블로 휴', file: 'Mini_Cstm01'},
            {name: '빈센트', file: 'Heavy'},
            {name: '빈센트 휴', file: 'Heavy_Cstm01'},
        ] },
    { id: 'Slosher', name: '슬로셔', img: 'wpntypes/IconTypeWpn_07.png',
        items: [
            {name: '버킷 슬로셔', file: 'StrongT'},
            {name: '버킷 슬로셔 데코', file: 'StrongT_Cstm01'},
            {name: '오더 슬로셔 레플리카', file: 'NormalSdodr'},
            {name: '물통', file: 'Diffusion'},
            {name: '물통 휴', file: 'Diffusion_Cstm01'},
            {name: '몹 링', file: 'Double'},
            {name: '몹 링 D', file: 'Double_Cstm01'},
            {name: '스크루 슬로셔', file: 'Launcher'},
            {name: '네오 스크루 슬로셔', file: 'Launcher_Cstm01'},
            {name: '오버플로셔', file: 'Bathtub'},
            {name: '오버플로셔 데코', file: 'Bathtub_Cstm01'},
            {name: '익스플로셔', file: 'Washtub'},
            {name: '커스텀 익스플로셔', file: 'Washtub_Cstm01'},
            {name: 'Mr. 베어표 슬로셔', file: 'Coop'},
        ] },
    { id: 'Shelter', name: '셸터', img: 'wpntypes/IconTypeWpn_08.png',
        items: [
            {name: '파라 셸터', file: 'Normal'},
            {name: '파라 셸터 소렐라', file: 'Normal_Cstm01'},
            {name: '오더 셸터 레플리카', file: 'NormalSdodr'},
            {name: '스파이 가젯', file: 'Compact'},
            {name: '스파이 가젯 소렐라', file: 'Compact_Cstm01'},
            {name: '캠핑 셸터', file: 'Wide'},
            {name: '캠핑 셸터 소렐라', file: 'Wide_Cstm01'},
            {name: '24식 도돌이 우산 갑', file: 'Focus'},
            {name: 'Mr. 베어표 셸터', file: 'Coop'},
        ] },
    { id: 'Stringer', name: '스트링거', img: 'wpntypes/IconTypeWpn_09.png',
        items: [
            {name: '트라이 스트링거', file: 'Normal'},
            {name: '트라이 스트링거 컬래버', file: 'Normal_Cstm01'},
            {name: '오더 스트링거 레플리카', file: 'NormalSdodr'},
            {name: 'LACT-450', file: 'Short'},
            {name: 'LACT-450 데코', file: 'Short_Cstm01'},
            {name: 'Mr. 베어표 스트링거', file: 'Coop'},
        ] },
    { id: 'Saber', name: '와이퍼', img: 'wpntypes/IconTypeWpn_10.png',
        items: [
            {name: '사무 와이퍼', file: 'Normal'},
            {name: '사무 와이퍼 휴', file: 'Normal_Cstm01'},
            {name: '오더 와이퍼 레플리카', file: 'NormalSdodr'},
            {name: '드라이브 와이퍼', file: 'Light'},
            {name: '드라이브 와이퍼 데코', file: 'Light_Cstm01'},
            {name: '민트 덴탈 와이퍼', file: 'Heavy'},
            {name: '민트 덴탈 와이퍼(케이스X)', file: 'Heavy_NoCase'},
            {name: '잉크 덴탈 와이퍼', file: 'Heavy_Cstm01'},
            {name: '잉크 덴탈 와이퍼(케이스X)', file: 'Heavy_NoCase_Cstm01'},
            {name: 'Mr. 베어표 와이퍼', file: 'Coop'},
        ] }
];

const listTitle = document.getElementById('list-title');
const modelList = document.getElementById('model-list');
const categoryBar = document.getElementById('category-bar');

weaponData.forEach(cat => {
    const btn = document.createElement('div');
    btn.className = 'cat-btn';
    btn.style.backgroundImage = `url(${cat.img})`;
    
    btn.onclick = () => {
        console.log(`${cat.name} 카테고리 선택됨`);
        
        listTitle.textContent = cat.name;
        modelList.innerHTML = '';
        cat.items.forEach(item => {
            const li = document.createElement('li');
            li.textContent = item.name;
            const name = `Wmn_${cat.id}_${item.file}`;
            li.onclick = cat.format === 'glb' ? () => loadGlb(`glb/${name}.glb`) : () => loadModel(`${name}/${name}.fbx`);
            modelList.appendChild(li);
        });
    };
    categoryBar.appendChild(btn);
});

// 첫 화면: 슈터 목록을 펼치고 스플랫 슈터를 불러옴
categoryBar.firstChild.click();
[...modelList.children].find((li) => li.textContent === '스플랫 슈터').click();