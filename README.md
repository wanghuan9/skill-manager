# SkillDock

一个基于 Tauri + React 的桌面技能工作台，用于管理和组织各种开发工具、AI 助手技能与 MCP 配置。

## 🚀 功能特性

- **技能管理**: 安装、更新、删除各种开发工具和 AI 助手技能
- **市场集成**: 从技能市场浏览和安装新技能
- **本地导入**: 导入和管理本地技能包
- **Git 集成**: 管理技能的 Git 状态和更新
- **工具同步**: 同步和管理各种开发工具的配置

## 🛠️ 技术栈

- **前端**: React 18 + TypeScript + Vite
- **后端**: Tauri (Rust)
- **测试**: Vitest + React Testing Library
- **构建**: Vite + Tauri CLI

## 📦 安装和运行

### 环境要求

- Node.js >= 18
- Rust >= 1.70
- macOS 10.15+ (应用目标平台)

### 开发环境设置

1. 克隆仓库

```bash
git clone https://github.com/wanghuan9/skill-manager.git
cd skill-manager
```

2. 安装依赖

```bash
npm install
```

3. 启动开发服务器

```bash
npm run desktop:dev
```

### 构建生产版本

```bash
npm run desktop:build
```

## 🧪 测试

```bash
# 运行测试
npm run test

# 监听模式
npm run test:watch
```

## 📁 项目结构

```text
skill-manager/
├── src/                    # React 前端源码
│   ├── app/               # 应用主组件和路由
│   ├── features/          # 功能模块
│   │   ├── install/       # 安装功能
│   │   ├── skills/        # 技能管理
│   │   └── local-skills/  # 本地技能
│   ├── styles/            # 样式文件
│   └── tests/             # 前端测试
├── src-tauri/             # Tauri 后端源码
│   ├── src/               # Rust 源码
│   └── icons/             # 应用图标
├── public/                # 静态资源
│   └── tool-logos/        # 工具图标
├── docs/                  # 项目文档
└── dist/                  # 构建输出
```

## 🎯 核心功能模块

### 技能管理
- 技能卡片展示和状态管理
- 技能安装、更新、卸载
- 技能配置和设置

### 市场集成
- 技能市场浏览
- 技能搜索和筛选
- 一键安装功能

### Git 集成
- 技能仓库状态监控
- 变更预览
- 版本管理

### 工具管理
- 开发工具同步
- 配置文件管理
- 工具状态监控

## 🔧 开发脚本

```bash
# 开发
npm run dev              # 启动前端开发服务器
npm run desktop:dev      # 启动桌面应用开发模式

# 构建
npm run build            # 构建前端
npm run desktop:build    # 构建桌面应用

# 测试
npm run test             # 运行测试
npm run test:watch       # 监听模式测试

# Rust
npm run tauri:check      # 检查 Rust 代码
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📞 联系方式

如有问题或建议，请通过 GitHub Issues 联系我。
