/**
 * Shortcuts that work inside a Volis board.
 *
 * This is the single source of truth for the in-board help panel: only
 * gestures actually implemented in BoardView belong here. Obsidian commands
 * (AI panel, board health check, find node, and so on) are deliberately not
 * listed — those are remappable under Settings → Hotkeys and are not a
 * property of the board itself.
 */

export interface ShortcutItem {
  label: string;
  keys: string[];
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

export const BOARD_SHORTCUTS: ShortcutGroup[] = [
  {
    title: "视图",
    items: [
      { label: "移动白板", keys: ["空格 + 拖拽", "中键拖拽"] },
      { label: "水平移动白板", keys: ["Shift + 滚轮"] },
      { label: "缩放", keys: ["滚轮"] },
    ],
  },
  {
    title: "选择",
    items: [
      { label: "加选 / 取消选中", keys: ["Shift + 点击", "Ctrl / Cmd + 点击"] },
      { label: "框选并加选", keys: ["Shift + 拖拽", "Ctrl / Cmd + 拖拽"] },
    ],
  },
  {
    title: "编辑",
    items: [
      { label: "删除节点或连线", keys: ["Delete", "Backspace"] },
      { label: "撤销", keys: ["Ctrl / Cmd + Z"] },
      { label: "重做", keys: ["Ctrl / Cmd + Y", "Ctrl / Cmd + Shift + Z"] },
      { label: "复制选中节点", keys: ["Ctrl / Cmd + C"] },
      { label: "粘贴", keys: ["Ctrl / Cmd + V"] },
      { label: "暂时关闭吸附对齐", keys: ["按住 Alt"] },
    ],
  },
  {
    title: "双击操作",
    items: [
      { label: "空白处新建文本", keys: ["双击空白"] },
      { label: "编辑卡片或打开文件", keys: ["双击节点"] },
      { label: "添加连线标签", keys: ["双击连线"] },
      { label: "修改连线标签", keys: ["双击标签"] },
    ],
  },
];
