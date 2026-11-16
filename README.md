# dsh-avatar-dafeiyu —— 大肥鱼·形象（独立插件）

把「悬浮形象」从 `dsh-remote-dafeiyu` 里拆出来的独立插件。**素材目录与 schema 仍与本体共用**，所以两边可以各自发版、共用同一份图集。

> 拆分背景与验收口径见本体仓库的 `docs/交接-形象模块拆包-20261116.md`。

---

## 1. 这个包负责什么

| 层 | 文件 | 职责 |
|---|---|---|
| 宿主 | `src/host/routes.ts` | 三条只读路由：`GET /api/dsh-remote-dafeiyu/avatar/{manifest,sheet,state}` |
| 宿主 | `src/host/start.ts` | 把路由挂到宿主 `webServer`（软探测，挂不上不影响其它功能） |
| 宿主 | `src/host/manifest.ts` | 素材读盘（**与本体 `src/platform/avatar-manifest.ts` 同一份契约**） |
| 渲染 | `src/render/playback.ts` | 播片节奏纯逻辑 `ClipPacer`（可单测） |
| 浏览器 | `src/client/widget.ts` | 悬浮形象：状态池、包工头触发、子代理工地鱼集群 |
| 浏览器 | `src/client/panel.ts` | 设置页形象面板（`buildAvatarPanel()`，见 §5） |

**不负责**：手机协议的 `cmd.avatar_manifest` / `cmd.avatar_sheet`（那是本体在读素材，走协议不走 HTTP）。

---

## 2. 安装

```bash
# 装进 profile（和本体并列）
pnpm add file:D:/path/to/dsh-avatar        # 或 npm i
# 然后 profile 的依赖里加一条，重启宿主
```

或直接把 `dist/bundle/index.js`（宿主）+ `dist/bundle/client.cjs`（浏览器）交给 profile 的 bundles。

**升级顺序**：先装这个包并确认形象在，再让本体删掉 `src/avatar/**` 与两个 client 文件——反过来的话中间会出现"两边都没有形象"的窗口。

---

## 3. 素材契约（**改它等于改协议**）

```
<DSH_HOME>/storages/dsh-remote-dafeiyu/avatar/
   manifest.json
   <id>.webp                 # 8×6（或 8×3）网格
```

```jsonc
{
  "version": 53,
  "states": [{
    "id": "idle", "label": "待机",
    "cols": 8, "rows": 6, "frames": 48,
    "cellWidth": 253, "cellHeight": 373,
    "file": "idle.webp",
    "anchorX": 0.4593,     // 0~1，相对**格子**宽度
    "anchorY": 0.9920      // ⚠️ 0 = 格子**顶部**
  }]
}
```

### ⚠️ 两套 `anchorY` 口径，别混

| 出处 | 口径 |
|---|---|
| 形象 `manifest.json` | **y-from-top**（0 = 格子顶） |
| 序列帧工具导出的 `meta.json` | **y-from-bottom**（0 = 格子底） |

搬运/生成素材时**不要顺手统一**——那是破坏性变更。

### 素材规格（当前线上 19 条）

- 本体 13 条：idle / talk / think / nap / tsundere / dance / eat / sneak / angry / sad / greet / shock / bubble
- 包工头 2 条：boss_point（指点）/ boss_whistle（吹哨）
- 工地鱼 4 条：worker_run（8×3=24 帧）/ worker_screw / worker_brick / worker_look

尺寸已按"角色高 ÷ 格子高"统一（本体 0.85 / 工地鱼 0.762），因此**面板与悬浮按格子缩放时应一致**。

---

## 4. 悬浮形象的行为

```
状态来源：GET /avatar/state?sessionId=…  → 'running' | 'idle'
池子：idle / think / talk（候选清单，按 manifest 里实有素材过滤）
       idle  40… + bubble/sad/greet 等
       think 40… + shock/angry/bubble/boss_point/boss_whistle
       talk  38… + greet/angry/shock/boss_point/boss_whistle
包工头：running 的瞬间强制播一次 boss_point/boss_whistle（30s 冷却）
工地鱼：running 时母体周围生成 2 个小工人，跑动 ↔（螺丝/砌砖/张望）交替；idle 全部移除
戳一下：POKE_CLIP=tsundere
```

新加一个动作只要往 `manifest.json` 里加一条、把 id 写进池子（或等池子改成从 manifest 自动派生），**不用改渲染代码**。

---

## 5. 设置面板怎么接

`src/client/panel.ts` 导出 `buildAvatarPanel({ createElement, hooks })`，与本体设置页里那格用法一致。
当前**未自动注册**（设置页那一格仍在本体 `dafeiyu-page.ts` 里）；等本体把设置页做成可插拔，或由本体按需 import 本包的客户端产物再调用。

---

## 6. 开发

```bash
npm install
npm run build     # tsc(宿主+测试) → tsc(客户端类型检查) → esbuild(两个 bundle)
npm test          # 14 项判据：播片节奏 10 项 + 假 DOM 回放 4 项
```

**两条硬约束**（写错的表现都是"看起来装好了、就是不工作"）：
1. `dist/bundle/client.cjs` 必须裹 `window.__ModuleLoader__.load({ id, factory })`，且 `id` **等于包名**；
2. `src/client/main.ts` 的 `export const name` **必须等于包名**（`dsh-client-modules` 按 loader entry 名索引）。

---

## 7. 版本

- `0.1.0` — 从 `dsh-remote-dafeiyu@0.9.0-dafeiyu.83` 拆出；带状态池扩容、包工头触发、工地鱼集群；14 项测试通过。
