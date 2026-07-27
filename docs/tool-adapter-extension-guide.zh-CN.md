# SkillDock 宿主工具适配扩展流程

本文档用于新增 AI 编程工具的 Skills / MCP 适配。目标是让新增工具走统一注册入口，同时避免改变已有宿主行为。

## 1. 官方信息核对

新增适配前必须从官方文档或官方源码确认：

- 稳定产品名、命令名和工具 id；
- 用户级与项目级 Skills 路径；
- 用户级与项目级 MCP 配置路径；
- MCP 是否为宿主原生能力；
- MCP 文件格式、transport 支持范围和启停字段；
- macOS、Windows、Linux 路径是否不同。

没有官方原生 MCP 配置时，必须声明 `McpAdapterFormat::None`，不得根据第三方扩展猜测配置文件。

## 2. 注册宿主

在 `src-tauri/src/tool_adapters.rs` 的 `TOOL_ADAPTER_DEFINITIONS` 增加声明：

- `id` 和 `name`；
- `skills_relative_path`；
- `mcp_relative_path`；
- `install_probe_relative_path`；
- 工具类型、surface、可执行文件名；
- `McpAdapterFormat` 和 `McpTransportPolicy`。

如果 MCP 格式已经属于 JSON object、JSON array 或 TOML table，只选择现有格式，不增加新的主流程分支。

## 3. 新增格式适配器

只有宿主配置结构无法由现有格式表达时，才在 `mcp_manager.rs` 增加新的格式转换函数。适配器必须实现同一生命周期：

1. read：从宿主配置转换为 SkillDock 统一 server JSON；
2. upsert：首次创建或更新指定 server；
3. remove：只删除指定 server；
4. preserve：保留配置文件中的其他顶层字段和其他 server；
5. reject：对宿主不支持的 transport 返回明确错误。

禁止在格式适配器里修改其他宿主配置，也禁止重写整个配置文件为只包含 SkillDock 字段的结构。

## 4. 前端登记

同步更新：

- `tool-logo.ts` 的名称映射和展示顺序；
- `tool-logo-manifest.json` 与本地 logo 资产；
- `open-tools.ts` 的排序；
- browser-only fixtures；
- `docs/tool-skill-and-mcp-paths.zh-CN.md`。

## 5. 必测契约

每个新宿主至少覆盖：

- Skills 路径和 MCP 路径；
- 是否正确进入或排除 MCP target apps；
- 不存在配置文件时扫描为空；
- 首次写入后宿主文件格式正确；
- 更新同名 server 不产生重复项；
- 删除只移除目标 server；
- 未知顶层字段和其他 server 保留；
- 不支持的 transport 明确拒绝；
- 既有 Rust 与前端测试全部通过。

## 6. 验证命令

```bash
cd src-tauri
cargo fmt --all -- --check
cargo test --lib -- --test-threads=1

cd ..
npm test
npm run build
```

代码规范格式检查还需运行：

```bash
python3 /Users/wanghuan/.skilldock/skills/code-standards/skills/code-standards/scripts/format-check.py --git-diff
```
