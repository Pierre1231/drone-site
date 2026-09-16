import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { classify, STAGES, stageIndexOf } from './data.js?v=20260916';
import { Narrative } from './narrative.js?v=20260916';
import { Interactive } from './interactive.js?v=20260916';

const bootStart = performance.now();

// ---------------------------------------------------------------- 渲染器 / 场景
const canvas = document.getElementById('canvas');
const isMobile = window.innerWidth < 768;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0b);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0.62, 0.5, 0.62);
camera.lookAt(0, 0.1, 0);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;   // Khronos PBR-Neutral：准确保留材质本色
renderer.toneMappingExposure = 1.15;

// 产品级环境光照：程序化摄影棚 IBL，金属/漆面/透明件获得真实反射
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// ---------------------------------------------------------------- 灯光（IBL 为主，灯光只补方向感）
const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(1, 1.5, 0.8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
fillLight.position.set(-1, 0.5, -0.5);
scene.add(fillLight);

// ---------------------------------------------------------------- 地面（阴影承接 + 极淡光晕让整机"落地"）
const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShadowMaterial({ opacity: 0.35 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.001;
ground.receiveShadow = true;
scene.add(ground);

function makeGlowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255, 242, 234, 0.9)');
    grad.addColorStop(0.4, 'rgba(255, 242, 234, 0.25)');
    grad.addColorStop(1, 'rgba(255, 242, 234, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    })
);
glow.rotation.x = -Math.PI / 2;
glow.position.y = -0.0012;
scene.add(glow);

// ---------------------------------------------------------------- 轨道控制器（叙事阶段禁用，交互模式启用）
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0, 0.09, 0);
controls.minDistance = 0.05;
controls.maxDistance = 1.2;
controls.maxPolarAngle = Math.PI * 0.55;
controls.autoRotateSpeed = 1.0;
controls.enabled = false;
canvas.style.touchAction = 'pan-y';   // 叙事阶段保留页面触摸滚动

// ---------------------------------------------------------------- 后期：仅桌面端启用辉光
let composer = null;
if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight), 0.22, 0.55, 0.85
    );
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
}

// ---------------------------------------------------------------- 共享上下文
const ctx = {
    scene, camera, renderer, canvas, controls, isMobile,
    model: null,
    parts: [],
    stageParts: STAGES.map(() => []),
    ui: { explodeProgress: 0, explodeTarget: 0 },
    interactive: null,
};

const narrative = new Narrative(ctx);
const interactive = new Interactive(ctx);
ctx.narrative = narrative;

// ---------------------------------------------------------------- 模型加载（开机屏显示真实进度）
const bootPct = document.getElementById('boot-pct');
const bootBlocks = document.getElementById('boot-blocks');
function bootProgress(pct) {
    bootPct.textContent = pct + '%';
    const filled = Math.round(pct / 100 * 20);
    bootBlocks.textContent = '█'.repeat(filled) + '░'.repeat(20 - filled);
}
bootProgress(0);

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

loader.load('assets/drone.glb', (gltf) => {
    const model = gltf.scene;

    model.traverse((child) => {
        // 多材质零件在 glb 里是一个 Group(WRJ-名, 带 extras) + 多个子 mesh，
        // 子 mesh 名不带 WRJ- 前缀，所以沿父链找到 WRJ- 节点来归组。
        let partNode = child;
        while (partNode && !(partNode.name || '').startsWith('WRJ-')) partNode = partNode.parent;
        if (child.isMesh && partNode) {
            const partName = partNode.userData.part_name || partNode.name.replace('WRJ-', '').replace(/\.\d+$/, '');
            const category = classify(partName);

            child.userData.category = category;
            child.userData.partName = partName;
            child.userData.partNode = partNode;
            child.userData.originalPos = child.position.clone();
            child.userData.explodeDir = new THREE.Vector3().fromArray(partNode.userData.explode_dir || [0, 0, 1]);
            child.userData.explodeDist = partNode.userData.explode_dist || 0.1;
            child.userData.assemble = 0;                       // 0 = 完全散件，1 = 归位
            child.userData.presence = 1;                       // 叙事淡入淡出系数（1 = 完全可见）
            child.userData.stage = stageIndexOf(category);
            child.castShadow = true;
            child.receiveShadow = true;
            // 材质逐零件克隆：叙事推进时按 presence 独立淡出未到装配顺序的零件
            child.userData.originalMat = child.material.clone();
            child.userData.originalMat.transparent = true;
            child.userData.baseOpacity = child.material.opacity;
            child.material = child.userData.originalMat;

            ctx.parts.push(child);
            ctx.stageParts[child.userData.stage].push(child);
        }
    });

    ctx.model = model;
    scene.add(model);

    narrative.onModelLoaded();
    interactive.onModelLoaded();
    applyPartOffsets();   // 开场即完全爆炸状态

    // 开机屏至少停留 900ms，保证启动序列可读
    const wait = Math.max(0, 900 - (performance.now() - bootStart));
    setTimeout(() => {
        document.getElementById('loading').classList.add('hidden');
        document.body.classList.add('loaded');
    }, wait);

    console.log(`Loaded ${ctx.parts.length} parts`);
},
(xhr) => {
    // 注意：压缩传输时 loaded 是按解压后字节计数，可能超过 total，需钳制
    if (xhr.total > 0) bootProgress(Math.min(Math.round(xhr.loaded / xhr.total * 100), 100));
},
(err) => {
    console.error('模型加载失败', err);
    const line = document.createElement('div');
    line.className = 'boot-line';
    line.style.color = '#ff5a1f';
    line.textContent = '> LOAD FAILED — PLEASE RELOAD';
    document.getElementById('boot-lines').appendChild(line);
});

// 装配进度与手动爆炸的统一偏移：offset = dir × dist × 1.5 × (1 − 装配度 + 手动爆炸)
// 同时应用叙事淡入淡出：presence < 1 的零件降不透明度，归零后直接隐藏（也不投影）
function applyPartOffsets() {
    const uiE = ctx.ui.explodeProgress;
    for (const p of ctx.parts) {
        const e = Math.min(uiE + (1 - p.userData.assemble), 1) * 1.5;
        p.position.copy(p.userData.originalPos).addScaledVector(p.userData.explodeDir, p.userData.explodeDist * e);
        const a = p.userData.presence;
        p.visible = a > 0.01;
        if (!p.visible) continue;
        // 点选虚化（dimMat）时不覆盖其不透明度
        if (p.material !== p.userData.dimMat) p.material.opacity = p.userData.baseOpacity * a;
        p.castShadow = a > 0.6;
    }
}

// ---------------------------------------------------------------- 主循环
const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    narrative.update(dt);
    interactive.update(dt);
    if (ctx.model) applyPartOffsets();

    if (composer) composer.render();
    else renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------- 自适应
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
    narrative.onResize();
});

// 调试钩子
window.__viewer = { camera, controls, ctx, narrative, interactive };
