import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const CATEGORY_MAP = {
  "电机": [
    "01000A-010-001-PN"
  ],
  "桨叶": [
    "6x3 prop"
  ],
  "电调": [
    "电调"
  ],
  "飞控": [
    "px4飞控"
  ],
  "计算平台": [
    "TX2_NX",
    "Nano_and_Xavier_Carrier"
  ],
  "双目相机": [
    "Intel_RealSense_Depth_Camera_D435",
    "摄像头底座",
    "摄像头支架"
  ],
  "电池": [
    "电池",
    "电池仓",
    "电池挡板"
  ],
  "分电板": [
    "分电板"
  ],
  "机架": [
    "机架底座",
    "机架顶板",
    "盖板",
    "01000A-050-001-BH",
    "01000A-050-002-BC",
    "01000A-050-004-SW"
  ],
  "起落架": [
    "起落架",
    "起落架杆"
  ],
  "支柱": [
    "铝柱",
    "六角螺柱",
    "铜柱M3_15",
    "铜柱M3_20",
    "铜柱M3_6",
    "铝柱 30"
  ],
  "紧固件": [
    "hexagon socket button head screws gb_GB_SOCKET_TYPE7 M3X6-C",
    "hexagon socket button head screws gb_GB_SOCKET_TYPE7 M3X10-N",
    "hex nuts, style 1-grades ab gb_GB_FASTENER_NUT_SNAB1 M3-N"
  ],
  "机臂结构件": [
    "01000A-040-001-SC",
    "01000A-040-001-UE",
    "01000A-040-002-LE",
    "01000A-040-003-CR",
    "01000A-040-004-WC",
    "01000A-040-005-MR",
    "01000A-040-006-RW",
    "01000A-040-007-CM"
  ]
};

function classify(partName) {
    for (const [cat, keys] of Object.entries(CATEGORY_MAP)) {
        if (keys.includes(partName)) return cat;
    }
    return '其他';
}

// ---------------------------------------------------------------- 场景
const canvas = document.getElementById('canvas');
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1e);

const camera = new THREE.PerspectiveCamera(50, viewport.clientWidth / viewport.clientHeight, 0.01, 100);
camera.position.set(1.1, 0.9, 1.1);   // 入场机位：模型加载完成后平滑推入

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;   // Khronos PBR-Neutral：准确保留材质本色
renderer.toneMappingExposure = 1.1;

// 产品级环境光照：程序化摄影棚 IBL，金属/漆面/透明件获得真实反射
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 0.09, 0);
// 轨道约束：防止缩飞出场景、钻到地面以下
controls.minDistance = 0.05;
controls.maxDistance = 1.2;
controls.maxPolarAngle = Math.PI * 0.55;
controls.autoRotateSpeed = 1.0;

// 空闲自动旋转：用户一交互即停，15 秒无操作恢复
let lastInteract = -1;
function markInteract() {
    lastInteract = performance.now();
    const hint = document.getElementById('hint');
    if (hint) hint.classList.add('fade');
}
canvas.addEventListener('pointerdown', markInteract);
canvas.addEventListener('wheel', markInteract, { passive: true });

// ---------------------------------------------------------------- 灯光（IBL 为主，灯光只补方向感）
const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(1, 1.5, 0.8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
fillLight.position.set(-1, 0.5, -0.5);
scene.add(fillLight);

// ---------------------------------------------------------------- 地面
const groundGeo = new THREE.PlaneGeometry(2, 2);
const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
ground.receiveShadow = true;
scene.add(ground);

// ---------------------------------------------------------------- 模型
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/gltf/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

let droneParts = [];
let selectedPart = null;
let explodeProgress = 0;
let explodeTarget = 0;
let isExploded = false;
const clock = new THREE.Clock();

// ---------------------------------------------------------------- 相机平滑飞行
let camAnim = null;
function flyTo(toPos, toTarget, duration = 0.9) {
    camAnim = {
        fromPos: camera.position.clone(),
        fromTarget: controls.target.clone(),
        toPos: toPos.clone(),
        toTarget: toTarget.clone(),
        t: 0,
        duration
    };
}
// 用户一拖拽/滚轮就接管相机，取消飞行
canvas.addEventListener('pointerdown', () => { camAnim = null; });
canvas.addEventListener('wheel', () => { camAnim = null; }, { passive: true });

loader.load('assets/drone.glb', (gltf) => {
    const model = gltf.scene;

    // 收集零件
    model.traverse((child) => {
        if (child.isMesh && child.name.startsWith('WRJ-')) {
            const partName = child.userData.part_name || child.name.replace('WRJ-', '').replace(/\.\d+$/, '');
            const category = classify(partName);

            child.userData.category = category;
            child.userData.originalPos = child.position.clone();
            child.userData.explodeDir = new THREE.Vector3().fromArray(child.userData.explode_dir || [0, 0, 1]);
            child.userData.explodeDist = child.userData.explode_dist || 0.1;
            child.castShadow = true;
            child.receiveShadow = true;

            // 保存原始材质
            child.userData.originalMat = child.material;

            droneParts.push(child);
        }
    });

    scene.add(model);

    // 按类别分组统计
    const groups = {};
    droneParts.forEach(p => {
        const cat = p.userData.category;
        groups[cat] = (groups[cat] || 0) + 1;
    });

    // 生成导航面板
    const partList = document.getElementById('part-list');
    Object.entries(groups).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
        const item = document.createElement('div');
        item.className = 'part-item';
        item.innerHTML = `<span class="part-name">${cat}</span><span class="part-count">×${count}</span>`;
        item.onclick = () => selectCategory(cat);
        partList.appendChild(item);
    });

    document.getElementById('loading').classList.add('hidden');
    console.log(`Loaded ${droneParts.length} parts`);

    // 入场动画：从远机位平滑推入；几秒后开始空闲自转
    flyTo(new THREE.Vector3(0.4, 0.35, 0.4), new THREE.Vector3(0, 0.09, 0), 1.8);
    lastInteract = performance.now() - 12000;
},
// 下载进度条
(xhr) => {
    if (xhr.total > 0) {
        const pct = Math.round(xhr.loaded / xhr.total * 100);
        document.getElementById('progress-bar').style.width = pct + '%';
        document.getElementById('loading-text').textContent = `加载 3D 模型中… ${pct}%`;
    }
});

// ---------------------------------------------------------------- 交互
// 聚焦 dim：未选中的零件变半透明，注意力集中在选中件上
function dimOthers(selected) {
    droneParts.forEach(p => {
        if (selected.includes(p)) return;
        if (!p.userData.dimMat) {
            const m = p.userData.originalMat.clone();
            m.transparent = true;
            m.opacity = 0.15;
            m.depthWrite = false;
            p.userData.dimMat = m;
        }
        p.material = p.userData.dimMat;
    });
}

function selectCategory(category) {
    markInteract();
    const parts = droneParts.filter(p => p.userData.category === category);
    if (parts.length === 0) return;

    // 高亮 + 其余 dim
    clearSelection();
    parts.forEach(p => {
        p.material = p.material === p.userData.originalMat ? p.material.clone() : p.material;
        p.material.emissive = new THREE.Color(0x4488ff);
        p.material.emissiveIntensity = 0.3;
    });
    selectedPart = parts;
    dimOthers(parts);

    // 计算包围盒
    const box = new THREE.Box3();
    parts.forEach(p => box.expandByObject(p));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 2.5;

    // 沿当前视线方向平滑飞到零件（保持当前观察角度）
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-8) dir.set(0.5, 0.4, 0.5);
    dir.normalize();
    flyTo(center.clone().add(dir.multiplyScalar(dist)), center);

    // 显示信息
    showInfo(category, parts.length, parts[0].userData.part_name);
}

function selectPart(mesh) {
    markInteract();
    clearSelection();
    mesh.material = mesh.material.clone();
    mesh.material.emissive = new THREE.Color(0x4488ff);
    mesh.material.emissiveIntensity = 0.3;
    selectedPart = [mesh];
    dimOthers([mesh]);

    // 焦点转移到该零件：保持当前视角和距离，把轨道中心平滑移到零件上，
    // 之后的缩放、旋转都绕这个零件进行
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const offset = camera.position.clone().sub(controls.target);
    flyTo(center.clone().add(offset), center, 0.6);

    const category = mesh.userData.category;
    const count = droneParts.filter(p => p.userData.category === category).length;
    showInfo(category, count, mesh.userData.part_name);
}

function clearSelection() {
    droneParts.forEach(p => { p.material = p.userData.originalMat; });
    selectedPart = null;
}

function showInfo(category, count, name) {
    document.getElementById('info-name').textContent = name;
    document.getElementById('info-category').textContent = category;
    document.getElementById('info-count').textContent = `×${count}`;
    document.getElementById('info-panel').classList.remove('hidden');
}

// 点击拾取
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(droneParts, false);

    if (intersects.length > 0) {
        selectPart(intersects[0].object);
    } else {
        clearSelection();
        document.getElementById('info-panel').classList.add('hidden');
    }
});

// 爆炸切换
document.getElementById('btn-explode').onclick = () => {
    markInteract();
    isExploded = !isExploded;
    explodeTarget = isExploded ? 1 : 0;
    document.getElementById('btn-explode').textContent = isExploded ? '🔧 组装视图' : '💥 爆炸视图';
};

// 全屏切换
document.getElementById('btn-fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
};

// 重置视角（平滑飞回）
document.getElementById('btn-reset').onclick = () => {
    markInteract();
    flyTo(new THREE.Vector3(0.4, 0.35, 0.4), new THREE.Vector3(0, 0.09, 0), 1.1);
    clearSelection();
    document.getElementById('info-panel').classList.add('hidden');
};

// ---------------------------------------------------------------- 动画循环
function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    // 爆炸动画
    if (Math.abs(explodeProgress - explodeTarget) > 0.001) {
        explodeProgress = THREE.MathUtils.lerp(explodeProgress, explodeTarget, dt * 5);
        droneParts.forEach(p => {
            const offset = p.userData.explodeDir.clone().multiplyScalar(p.userData.explodeDist * explodeProgress * 1.5);
            p.position.copy(p.userData.originalPos).add(offset);
        });
    }

    // 相机飞行动画（easeInOutCubic 缓动，先加速后减速）
    if (camAnim) {
        camAnim.t += dt;
        const k = Math.min(camAnim.t / camAnim.duration, 1);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
        controls.target.lerpVectors(camAnim.fromTarget, camAnim.toTarget, e);
        if (k >= 1) camAnim = null;
    }

    // 空闲 15 秒且不在飞行动画中时缓慢自转
    controls.autoRotate = !camAnim && lastInteract >= 0 &&
        (performance.now() - lastInteract > 15000);

    controls.update();
    renderer.render(scene, camera);
}

// 自适应
window.addEventListener('resize', () => {
    camera.aspect = viewport.clientWidth / viewport.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

// 调试钩子：控制台里可用 __viewer.camera / __viewer.controls 检查视角
window.__viewer = { camera, controls, selectPart, get parts() { return droneParts; } };

animate();
