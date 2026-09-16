import * as THREE from 'three';

const clamp01 = v => Math.min(Math.max(v, 0), 1);
const smoothstep = k => k * k * (3 - 2 * k);

// ---------------------------------------------------------------- 滚动装配叙事驱动
// 职责：平滑滚动 → 各阶段零件归位进度、相机关键帧插值、HUD 读数、模式切换
export class Narrative {
    constructor(ctx) {
        this.ctx = ctx;
        this.mode = 'narrative';
        this.scroll = window.scrollY;
        this.poses = null;
        this.metrics = null;
        this.driftTime = 0;
        this.par = { x: 0, y: 0, tx: 0, ty: 0 };
        this.curTarget = new THREE.Vector3(0, 0.09, 0);
        this.lastCount = -1;
        this.hudCounter = document.getElementById('hud-counter');
        this.hudMode = document.getElementById('hud-mode');
        this.rail = document.getElementById('rail');
        this.totalParts = 231;

        this.buildRail();
        this.observeCards();
        window.addEventListener('pointermove', (e) => {
            this.par.tx = (e.clientX / window.innerWidth) * 2 - 1;
            this.par.ty = (e.clientY / window.innerHeight) * 2 - 1;
        }, { passive: true });
        this.measure();
    }

    // ── 右侧章节进度轨 ──
    buildRail() {
        const labels = ['00', '01', '02', '03', '04', '05'];
        this.ticks = labels.map((lb, i) => {
            const el = document.createElement('span');
            el.className = 'tick';
            el.textContent = lb;
            el.onclick = () => {
                const m = this.metrics;
                if (!m) return;
                const y = i === 0 ? 0 : m.stages[i - 1].center - window.innerHeight * 0.5;
                window.scrollTo({ top: y, behavior: 'smooth' });
            };
            this.rail.appendChild(el);
            return el;
        });
    }

    // ── 章节卡片进入视口时上浮显现 ──
    observeCards() {
        const io = new IntersectionObserver((entries) => {
            entries.forEach(en => en.target.classList.toggle('in', en.isIntersecting));
        }, { threshold: 0.35 });
        document.querySelectorAll('.stage-card, .complete-banner').forEach(el => io.observe(el));
    }

    onResize() {
        this.measure();
        if (this.ctx.parts.length) this.computePoses();
    }

    measure() {
        const heroEl = document.getElementById('sec-hero');
        const stageEls = [...document.querySelectorAll('.panel.stage')];
        const interEl = document.getElementById('sec-interactive');
        this.metrics = {
            vh: window.innerHeight,
            hero: { center: heroEl.offsetTop + heroEl.offsetHeight / 2 },
            stages: stageEls.map(el => ({
                top: el.offsetTop,
                height: el.offsetHeight,
                center: el.offsetTop + el.offsetHeight / 2,
            })),
            interactive: { top: interEl.offsetTop, center: interEl.offsetTop + interEl.offsetHeight / 2 },
        };
    }

    onModelLoaded() {
        this.totalParts = this.ctx.parts.length;
        this.computePoses();
    }

    // ── 相机关键帧：hero 全景 + 每阶段对准该组零件包围盒 + 完成机位 ──
    computePoses() {
        const { ctx } = this;
        const desktop = window.innerWidth > 768;
        const v = (x, y, z) => new THREE.Vector3(x, y, z);
        const up = v(0, 1, 0);
        const poses = [{ pos: v(0.62, 0.5, 0.62), target: v(0, 0.1, 0), drift: 1 }];

        // 各阶段观察方向与最小摄距（手工调校）
        const stageCam = [
            { dir: v(0.72, 0.5, 0.68),   min: 0.5 },   // 01 机架骨架：前右上
            { dir: v(1, 0.32, 0.42),     min: 0.45 },  // 02 动力系统：右侧略低
            { dir: v(0.32, 1, 0.42),     min: 0.58 },  // 03 航电核心：俯视核心舱
            { dir: v(0.06, 0.24, 1),     min: 0.36 },  // 04 视觉感知：正面特写
            { dir: v(-0.5, 0.58, -0.72), min: 0.42 },  // 05 能源系统：后上方
        ];

        ctx.stageParts.forEach((parts, i) => {
            const box = new THREE.Box3();
            parts.forEach(p => box.expandByObject(p));
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const R = Math.max(size.x, size.y, size.z);
            const dist0 = Math.min(Math.max(R * 2.2, stageCam[i].min), 0.85);
            const dir = stageCam[i].dir.normalize();
            // 桌面端把注视点移向 cross(dir,up) 一侧（即屏幕左），主体于是落在画面右半
            // 移动端竖屏水平视场窄，统一拉远避免裁切
            let dist = dist0;
            if (desktop) {
                const right = new THREE.Vector3().crossVectors(dir, up).normalize();
                center.addScaledVector(right, dist * 0.34);
            } else {
                dist = dist0 * 1.45;
            }
            const pos = center.clone().addScaledVector(dir, dist);
            poses.push({ pos, target: center, drift: 0.25 });
        });

        // 装配完成机位（移动端拉远，注视点下移让机身落在底部抽屉上方的可见区）
        const home = v(0.5, 0.38, 0.5);
        const homeTarget = v(0, 0.09, 0);
        if (!desktop) {
            home.multiplyScalar(1.35);
            homeTarget.y = -0.08;
        }
        poses.push({ pos: home, target: homeTarget, drift: 0.6 });
        this.poses = poses;
        this.homePose = poses[poses.length - 1];
    }

    // probe（视口中心的文档位置）→ 相邻关键帧插值
    samplePose(probe) {
        const m = this.metrics;
        const centers = [m.hero.center, ...m.stages.map(s => s.center), m.interactive.center];
        const poses = this.poses;
        const out = { pos: new THREE.Vector3(), target: new THREE.Vector3(), drift: 1 };

        if (probe <= centers[0]) {
            out.pos.copy(poses[0].pos); out.target.copy(poses[0].target); out.drift = poses[0].drift;
            return out;
        }
        for (let i = 0; i < centers.length - 1; i++) {
            if (probe <= centers[i + 1] || i === centers.length - 2) {
                const t = smoothstep(clamp01((probe - centers[i]) / (centers[i + 1] - centers[i])));
                out.pos.lerpVectors(poses[i].pos, poses[i + 1].pos, t);
                out.target.lerpVectors(poses[i].target, poses[i + 1].target, t);
                out.drift = THREE.MathUtils.lerp(poses[i].drift, poses[i + 1].drift, t);
                return out;
            }
        }
        return out;
    }

    // ── 各阶段零件归位进度：窗口内 scrub + 组内级联 stagger ──
    updateAssembly(sp) {
        const { ctx } = this;
        if (!ctx.parts.length) return;
        const vh = this.metrics.vh;
        const probe = sp + vh * 0.5;
        const staggerSpan = 0.45;
        let count = 0;

        this.metrics.stages.forEach((s, i) => {
            const raw = clamp01((probe - (s.center - vh * 0.6)) / (vh * 0.85));
            const parts = ctx.stageParts[i];
            const n = parts.length;
            for (let j = 0; j < n; j++) {
                const stagger = n > 1 ? (j / n) * staggerSpan : 0;
                const t = smoothstep(clamp01(raw * (1 + staggerSpan) - stagger));
                parts[j].userData.assemble = t;
                count += t;
            }
        });
        this.assembledCount = count;
    }

    updateHud() {
        if (!this.ctx.parts.length) return;
        const n = Math.round(this.assembledCount || 0);
        if (n !== this.lastCount) {
            this.lastCount = n;
            this.hudCounter.textContent = `${String(n).padStart(3, '0')} / ${this.totalParts}`;
        }
    }

    updateRail(probe) {
        const m = this.metrics;
        const centers = [m.hero.center, ...m.stages.map(s => s.center)];
        let active = 0;
        centers.forEach((c, i) => { if (probe >= c - m.vh * 0.3) active = i; });
        this.ticks.forEach((el, i) => el.classList.toggle('active', i === active));
    }

    setMode(next) {
        if (this.mode === next) return;
        this.mode = next;
        const { ctx } = this;
        const interactiveMode = next === 'interactive';
        document.body.classList.toggle('interactive-mode', interactiveMode);
        ctx.controls.enabled = interactiveMode;

        if (interactiveMode) {
            ctx.controls.target.copy(this.curTarget);
            ctx.canvas.style.touchAction = 'none';
            this.hudMode.textContent = 'INTERACTIVE\u00a0MODE';
            // 交接：从叙事机位平滑拉到整机全景，避免停在阶段特写里
            const home = this.poses ? this.poses[this.poses.length - 1]
                : { pos: new THREE.Vector3(0.5, 0.38, 0.5), target: new THREE.Vector3(0, 0.09, 0) };
            if (ctx.interactive) ctx.interactive.flyTo(home.pos, home.target, 1.1);
        } else {
            ctx.canvas.style.touchAction = 'pan-y';
            this.hudMode.textContent = 'ASSEMBLY\u00a0MODE';
            // 回到叙事：收起手动爆炸与选中态
            ctx.ui.explodeTarget = 0;
            ctx.ui.explodeProgress = 0;
            document.getElementById('btn-explode').textContent = '爆炸视图';
            if (ctx.interactive) {
                ctx.interactive.isExploded = false;
                ctx.interactive.clearSelection();
            }
            document.getElementById('info-panel').classList.add('hidden');
        }
    }

    update(dt) {
        if (!this.metrics) return;
        const { ctx } = this;
        const vh = this.metrics.vh;

        // 平滑滚动（scrub 手感）
        const k = 1 - Math.exp(-dt * 7);
        this.scroll += (window.scrollY - this.scroll) * k;
        const sp = this.scroll;

        // 模式判定（带回差，防止边界附近来回抖动）：
        // 交互区占据视口 75% 切入交互模式，回退到 45% 以下才回到叙事
        const top = this.metrics.interactive.top;
        const wantInteractive = this.mode === 'interactive'
            ? sp > top - vh * 0.45
            : sp > top - vh * 0.25;
        this.setMode(wantInteractive ? 'interactive' : 'narrative');

        this.updateAssembly(sp);
        this.updateHud();

        if (this.mode !== 'narrative' || !this.poses) return;

        // ── 相机：关键帧插值 + 呼吸式环绕摆动（有界，不离机位）+ 鼠标视差 ──
        const probe = sp + vh * 0.5;
        const pose = this.samplePose(probe);

        this.driftTime += dt;
        const sway = Math.sin(this.driftTime * Math.PI * 2 / 20) * 0.16 * pose.drift;
        const cos = Math.cos(sway);
        const sin = Math.sin(sway);
        const rel = pose.pos.clone().sub(pose.target);
        const desired = new THREE.Vector3(
            pose.target.x + rel.x * cos - rel.z * sin,
            pose.pos.y,
            pose.target.z + rel.x * sin + rel.z * cos
        );

        this.par.x += (this.par.tx - this.par.x) * (1 - Math.exp(-dt * 4));
        this.par.y += (this.par.ty - this.par.y) * (1 - Math.exp(-dt * 4));
        const viewDir = pose.target.clone().sub(desired).normalize();
        const right = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0)).normalize();
        const dist = desired.distanceTo(pose.target);
        desired.addScaledVector(right, this.par.x * dist * 0.06);
        desired.y += -this.par.y * dist * 0.04;

        const ck = 1 - Math.exp(-dt * 5);
        ctx.camera.position.lerp(desired, ck);
        this.curTarget.lerp(pose.target, ck);
        ctx.camera.lookAt(this.curTarget);

        this.updateRail(probe);
    }
}
