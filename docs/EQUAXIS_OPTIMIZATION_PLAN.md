# Equaxis 后续优化建议

基于当前仓库状态、pi-web 集成和记忆系统实现，下面这份清单按优先级整理后续最值得继续做的优化点。

## 当前基线

已经完成的部分：

- `bridge/memory_bridge.py` 已支持记忆快照导出。
- `pi-web/app/api/memory/route.ts` 已提供只读记忆 API。
- `pi-web/components/MemoryDashboard.tsx` 已提供可视化面板。
- `pi-web/components/AppShell.tsx` 已把入口挂到顶部工具栏。
- `.pi/extensions/pi-web.ts` 已优先启动项目内构建后的 pi-web。
- 生产构建、TypeScript 检查、Python 语法检查都已通过。

这意味着现在的优化重点不再是“能不能跑”，而是“如何更稳、更快、更易维护”。

## P0：先补可靠性

### 1. 给 pi-web 启动链路加更明确的健康检查

涉及文件：

- `.pi/extensions/pi-web.ts`
- `.pi/runtime/source-cache/agegr-pi-web/bin/pi-web.js`
- `pi-web/app/api/home/route.ts`

建议：

- 启动后先检查 `GET /api/home` 和 `GET /api/memory`。
- 如果本地构建不存在，明确提示“需要先 build”，不要静默 fallback 到旧产物。
- 把启动失败原因分成“构建缺失”“Node/Python 版本不符”“memory bridge 启动失败”三类。

收益：

- 用户排障成本更低。
- 以后 memory、auth、session 任何一条链路坏了，都能更快定位。

### 2. 把现有测试失败拆成可修复的基线问题

涉及文件：

- `pi-web/components/*`
- `pi-web/lib/*`
- `pi-web/app/api/*`

当前已知问题包括：

- `useI18n must be used inside I18nProvider`
- Windows symlink 权限导致的 `EPERM`
- source cache 里已有的老测试基线噪音

建议：

- 把这些失败单独固化成一份“已知失败清单”。
- 对真正跟新功能相关的测试，先补最小覆盖。
- 对环境相关失败，改成明确跳过或替代实现，而不是让整个 test suite 长期红着。

收益：

- 后续任何回归都会更容易识别。
- 你不会再被历史噪音掩盖真实问题。

### 3. 给 memory API 加缓存和分页边界

涉及文件：

- `pi-web/app/api/memory/route.ts`
- `bridge/memory_bridge.py`
- `pi-web/components/MemoryDashboard.tsx`

建议：

- 现在 snapshot 上限是 500 drawers / 500 facts，后续可改为分页或分批加载。
- 列表和图谱分开请求，避免一次性拉太多数据。
- 对 snapshot 做短 TTL 缓存，减少频繁刷新时的 Python 启动压力。

收益：

- 数据变大后仍然能保持可用。
- 刷新体验更平滑。

## P1：提升可维护性和可观测性

### 4. 给记忆系统补审计和变更历史

涉及文件：

- `bridge/memory_bridge.py`
- `.equaxis/memory/`
- `docs/MEMORY.md`

建议：

- 对 `remember`、`update`、`delete`、`add_fact` 记录简短审计日志。
- 记录是谁触发、改了哪条、改前改后摘要是什么。
- 在 pi-web 面板里展示最近变更。

收益：

- 记忆不是静态存储，必须能追踪演化。
- 以后排查“为什么记忆变了”会容易很多。

### 5. 给知识图谱加更清晰的实体钻取

涉及文件：

- `pi-web/components/MemoryDashboard.tsx`
- `bridge/memory_bridge.py`

建议：

- 现在图谱适合看整体结构，下一步补实体详情侧栏。
- 点击节点后展示该实体的事实、相关 drawer、来源时间。
- 增加 predicate 过滤和路径追踪。

收益：

- 图谱不只是“看起来有”，而是能真正帮助检索和理解。

### 6. 把 memory 默认配置显式化

涉及文件：

- `.equaxis/equaxis.json`
- `.pi/memory.json`
- `docs/MEMORY.md`

建议：

- 明确默认 `wing`、`room`、`hall` 的设计含义。
- 把常用存储位置和命名规则写成约定。
- 对不同类型记忆建立更清楚的归类标准。

收益：

- 数据结构更一致。
- 后面做统计、搜索、过滤会更简单。

## P1：优化 pi-web 体验

### 7. 给记忆入口加更直接的发现路径

涉及文件：

- `pi-web/components/AppShell.tsx`
- `pi-web/app/page.tsx`

建议：

- 除了顶部按钮，再考虑在侧边栏或设置区放一个稳定入口。
- 给 memory 面板加一个快捷键或命令入口。
- 让当前 cwd 为空时给出明确空态，而不是只禁用按钮。

收益：

- 功能更容易被使用到。
- 不会只停留在“知道的人才知道”。

### 8. 减少 source cache 与根仓库的混淆

涉及文件：

- `.pi/extensions/pi-web.ts`
- `.pi/runtime/source-cache/agegr-pi-web/`
- `pi-web/`

建议：

- 明确说明：运行时优先用 source cache 里的构建产物。
- 把“源码编辑区”和“运行时产物区”分清楚。
- 在文档里写清 build / restart / verify 的顺序。

收益：

- 以后不会再在“改了代码但没生效”这类问题上浪费时间。

## P2：更远一点的增强

### 9. 给记忆面板加入写操作

建议方向：

- 内联编辑 drawer 内容。
- 修改 wing / room / hall。
- 删除前二次确认。
- 新增 drawer 表单。

说明：

- 这个方向有价值，但要放在审计、权限和回滚机制明确之后。
- 现在先把只读面板打稳，再扩展编辑能力更合理。

### 10. 给 Equaxis 增加一条完整 smoke 测试链

建议方向：

- 启动 pi-web。
- 打开 `/pi-web`。
- 验证首页、session 列表、memory API、dashboard 入口。
- 至少覆盖 Windows 和 Linux 两个运行环境中的核心路径。

收益：

- 可以把“能跑”变成持续可验证的属性。

## 推荐顺序

如果只做一轮，我建议按这个顺序：

1. 先补启动健康检查和已知测试失败清单。
2. 再做 memory API 的分页/缓存。
3. 接着补审计和实体钻取。
4. 最后再扩展写操作和更完整的 smoke 测试。

## 结论

现在 Equaxis 已经有了可用的 memory 可视化，下一阶段最值钱的优化不是再加更多界面，而是把启动链路、测试基线、数据可观测性和 memory 变更审计补齐。这样后续不管是扩展知识图谱、做编辑能力，还是把 memory 面板做成长期入口，成本都会低很多。
