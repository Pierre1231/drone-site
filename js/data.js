// 零件分类表（与 GLB 中 part_name 对应）
export const CATEGORY_MAP = {
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

export function classify(partName) {
    for (const [cat, keys] of Object.entries(CATEGORY_MAP)) {
        if (keys.includes(partName)) return cat;
    }
    return '其他';
}

// 装配序列：14 个分类 → 5 个阶段
export const STAGES = [
  { id: 'airframe',   cats: ['机架', '机臂结构件', '支柱', '紧固件', '起落架', '其他'] },
  { id: 'propulsion', cats: ['电机', '电调', '分电板', '桨叶'] },
  { id: 'avionics',   cats: ['飞控', '计算平台'] },
  { id: 'perception', cats: ['双目相机'] },
  { id: 'power',      cats: ['电池'] },
];

export function stageIndexOf(category) {
    const i = STAGES.findIndex(s => s.cats.includes(category));
    return i >= 0 ? i : 0;
}
