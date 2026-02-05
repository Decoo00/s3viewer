import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * TODO
 * _Trm.png : 트림 텍스처 (현재 무시됨)
 * 언어추가?
 */


const models = [
    { name: '모델 1', file: 'Wmn_Slosher_Washtub_Cstm01.fbx' }, // 실제 파일명으로 바꾸세요
    { name: '모델 2', file: 'Wmn_Charger_Quick.fbx' },
    { name: '모델 3', file: 'Wmn_Blaster_Precision_Cstm03.fbx' }
];

let currentModel = null; // 현재 씬에 있는 모델을 담을 변수



// 1. 기본 설정 (씬, 카메라, 렌더러)
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa0a0a0); // 배경색 설정

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(-1, 1, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// 2. 조명 추가 (모델이 잘 보이게 하기 위함)
const hemiLight = new THREE.HemisphereLight(0xffffff, 0xbbbbbb, 2);
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
scene.add(dirLight);

const dirLight2 = new THREE.DirectionalLight(0xffffff, 4);
dirLight2.position.set(-1, 2, 1);
scene.add(dirLight2);

const bottomLight = new THREE.DirectionalLight(0xffffff, 0.8);
bottomLight.position.set(1, -2, -1); // 아래에서 위로
scene.add(bottomLight);

const bottomLight2 = new THREE.DirectionalLight(0xffffff, 0.8);
bottomLight2.position.set(-1, -2, -1); // 아래에서 위로
scene.add(bottomLight2);

const ambientLight = new THREE.AmbientLight(0xffffff, 1); // 전체적인 밝기
scene.add(ambientLight);


const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
scene.environment = pmremGenerator.fromScene(new THREE.Scene()).texture;



// 3. 360도 회전 컨트롤러 (OrbitControls)
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 부드러운 회전 감도

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
floor.position.y = -0.9;

// 4. 그림자를 받고 싶다면 (renderer 설정에 shadowMap.enabled = true 필요)
floor.receiveShadow = true;

scene.add(floor);


const teamColor = new THREE.Color(0xFF2553);

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

// 2. 모델을 화면에 띄우는 함수
function loadModel(fileName) {
    // 기존 모델이 있다면 삭제
    if (currentModel) {
        scene.remove(currentModel);
    }
    const textureLoader = new THREE.TextureLoader();
    const loader = new FBXLoader();

    loader.load(`models/${fileName}`, (object) => {
        currentModel = object;
        

        const folderPath = fileName.substring(0, fileName.lastIndexOf('/') + 1);
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
                    console.log("씨빨ㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹㄹ");
                    //albFileName = "M_Body_Alb";
                    if (child.name.includes('Body')){
                        albFileName = "M_Body_Alb";
                    }
                    if (child.name.includes('Bottle')){
                        isBottle = true;
                        if (fileName.includes('Expert')){   // 프라임 슈터
                            albFileName = "M_Body_Alb";
                        }
                        else{
                            albFileName = "M_Bottle_Alb";
                        }
                    }
                    if (child.name.includes('Logo')){
                        albFileName = "M_Logo_Alb";
                    }

                    if (child.name.includes("Cstm01")){
                        albFileName = albFileName.replace("Alb","Cstm01_Alb");
                    }
                    // if (child.name.includes('Bottle')){
                    //     albFileName = "M_Bottle_Alb";
                    // }
                    // if (child.name.includes('_M_')) {
                    //     const name = child.name.split('_M_')[1];
                    //     if (name.includes('Logo')) {
                    //         albFileName = "M_"+child.name.split('_M_')[1] + "_Alb";
                    //     }
                    // }
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
                            console.log("TLQKFSDFKJDSLOFSDLKFH");
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
                            child.material.roughness = 0.9;
                            child.material.needsUpdate = true;
                        }
                    }, undefined, () => {console.log("Roughness Map 없음");});

                    // --- AO Map 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${aoName}`).then((aoTex) => {
                        if (aoTex) {
                            newMat.aoMap = aoTex;
                            newMat.aoMapIntensity = 0.2;
                        }
                    }, undefined, () => {console.log("AO Map 없음");});

                    // --- Metalness 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${mtlName}`).then((mtlTex) => {
                        if (mtlTex) {
                            newMat.metalnessMap = mtlTex;
                            newMat.metalness = 0.5;
                            newMat.needsUpdate = true;
                        }
                    }, undefined, () => {console.log("Metalness Map 없음");});


                    // --- Normal Map 로드 시도 ---
                    safeLoad(textureLoader, `models/${folderPath}${nrmName}`).then((nrmTex) => {
                        if (nrmTex) {
                            newMat.normalMap = nrmTex;
                            newMat.normalScale.set(1.5, 1.5);
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

        // 모델 크기 및 위치 자동 조정 (Bounding Box 활용)
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        object.position.sub(center); // 모델을 중앙으로 이동
        

        // 3. 모델 크기에 맞춰 카메라 위치 자동 설정
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = camera.fov * (Math.PI / 180);
        // 모델이 화면에 꽉 차도록 적절한 거리 계산
        let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
        
        camera.position.set(-2*cameraZ, cameraZ/2, cameraZ/2);
        
        // 4. 카메라가 모델 중앙을 바라보게 하고 조작 제한 설정
        camera.lookAt(center);
        controls.target.set(0, 0, 0);
        controls.update();
        scene.add(object);
    }, (xhr) => {
        console.log((xhr.loaded / xhr.total * 100) + '% 로딩 중');
    }, (error) => {
        console.error('에러 발생:', error);
    }); 
}

// 3. UI 리스트 동적 생성
// const listElement = document.getElementById('model-list');
// models.forEach(model => {
//     const li = document.createElement('li');
//     li.textContent = model.name;
//     li.onclick = () => loadModel(model.file); // 클릭 시 해당 모델 로드
//     listElement.appendChild(li);
// });

// // 초기 모델 로드 (첫 번째 모델)
// loadModel(models[0].file);

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
function animate() {
    requestAnimationFrame(animate);
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
    { id: 'Shooter', name: '슈터', img: 'wpntypes/IconTypeWpn_00.png',
        items: [  
                {name: '프로모델러 MG', file: 'Blaze'},
                {name: '프로모델러 RG', file: 'Blaze_Cstm01'},
                {name: '프라임 슈터', file: 'Expert'},
                {name: '프라임 슈터 컬래버', file: 'Expert_Cstm01'},
                {name: '새싹 슈터', file: 'First_Cstm01'},
                {name: '단풍 슈터', file: 'First'},
                {name: '보틀 가이저', file: 'Flash'},
                {name: '포일 보틀 가이저', file: 'Flash_Cstm01'},
                {name: '.52 갤런', file: 'Gravity'},
                {name: '.52 갤런 데코', file: 'Gravity_Cstm01'},
                {name: '.96 갤런', file: 'Heavy'},
                {name: '.96 갤런 데코', file: 'Heavy_Cstm01'},
                {name: '제트 스위퍼', file: 'Long'},
                {name: '커스텀 제트 스위퍼', file: 'Long_Cstm01'},
                {name: '스플랫 슈터', file: 'NormalT'},
                {name: '스플랫 슈터 컬래버', file: 'NormalT_Cstm01'},
                {name: '옥타 슈터 레플리카', file: 'RvSdodr'},
                {name: '오더 슈터 레플리카', file: 'NormalSdodr'},
                {name: '스페이스 슈터', file: 'QuickLong'},
                {name: '스페이스 슈터 컬래버', file: 'QuickLong_Cstm01'},
                {name: 'N-ZAP85', file: 'QuickMiddle'},
                {name: 'N-ZAP89', file: 'QuickMiddle_Cstm01'},
                {name: '볼드 마커', file: 'Short'},
                {name: '볼드 마커 네오', file: 'Short_Cstm01'},
                {name: '샤프 마커 네오', file: 'Short_Cstm11'},
                {name: 'L3 릴 건', file: 'Triple'},
                {name: 'L3 릴 건 D', file: 'Triple_Cstm01'},
                {name: 'H3 릴 건', file: 'TripleMiddle'},
                {name: 'H3 릴 건 D', file: 'TripleMiddle_Cstm01'},
        ]
     },
    { id: 'Blaster', name: '블래스터', img: 'wpntypes/IconTypeWpn_01.png' },
    { id: 'Maneuver', name: '머뉴버', img: 'wpntypes/IconTypeWpn_02.png' },
    { id: 'Spinner', name: '스피너', img: 'wpntypes/IconTypeWpn_03.png' },
    { id: 'Charger', name: '차저', img: 'wpntypes/IconTypeWpn_04.png' },
    { id: 'Roller', name: '롤러', img: 'wpntypes/IconTypeWpn_05.png' },
    { id: 'Brush', name: '붓', img: 'wpntypes/IconTypeWpn_06.png' },
    { id: 'Slosher', name: '슬로셔', img: 'wpntypes/IconTypeWpn_07.png' },
    { id: 'Shelter', name: '우산', img: 'wpntypes/IconTypeWpn_08.png' },
    { id: 'Stringer', name: '활', img: 'wpntypes/IconTypeWpn_09.png' },
    { id: 'Saber', name: '와이퍼', img: 'wpntypes/IconTypeWpn_10.png' }
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
            
            li.onclick = () => loadModel(`Wmn_${cat.id}_${item.file}/Wmn_${cat.id}_${item.file}.fbx`); // 기존의 loadModel 함수 호출
            modelList.appendChild(li);
        });
    };
    categoryBar.appendChild(btn);
});