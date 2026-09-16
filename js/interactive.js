import * as THREE from 'three';

// ---------------------------------------------------------------- 交互模式
// 职责：零件点选 / 侧边栏分类导航 / 手动爆炸 / 相机飞行 / 空闲自转
// 仅在 body.interactive-mode（OrbitControls 启用）时接管相机
export class Interactive {
    constructor(ctx) {
        this.ctx = ctx;
        ctx.interactive = this;

        this.selectedPart = null;
        this.selectedCategory = null;
        this.navItems = {};
        this.camAnim = null;
        this.lastInteract = -1;
        this.enteredAt = 0;      // 最近一次切入交互模式的时刻（滚轮惯性防护用）
        this.wasEnabled = false;
        this.isExploded = false;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.bind();
    }

    bind() {
        const { ctx } = this;

        ctx.canvas.addEventListener('pointerdown', () => {
            this.camAnim = null;   // 用户接管相机
            this.markInteract();
        });
        ctx.canvas.addEventListener('wheel', () => {
            this.camAnim = null;
            this.markInteract();
        }, { passive: true });

        // 滚轮接管（仅交互模式）：方向对调成"下滚推近 / 上滚拉远"，与页面滚动的
        // 空间直觉一致；拉远到最大摄距后继续上滚则放行给页面滚回叙事区（吸附顺到 STAGE 05）。
        // 必须挂在 window 捕获阶段——OrbitControls 的 wheel 监听先注册在 canvas 上，
        // 同在 canvas 冒泡阶段抢不过它。拦截后重派发一个反转 deltaY 的合成事件给
        // OrbitControls（用自定义标记防递归），保留其阻尼手感。
        window.addEventListener('wheel', (e) => {
            if (!ctx.controls.enabled || e.target !== ctx.canvas || e.__zoomRouted) return;
            if (e.ctrlKey || e.deltaY === 0) return;   // 触控板捏合缩放保持原生方向
            if (performance.now() - this.enteredAt < 400) { // 进交互瞬间的滚动惯性不推近镜头
                e.stopImmediatePropagation();
                e.preventDefault();
                return;
            }
            if (e.deltaY < 0) {
                const d = ctx.camera.position.distanceTo(ctx.controls.target);
                if (d >= ctx.controls.maxDistance - 0.01) {
                    e.stopImmediatePropagation();   // 逃逸：只拦 OrbitControls，不 preventDefault → 页面滚回上方
                    return;
                }
            }
            e.stopImmediatePropagation();
            e.preventDefault();
            const routed = new WheelEvent('wheel', {
                deltaY: -e.deltaY, clientX: e.clientX, clientY: e.clientY,
                bubbles: true, cancelable: true,
            });
            routed.__zoomRouted = true;
            ctx.canvas.dispatchEvent(routed);
        }, { capture: true, passive: false });
        ctx.canvas.addEventListener('click', (e) => this.onClick(e));

        document.getElementById('btn-explode').onclick = () => {
            this.markInteract();
            this.isExploded = !this.isExploded;
            ctx.ui.explodeTarget = this.isExploded ? 1 : 0;
            document.getElementById('btn-explode').textContent = this.isExploded ? '组装视图' : '爆炸视图';
        };

        document.getElementById('btn-reset').onclick = () => {
            this.markInteract();
            const home = this.ctx.narrative?.homePose
                || { pos: new THREE.Vector3(0.5, 0.38, 0.5), target: new THREE.Vector3(0, 0.09, 0) };
            this.flyTo(home.pos, home.target, 1.1);
            this.clearSelection();
            document.getElementById('info-panel').classList.add('hidden');
        };

        document.getElementById('btn-fullscreen').onclick = () => {
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen();
        };
    }

    onModelLoaded() {
        // 按类别分组统计，生成侧边栏导航
        // 计数按顶层零件节点去重（多材质零件会拆成多个子 mesh）
        const groups = {};
        const seen = new Set();
        this.ctx.parts.forEach(p => {
            const key = p.userData.partNode || p;
            if (seen.has(key)) return;
            seen.add(key);
            const cat = p.userData.category;
            groups[cat] = (groups[cat] || 0) + 1;
        });

        const partList = document.getElementById('part-list');
        Object.entries(groups).sort((a, b) => b[1] - a[1]).forEach(([cat, count]) => {
            const item = document.createElement('div');
            item.className = 'part-item';
            item.innerHTML = `<span class="part-name">${cat}</span><span class="part-count">×${count}</span>`;
            item.onclick = () => this.selectCategory(cat);
            partList.appendChild(item);
            this.navItems[cat] = item;
        });

        this.lastInteract = performance.now() - 12000;
    }

    markInteract() {
        this.lastInteract = performance.now();
        const hint = document.getElementById('hint');
        if (hint) hint.classList.add('fade');
    }

    // ---------------------------------------------------------------- 相机平滑飞行（easeInOutCubic）
    flyTo(toPos, toTarget, duration = 0.9) {
        this.camAnim = {
            fromPos: this.ctx.camera.position.clone(),
            fromTarget: this.ctx.controls.target.clone(),
            toPos: toPos.clone(),
            toTarget: toTarget.clone(),
            t: 0,
            duration
        };
    }

    // ---------------------------------------------------------------- 选中逻辑
    // 聚焦虚化：选中件保持原色，未选中的零件整体变淡退到背景
    dimOthers(selected) {
        this.ctx.parts.forEach(p => {
            if (selected.includes(p)) return;
            if (!p.userData.dimMat) {
                const m = p.userData.originalMat.clone();
                m.transparent = true;
                m.opacity = 0.16;
                m.depthWrite = false;
                p.userData.dimMat = m;
            }
            p.material = p.userData.dimMat;
        });
    }

    setActiveNav(cat) {
        Object.entries(this.navItems).forEach(([c, el]) => el.classList.toggle('active', c === cat));
    }

    selectCategory(category) {
        this.markInteract();
        // 再点一次当前分类 = 取消选中
        if (this.selectedCategory === category) {
            this.clearSelection();
            document.getElementById('info-panel').classList.add('hidden');
            return;
        }
        this.selectedCategory = category;
        const parts = this.ctx.parts.filter(p => p.userData.category === category);
        if (parts.length === 0) return;

        this.clearSelection();
        this.selectedCategory = category;
        this.setActiveNav(category);
        this.selectedPart = parts;
        this.dimOthers(parts);

        // 计算包围盒，沿当前视线方向平滑飞到零件组
        const box = new THREE.Box3();
        parts.forEach(p => box.expandByObject(p));
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const dist = maxDim * 2.5;

        const dir = this.ctx.camera.position.clone().sub(this.ctx.controls.target);
        if (dir.lengthSq() < 1e-8) dir.set(0.5, 0.4, 0.5);
        dir.normalize();
        this.flyTo(center.clone().add(dir.multiplyScalar(dist)), center);

        this.showInfo(category, new Set(parts.map(p => p.userData.partNode || p)).size, parts[0].userData.partName);
    }

    selectPart(mesh) {
        this.markInteract();
        this.clearSelection();
        this.selectedPart = [mesh];
        this.dimOthers([mesh]);

        // 侧边栏同步高亮该零件所属分类
        this.selectedCategory = mesh.userData.category;
        this.setActiveNav(this.selectedCategory);

        // 焦点转移到该零件：保持视角距离，把轨道中心平滑移过去
        const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        const offset = this.ctx.camera.position.clone().sub(this.ctx.controls.target);
        this.flyTo(center.clone().add(offset), center, 0.6);

        const category = mesh.userData.category;
        const count = new Set(this.ctx.parts.filter(p => p.userData.category === category).map(p => p.userData.partNode || p)).size;
        this.showInfo(category, count, mesh.userData.partName);
    }

    clearSelection() {
        this.ctx.parts.forEach(p => { p.material = p.userData.originalMat; });
        this.selectedPart = null;
        this.selectedCategory = null;
        this.setActiveNav(null);
    }

    showInfo(category, count, name) {
        document.getElementById('info-name').textContent = name;
        document.getElementById('info-category').textContent = category;
        document.getElementById('info-count').textContent = `×${count}`;
        document.getElementById('info-panel').classList.remove('hidden');
    }

    onClick(event) {
        if (!this.ctx.controls.enabled) return;   // 叙事阶段不响应拾取

        const rect = this.ctx.canvas.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.ctx.camera);
        const intersects = this.raycaster.intersectObjects(this.ctx.parts, false);

        if (intersects.length > 0) {
            this.selectPart(intersects[0].object);
        } else {
            this.clearSelection();
            document.getElementById('info-panel').classList.add('hidden');
        }
    }

    // ---------------------------------------------------------------- 帧更新
    update(dt) {
        const { ctx } = this;

        // 记录切入交互模式的瞬间（用于抑制滚动惯性误触缩放）
        if (ctx.controls.enabled && !this.wasEnabled) this.enteredAt = performance.now();
        this.wasEnabled = ctx.controls.enabled;

        // 手动爆炸动画（仅交互模式有值）
        if (Math.abs(ctx.ui.explodeProgress - ctx.ui.explodeTarget) > 0.001) {
            ctx.ui.explodeProgress = THREE.MathUtils.lerp(ctx.ui.explodeProgress, ctx.ui.explodeTarget, dt * 5);
        } else {
            ctx.ui.explodeProgress = ctx.ui.explodeTarget;
        }

        if (!ctx.controls.enabled) return;

        // 相机飞行动画
        if (this.camAnim) {
            this.camAnim.t += dt;
            const k = Math.min(this.camAnim.t / this.camAnim.duration, 1);
            const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
            ctx.camera.position.lerpVectors(this.camAnim.fromPos, this.camAnim.toPos, e);
            ctx.controls.target.lerpVectors(this.camAnim.fromTarget, this.camAnim.toTarget, e);
            if (k >= 1) this.camAnim = null;
        }

        // 空闲 15 秒且不在飞行动画中时缓慢自转
        ctx.controls.autoRotate = !this.camAnim && this.lastInteract >= 0 &&
            (performance.now() - this.lastInteract > 15000);

        ctx.controls.update();
    }
}
