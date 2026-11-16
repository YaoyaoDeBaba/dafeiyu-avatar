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

### 2.1 装进 DSH profile（推荐：跟本体一样走 git 依赖）

profile 目录形如 `<DSH_HOME>/profiles/desktop/`（`<DSH_HOME>` 默认 `~/.dsh`，Windows 是 `C:\Users\<你>\.dsh`）。

**① 在 profile 的 `package.json` 里加依赖**

```jsonc
{
  "dependencies": {
    "dsh-remote-dafeiyu": "git+https://github.com/YaoyaoDeBaba/dsh-remote-dafeiyu.git#<sha>",  // 本体，照旧
    "dsh-avatar-dafeiyu": "git+https://github.com/YaoyaoDeBaba/dafeiyu-avatar.git#5a2b08f"       // ← 新增
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-persona-dafeiyu",
        "dsh-capability-panel",
        "dsh-remote-dafeiyu",        // 本体：拆包完成前保留；完成后删
        "dsh-avatar-dafeiyu",        // ← 新增（**必须在这里出现，只写 dependencies 不会加载**）
        "@deepseek-ai/dsh-experimental-plugin-market-bundle",
        "dsh-selfloop"
      ]
    }
  }
}
```

> 两条都要：`dependencies` 决定"装不装得上"，`dsh.profile.bundles` 决定"加不加载"。只加前者 = 文件在、插件不出现。

**② 安装并重启**

```bash
cd <DSH_HOME>/profiles/desktop
pnpm install                     # 或 npm i
# 重启 DSH（插件包在宿主启动时加载，热重载不覆盖 bundles 变更）
```

**③ 本地开发时用 file: 依赖**

```bash
# 改完本仓库后，直接让 profile 指向工作副本
pnpm add file:D:/dafeiyu-market/dsh-avatar
```

### 2.2 不装 npm 包、直接放产物

把 `dist/bundle/`（`index.js` + `client.cjs`）+ `cordis.patch.yml` + `package.json` 拷到 profile 的 `node_modules/dsh-avatar-dafeiyu/` 下，也要在 `dsh.profile.bundles` 里加包名。适合临时验证。

### 2.3 装完的验收清单（**逐条打勾再交给下游**）

- [ ] 聊天页左下角**形象在**，且能连续播满一套动作再循环（不是播一帧就跳）；
- [ ] `GET /api/dsh-remote-dafeiyu/avatar/manifest` 返回 `{ ok:true, manifest:{ version:53, states:[19 条] } }`；
- [ ] 素材没装时，同一路由返回 `manifest:null` 而不是 500；
- [ ] `plugin_manager` 里 `include:avatar-dafeiyu` 的 **`fiberPhase` 是 `active`**（这条比"看起来能用"硬）；
- [ ] 我干活（agent `running`）时形象切到 `boss_point` / `boss_whistle`；
- [ ] 同时在母体周围出现 2 个工地鱼，跑动 ↔（打螺丝/砌砖/张望）交替；停手后消失；
- [ ] 刷新页面后形象仍在（客户端 bundle 若被宿主缓存，需重启一次）。

### 2.4 升级顺序（**别反**）

1. 先装形象包、按 §2.3 验收通过；
2. 再让本体删 `src/avatar/**` 与 `src/client/avatar-widget.ts`、`src/client/avatar-panel.ts`；
3. 本体删完再发一版。

反过来的话，中间那段时间会出现"**两边都没有形象**"的窗口（本体删了、形象包还没装上）。


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

### 4.1 工地鱼的三个空间行为（0.2.0）

| 行为 | 规则 | 实现 |
|---|---|---|
| **前后层** | 比"脚底线的屏幕 y"：工人更靠下 ⇒ 在母体前面（`z-index 2147483000`），否则在后面（`2147482997`） | `render/layout.ts#depthFor` |
| **按方向翻转** | 往左走镜像（`scaleX(-1)`），往右朝右；**位移 <1px 不改朝向**（防抖）；停下干活保持朝向 | `facingFor` + `workerLeft` |
| **跟随母体** | 母体被拖动/换位时，所有工人按**同一 delta** 平移，用 0.3s 短过渡追上去 | `widget.ts` 每 8 拍（≈0.33s）对比一次 rect |

翻转易错点：镜像后格子内锚点从 `anchorX` 变成 `1-anchorX`，`left` 必须按
`targetX - (1-anchorX)*w` 算，否则往左走会横向跳 `(1-2*anchorX)*w` 像素。这条有单测（`tests/layout.test.ts`）。

### 4.2 运行时开关

控制台改一下即可（下次 spawn/移动时生效，无需重载）：

```js
window.__dafeiyuAvatarConfig = {
  workers: { enabled: true, count: 2, flip: true, depth: true, follow: true },
}
```

`count` 取值 1~4；`enabled:false` 直接不出工地鱼。

---

## 5. 设置页「形象」房间（大肥鱼 .84 房间注册制）

宿主（`dsh-remote-dafeiyu` ≥ .84）把设置页改成**房间管理器**：谁注册谁有 tab，宿主负责建房、切换、收房。
本包用 `id: 'avatar'` 领一间房，内容自己渲染（**纯 DOM，不依赖 React**，见 `src/client/room.ts`）。

```ts
// 宿主最前面同步建注册表并派发 dafeiyu:rooms-ready
const host = await waitForRooms(1500)     // 拿不到 = 宿主版本旧 → 静默放弃，不报错
host?.register({
  id: 'avatar',
  label: '形象',
  order: 10,
  mount(container) {
    // 建 UI + 起 24fps 播放器；返回的清理函数必须干净
    return () => {
      clearInterval(timer)
      container.replaceChildren()
    }
  },
})
```

**旧方案已废弃**：不再需要 `dafeiyu-avatar-slot` 容器，也不再有 `data-filled` 标记。
`src/client/panel.ts` 是原来的 React 版面板，保留作参考；房间用的是 `room.ts`。

### 清理怎么自证

`mount` 里会维护一个计数器，宿主/验收可以直接读：

```js
window.__dafeiyuAvatarRoomStats   // { mounted, disposed, timerAlive }
```

切走 tab 后应满足：`disposed` 增加、`timerAlive === false`。

### 房间相关的验收（在 §2.3 之上加）

- [ ] **装了**：设置页有「形象」tab，内容是本包渲染的；能播；切走再切回**不叠两份、不卡**；
- [ ] **没装**：设置页**没有**「形象」tab（宿主只为已注册的房间建 tab）；
- [ ] **mount 抛错**：页面显示「这个模块起不来：形象（…）」，其它 tab 正常；
- [ ] **切走 tab 后**：`window.__dafeiyuAvatarRoomStats.timerAlive === false` 且 `disposed` +1。

---

## 6. 开发

```bash
npm install
npm run build     # tsc(宿主+测试) → tsc(客户端类型检查) → esbuild(两个 bundle)
npm test          # 14 项判据：播片节奏 10 项 + 假 DOM 回放 4 项
```

### ⚠️ `dist/bundle/` 必须提交进仓库

市场 / `git+` 安装**不会跑构建**，而 `package.json` 的 `main` 与 `exports['./client']` 都指向 `dist/bundle/`。
`.gitignore` 里是 `/dist/*` + `!/dist/bundle/`（**只放行 bundle**），改完代码要：

```bash
npm run build
git add -f dist/bundle
git commit -m "build: 入库 dist/bundle（装机不构建，产物必须提交）"
git push
```

漏提交的表现是"装上去插件不加载"，且不报错——本仓库踩过一次。

### 交付前跑两条检查

```bash
npm run check          # = check:dist + check:assets
npm run check:dist     # 产物与源码是否同步（CI 同款）
npm run check:assets   # 素材体检（对着真实 avatar 目录）
```

`check:assets` 校验（目录取 `$DSH_AVATAR_DIR` → `<DSH_HOME>/storages/dsh-remote-dafeiyu/avatar`，
也可以用参数指定 `node .check-assets.mjs D:/some/avatar`）：

| 检查 | 为什么 |
|---|---|
| `manifest` 可读、`states` 非空、id 不重复 | 空表 = 端上一直等素材 |
| `file` 不带路径、文件存在、非空 | 路由会 404 |
| 图集真实宽高 == `cols×cellWidth` × `rows×cellHeight` | 不符 ⇒ 切帧错位、动作串帧 |
| `frames == cols×rows`（不符只告警） | 会播到空帧 |
| `anchorX/anchorY` 在 0~1 | 越界端上会画出格 |
| **`anchorY` 口径哨兵**：过半条目 `< 0.5` ⇒ 报错 | 多半是把序列帧 meta 的 y-from-bottom 粘过来了 |

目录不存在时**打印"素材未安装，跳过"并 exit 0**——CI 上没有素材，不该红。

**两条硬约束**（写错的表现都是"看起来装好了、就是不工作"）：
1. `dist/bundle/client.cjs` 必须裹 `window.__ModuleLoader__.load({ id, factory })`，且 `id` **等于包名**；
2. `src/client/main.ts` 的 `export const name` **必须等于包名**（`dsh-client-modules` 按 loader entry 名索引）。

---

## 7. 版本

- `0.2.0` — 工地鱼空间行为：前后层（按脚底线 y）、按移动方向翻转（含锚点补偿）、跟随母体位移；
  可运行时开关（`window.__dafeiyuAvatarConfig`）；新增 `tests/layout.test.ts`（18 项测试）。
- `0.1.0` — 从 `dsh-remote-dafeiyu@0.9.0-dafeiyu.83` 拆出；带状态池扩容、包工头触发、工地鱼集群；14 项测试通过。
