# Volis

让画布认识"卡片"的插件。

Obsidian 的画布只认文件，而卡片笔记通常是笔记里的一个块（列表项 + 行末 `^id`）。拖进画布时，它只是一段带嵌入语法的文本——能显示，但节点不知道自己是谁。

Volis 补的就是这层身份：**解析块引用 → 定位卡片 → 就地编辑 → 保持同步**。卡片仍然住在笔记里，不产生任何新文件。

## 当前版本（0.1.0）

- 识别画布上的卡片节点（`![[文件#^块ID]]`）
- 右下角角标显示卡片日期，悬停变实
- 右键面板：编辑卡片 / 在笔记中定位 / 复制块链接 / 刷新 / 移除失效节点
- 双击卡片节点，浮层编辑，写回源笔记
- 笔记改动后主动刷新画布节点（原生嵌入在内容变短时会留残影，这里绕过它）
- 所有功能同时注册为命令，菜单失效时仍可用

## 不做什么

- 不创建卡片文件
- 不修改卡片的存储格式
- 不写自定义字段到画布，画布保持标准 JSON Canvas
- 不接管非卡片节点（笔记、PDF、图片、视频、网页、自由文本一律交给原生）

## 安装

把 `main.js`、`manifest.json`、`styles.css` 放进库的 `.obsidian/plugins/volis/`，在设置里启用。

## 开发

```
npm install
npm run build     # 类型检查 + 打包
npm run dev       # 监听模式
```

构建产物为根目录下的 `main.js`。

## 目录

```
src/
  main.ts                 插件入口、命令、事件
  settings.ts             设置模型与默认值
  settingsTab.ts          设置界面
  types.ts                共享类型
  parse/
    cardRef.ts            块引用解析
    blockLocator.ts       块定位与重建
  store/
    cardStore.ts          卡片读取/写入（不依赖其他插件）
  canvas/
    nodeIndex.ts          节点 → 卡片 映射缓存
    badge.ts              角标渲染
    syncEngine.ts         文件变更后的画布刷新
    actions.ts            动作注册表
    contextMenu.ts        右键面板注入
  ui/
    cardEditor.ts         浮层编辑器
  ai/
    provider.ts           AI 接口（当前仅占位）
```

## 设计约束

1. 卡片不变成文件。
2. 画布保持标准格式，卸载插件后仍可正常打开。
3. 身份只从链接解析，不额外存储。
4. 依赖 Canvas 内部 API 的部分全部包在 try/catch 里，失败只会降级，不会崩。
