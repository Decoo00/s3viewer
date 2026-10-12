// 게임 이펙트(VFXB 이미터) 재생. 데이터: tools/build_effect.py가 만든 glb/effect/<이름>.json
// 계산식 근거: 디컴파일한 이미터 셰이더 (Claude_WorkSpace/s3_effect_analysis/README.md). 시간 단위는 게임 프레임(1/60초)
// 확인 못 한 값은 기본값으로 둠 (README의 '미확인'):
//   - 게임이 넣는 이미터 색(NnVfx2EmitterDynamicParam c10[0]·c10[1], Color0·Color1에 곱함): 팀 잉크색으로 봄
//     (사용자 확인: 게임에서 이 이펙트들은 잉크색을 따라감. 어느 자리로 들어가는지는 추정)
//   - 커스텀 블록 c15[3](Color1 배율)은 1, c15[11](알파 배율·더하기)은 1·0
//   - UVScale(파일에는 0)은 1, 정점 셰이더 상수 c1[0].x는 -0.5 (UV 가운데 기준 회전·확대가 되게)
import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const WRAP = { repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping };
const SIDE = [THREE.DoubleSide, THREE.FrontSide, THREE.BackSide]; // RenderState.DisplaySide 0 양면, 1 앞, 2 뒤

// 키 애니메이션 (시간 = 수명 비율 0~1, 키 사이 선형)
function sampleKeys(keys, t) {
    if (t <= keys[0][0]) return keys[0].slice(1);
    for (let i = 1; i < keys.length; i++) {
        if (t <= keys[i][0]) {
            const [t0, ...a] = keys[i - 1], [t1, ...b] = keys[i];
            const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
            return a.map((v, k) => v + (b[k] - v) * f);
        }
    }
    return keys.at(-1).slice(1);
}
const sampleColor = (c, t) => c.value ?? sampleKeys(c.keys, t);

// 픽셀 셰이더 (게임 Shader.frag를 옮김). c0/c1 = Color0/1 × ColorScale (× 팀색), a0/a1 = Alpha0/1, ea = 이미터 알파(페이드)
const FRAG = {
    // WpsTrapAppear Emitter1: rgb = t0·C0 + C1, a = t0.r·A0 (게임은 깊이 버퍼로 바닥에 묻힌 부분을 지움, 여기선 생략)
    glow: 'vec4 t0 = texture2D(tex0, vUv0.xy); col = t0.rgb * vC0.rgb + vC1.rgb; a = clamp(t0.r * vC0.a, 0.0, 1.0);',
    // Emitter1_Copy1: 샘플러 IsSquareRgb → t0.rgb²
    glowSq: 'vec4 t0 = texture2D(tex0, vUv0.xy); col = t0.rgb * t0.rgb * vC0.rgb + vC1.rgb; a = clamp(t0.a * vC0.a, 0.0, 1.0);',
    // Dot: 색은 C0만, 알파 = (t0.a − t1.a + A0)·2 − 2
    dot: 'float t0 = texture2D(tex0, vUv0.xy).a; float t1 = texture2D(tex1, vUv0.zw).a; col = vC0.rgb; a = clamp((t0 - t1 + vC0.a) * 2.0 - 2.0, 0.0, 1.0);',
    // pillar: rgb = t0²·(1 − t1)·t2·C0 + C1, 알파 = ((t0.a − t1.a)·t2.a − A0)·A1
    pillar: 'vec4 t0 = texture2D(tex0, vUv0.xy); vec4 t1 = texture2D(tex1, vUv0.zw); vec4 t2 = texture2D(tex2, vUv1);'
        + ' col = t0.rgb * t0.rgb * (1.0 - t1.rgb) * t2.rgb * vC0.rgb + vC1.rgb; a = clamp(((t0.a - t1.a) * t2.a - vC0.a) * vC1.a, 0.0, 1.0);',
    // wall: rgb = (t0²·(1 − t1)·C0 + C1)·정점색, 알파 = ((t0.a − t1.a)·정점 알파 − A0)·A1
    wall: 'vec4 t0 = texture2D(tex0, vUv0.xy); vec4 t1 = texture2D(tex1, vUv0.zw);'
        + ' col = (t0.rgb * t0.rgb * (1.0 - t1.rgb) * vC0.rgb + vC1.rgb) * vColor.rgb; a = clamp(((t0.a - t1.a) * vColor.a - vC0.a) * vC1.a, 0.0, 1.0);',
};

// UV: 게임 정점 셰이더 식 uv' = R(−(회전 + 회전량·나이))·(uv − 0.5)·(배율 + 배율량·나이) − (스크롤 + 스크롤량·나이) + 0.5
const UV_GLSL = `
uniform vec4 uvA[3]; // scroll.xy, scrollAdd.xy
uniform vec4 uvB[3]; // scale.xy, scaleAdd.xy
uniform vec2 uvR[3]; // rotate, rotateAdd
uniform vec2 uvD[3]; // IsDensityFixedU·V: 1이면 UV × 크기 (입자 크기 × 이미터 크기, 게임 정점 셰이더 sysTexCoordAttr × sysScaleAttr × c9[140] × c10[3])
uniform vec3 emitterScale;
vec2 animUv(vec2 uv, int i, float age, vec2 size) {
    uv *= mix(vec2(1.0), size, uvD[i]);
    float r = -(uvR[i].x + uvR[i].y * age);
    vec2 p = uv - 0.5;
    p = vec2(p.x * cos(r) - p.y * sin(r), p.x * sin(r) + p.y * cos(r));
    return p * (uvB[i].xy + uvB[i].zw * age) - (uvA[i].xy + uvA[i].zw * age) + 0.5;
}`;

function vertexShader(kind) {
    const place = {
        // 바닥에 눕힌 판 (BillboardType 4): 이미터 XZ 평면, Y축 회전
        quad: `vec3 p = vec3(position.x * iScale.x, 0.0, -position.y * iScale.y);
            p = vec3(p.x * cos(iRot) + p.z * sin(iRot), 0.0, -p.x * sin(iRot) + p.z * cos(iRot));
            vec4 mv = modelViewMatrix * vec4(iPos + p, 1.0);`,
        // 카메라를 보는 판 (BillboardType 0)
        billboard: `vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
            float s = length(modelMatrix[0].xyz);
            mv.xy += position.xy * iScale.xy * s;`,
        // 메쉬 (Tube): CenterY만큼 올림 (게임: pos + 0.5·Center), 초기 Y 회전
        mesh: `vec3 p = (position + vec3(0.5 * center.x, 0.5 * center.y, 0.0)) * iScale;
            p = vec3(p.x * cos(iRot) + p.z * sin(iRot), p.y, -p.x * sin(iRot) + p.z * cos(iRot));
            vec4 mv = modelViewMatrix * vec4(iPos + p, 1.0);`,
    }[kind];
    return `
attribute vec3 iPos; attribute vec3 iScale; attribute float iRot; attribute float iAge;
attribute vec4 iC0; attribute vec4 iC1;
${kind === 'mesh' ? 'attribute vec4 color;' : ''}
uniform vec2 center; uniform float depthOffset;
varying vec4 vUv0; varying vec2 vUv1; varying vec4 vC0; varying vec4 vC1; varying vec4 vColor;
${UV_GLSL}
void main() {
    ${place}
    mv.z += depthOffset;
    gl_Position = projectionMatrix * mv;
    vec2 base = ${kind === 'mesh' ? 'uv' : 'position.xy * vec2(1.0, -1.0) + 0.5'};
    vec2 size = iScale.xy * emitterScale.xy;
    vUv0 = vec4(animUv(base, 0, iAge, size), animUv(base, 1, iAge, size));
    vUv1 = animUv(base, 2, iAge, size);
    vC0 = iC0; vC1 = iC1;
    vColor = ${kind === 'mesh' ? 'color' : 'vec4(1.0)'};
}`;
}

function fragmentShader(shader) {
    return `
uniform sampler2D tex0; uniform sampler2D tex1; uniform sampler2D tex2; uniform float emitAlpha;
varying vec4 vUv0; varying vec2 vUv1; varying vec4 vC0; varying vec4 vC1; varying vec4 vColor;
void main() {
    vec3 col; float a;
    ${FRAG[shader]}
    a *= emitAlpha;
    if (a <= 0.0) discard; // AlphaTest GREATER 0
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
}`;
}

// 데이터 + 텍스처를 한 번만 읽어 둠
const cache = new Map();
export function loadEffectData(url) {
    if (!cache.has(url)) {
        cache.set(url, fetch(url).then((r) => r.json()).then(async (data) => {
            const base = url.slice(0, url.lastIndexOf('/') + 1);
            const names = [...new Set(data.emitters.flatMap((e) => e.samplers.filter(Boolean).map((s) => s.tex)))];
            const textures = Object.fromEntries(await Promise.all(names.map(async (n) => {
                const tex = await loader.loadAsync(`${base}tex/${n}.png`);
                tex.flipY = false; // 게임 UV(왼쪽 위 원점) 그대로
                return [n, tex];
            })));
            const geometries = {};
            for (const [name, m] of Object.entries(data.meshes)) {
                const g = new THREE.InstancedBufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute(m.position, 3));
                g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
                g.setAttribute('color', new THREE.Float32BufferAttribute(m.color ?? new Array(m.position.length / 3 * 4).fill(1), 4));
                g.setIndex(m.index);
                geometries[name] = g;
            }
            return { data, textures, geometries };
        }));
    }
    return cache.get(url);
}

const quadGeometry = new THREE.PlaneGeometry(1, 1);

class Emitter {
    constructor(def, assets, maxCount) {
        this.def = def;
        this.particles = [];
        this.nextFrame = 0;
        const geometry = new THREE.InstancedBufferGeometry().copy(def.mesh ? assets.geometries[def.mesh] : quadGeometry);
        const attr = (name, size) => {
            const a = new THREE.InstancedBufferAttribute(new Float32Array(maxCount * size), size);
            a.setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute(name, a);
            return a;
        };
        this.attrs = { iPos: attr('iPos', 3), iScale: attr('iScale', 3), iRot: attr('iRot', 1), iAge: attr('iAge', 1), iC0: attr('iC0', 4), iC1: attr('iC1', 4) };
        geometry.instanceCount = 0;
        const samplers = def.samplers;
        const texOf = (i) => {
            if (!samplers[i]) return null;
            const tex = assets.textures[samplers[i].tex].clone(); // 이미터마다 감기 방식이 달라서 복제
            tex.wrapS = WRAP[samplers[i].wrap[0]];
            tex.wrapT = WRAP[samplers[i].wrap[1]];
            tex.needsUpdate = true;
            return tex;
        };
        const s = (i) => samplers[i] ?? { scroll: [0, 0], scrollAdd: [0, 0], scale: [1, 1], scaleAdd: [0, 0], rotate: 0, rotateAdd: 0 };
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                tex0: { value: texOf(0) }, tex1: { value: texOf(1) }, tex2: { value: texOf(2) },
                uvA: { value: [0, 1, 2].map((i) => new THREE.Vector4(...s(i).scroll, ...s(i).scrollAdd)) },
                uvB: { value: [0, 1, 2].map((i) => new THREE.Vector4(...s(i).scale, ...s(i).scaleAdd)) },
                uvR: { value: [0, 1, 2].map((i) => new THREE.Vector2(s(i).rotate, s(i).rotateAdd)) },
                uvD: { value: [0, 1, 2].map((i) => new THREE.Vector2(...(s(i).density ?? [false, false]).map(Number))) },
                emitterScale: { value: new THREE.Vector3(1, 1, 1) },
                center: { value: new THREE.Vector2(...def.center) },
                depthOffset: { value: def.depthOffset },
                emitAlpha: { value: 1 },
            },
            vertexShader: vertexShader(def.kind),
            fragmentShader: fragmentShader(def.shader),
            transparent: true, depthWrite: false, side: SIDE[def.side],
        });
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.userData.effect = true;
    }
    // 이미터 시간 t(프레임)에 방출. rate가 1이고 한 번이면 입자 하나
    emit(t, rand) {
        const { emit, volume, velocity } = this.def;
        if (t < emit.start || t >= emit.start + emit.duration) return;
        for (let n = 0; n < emit.rate; n++) {
            const p = { age: 0, pos: new THREE.Vector3(...this.def.trans), vel: new THREE.Vector3(...velocity.dir).multiplyScalar(velocity.speed * (1 - velocity.random * rand())),
                scaleRand: 1 - this.def.scaleRandom * rand(), rot: this.def.rotateInit[1] };
            if (volume.type === 3) { // CircleFill: 반지름 안 원판 (XZ)
                const r = Math.sqrt(rand()), th = rand() * Math.PI * 2;
                p.pos.x += Math.cos(th) * r * volume.radius[0];
                p.pos.z += Math.sin(th) * r * volume.radius[2];
            }
            this.particles.push(p);
        }
    }
    update(dt, emitTime, rand, teamColor) {
        const d = this.def;
        // 방출: 지나간 정수 프레임마다 (0프레임부터)
        for (; this.nextFrame <= emitTime; this.nextFrame++) this.emit(this.nextFrame, rand);
        const g = new THREE.Vector3(...d.gravity);
        this.particles = this.particles.filter((p) => d.infinite || p.age < d.life);
        const a = this.attrs;
        this.particles.forEach((p, i) => {
            const life = d.infinite ? 1 : Math.min(p.age / d.life, 1);
            const k = d.infinite ? (p.age % d.life) / d.life : life; // 무한 수명은 Life 주기로 반복 (LoopRate 100%로 봄)
            const sc = sampleKeys(d.scaleKeys, k);
            a.iPos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
            a.iScale.setXYZ(i, d.scale[0] * sc[0] * p.scaleRand, d.scale[1] * sc[1] * p.scaleRand, d.scale[2] * sc[2] * p.scaleRand);
            a.iRot.setX(i, p.rot + d.rotateAdd[1] * p.age);
            a.iAge.setX(i, p.age);
            const c0 = sampleColor(d.color0, k), c1 = sampleColor(d.color1, k);
            a.iC0.setXYZW(i, c0[0] * d.colorScale * teamColor.r, c0[1] * d.colorScale * teamColor.g, c0[2] * d.colorScale * teamColor.b, sampleColor(d.alpha0, k)[0]);
            a.iC1.setXYZW(i, c1[0] * d.colorScale * teamColor.r, c1[1] * d.colorScale * teamColor.g, c1[2] * d.colorScale * teamColor.b, sampleColor(d.alpha1, k)[0]);
            p.vel.addScaledVector(g, dt);
            p.pos.addScaledVector(p.vel, dt);
            p.age += dt;
        });
        for (const attr of Object.values(a)) attr.needsUpdate = true;
        this.mesh.geometry.instanceCount = this.particles.length;
    }
    dispose() {
        this.mesh.geometry.dispose();
        for (const tex of [this.material.uniforms.tex0.value, this.material.uniforms.tex1.value, this.material.uniforms.tex2.value]) tex?.dispose();
        this.material.dispose();
    }
}

// 이미터 세트 하나 (예: WpsTrapGuide). scale = 게임 ELink가 주는 이미터 크기
export class EffectSet {
    constructor(assets, setName, { scale = 1 } = {}) {
        this.group = new THREE.Group();
        this.group.name = setName;
        this.group.scale.setScalar(scale);
        this.emitters = assets.data.emitters.filter((e) => e.set === setName)
            .map((def) => new Emitter(def, assets, def.infinite ? 1 : Math.ceil(def.emit.rate * def.emit.duration)));
        this.emitters.forEach((e, i) => {
            e.mesh.renderOrder = i; // 데이터 순서대로 그림 (안쪽 벽 → 바깥 벽)
            e.material.uniforms.emitterScale.value.setScalar(scale);
            this.group.add(e.mesh);
        });
        this.time = 0;
        this.fadeOut = null; // 끝내는 중이면 남은 프레임
        this.seed = 1;
    }
    rand = () => { // 재생마다 같은 모양 (seed 고정)
        this.seed = (this.seed * 16807) % 2147483647;
        return this.seed / 2147483647;
    };
    restart() {
        this.time = 0;
        this.seed = 1;
        this.fadeOut = null;
        for (const e of this.emitters) {
            e.particles = [];
            e.nextFrame = 0;
        }
    }
    stop() { // 이미터 세트 끄기: AlphaFadeTime 동안 흐려짐
        if (this.fadeOut === null) this.fadeOut = 0;
    }
    get done() { // 끄는 중이고 다 흐려졌거나, 한 번 방출이 끝나고 입자가 다 사라짐
        if (this.fadeOut !== null) return this.emitters.every((e) => this.fadeOut >= e.def.fadeOut);
        return this.emitters.every((e) => e.nextFrame > e.def.emit.start + e.def.emit.duration && !e.particles.length);
    }
    update(dtSeconds, teamColor) {
        const dt = dtSeconds * 60;
        this.time += dt;
        if (this.fadeOut !== null) this.fadeOut += dt;
        for (const e of this.emitters) {
            e.update(dt, this.time, this.rand, teamColor);
            const fadeIn = e.def.fadeIn ? Math.min(this.time / e.def.fadeIn, 1) : 1;
            const fadeOut = this.fadeOut === null ? 1 : Math.max(1 - this.fadeOut / Math.max(e.def.fadeOut, 1), 0);
            e.material.uniforms.emitAlpha.value = fadeIn * fadeOut;
        }
    }
    dispose() {
        this.group.removeFromParent();
        for (const e of this.emitters) e.dispose();
    }
}
