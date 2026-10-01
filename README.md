# JAVPACO · 迷你影片媒体库

单文件 Node.js 媒体库服务：番号识别、元数据刮削、演员/系列/榜单聚合、MissAV 应用内在线播放。零构建依赖，`node server.js` 直接跑，官方 Node 镜像直接 `docker build`。

> 自用项目，界面与示例数据均为中文向。请自行遵守所在地区法律法规，仅用于管理个人合法获取的媒体文件。

## 快速开始

```bash
# 源码运行（Node 18+，需要 ffmpeg 在 PATH 里做缩略图）
npm ci --omit=dev
node server.js /path/to/media 8090

# Docker
docker build -t javpaco .
docker run -d --name javpaco -p 8090:8090 \
  -v /path/to/media:/media \
  -v /path/to/cache:/app/cache \
  javpaco
```

参照 `docker-compose.example.yml` 修改路径即可。

## 目录约定（容器内路径）

| 容器内路径 | 是什么 | 该怎么做 |
|---|---|---|
| `/app` | 程序根目录：`index.html` / `server.js` / `sw.js` / `rules/` / `covers/` / `name-map.json` / `rankings.json` / `tags-zh.json` / `sample-cache/` + `node_modules/`（`npm ci` 构建期装好） | 用官方镜像时**不要挂载**（会盖掉内置文件）；只有源码运行才 `-v .:/app` |
| `/media` | **媒体库挂载点**（容器启动命令 `node server.js /media 8090`） | 挂你的影片文件夹，**读写**（「导入视频整理」要原地改名/建目录）。可挂父目录，子文件夹启动后在 设置 → 媒体库 里逐个添加 |
| `/app/cache` | **离线数据挂载点**（`ENV JP_CACHE=/app/cache`，`VOLUME` 声明）。server.js 会自动在它下面建 `cache/` 子目录 | **强烈建议挂**：刮削成果、头像、设置备份都在这，升级镜像/重建容器/换机器都不丢；新机器把同一个文件夹挂到 `/app/cache` 就直接读回全部成果 |
| `/app/cache/cache/` | 真正的数据根（自动创建）：`movies/<番号>/`（meta.json + poster/fanart）、`actors/*.jpg`、`avatar-miss.json`、`server-config.backup.json` | 不用手动建。宿主机上就是 `<你挂的文件夹>/cache/` |
| `/app/actresses.json` | 女优名册（约 16MB，**不在镜像里**） | 放部署目录、或 `-e ROSTER_URL=<可访问链接>` 首次启动自动拉；容器内还有每日自动同步 |
| `/app/actresses/` | 完整头像库（957MB，**不在镜像里**） | 不用管：缺头像时按需在线抓取并落到 `cache/actors/`（持久化） |
| `/app/covers/` | 站点/片商封面，镜像内置 | 不用挂 |

> 端口：容器内 **8090**（`ENV PORT=8090`）。只暴露这一个端口即可。

**示例影片**：镜像内置 118 部示例（`meta.json` + 竖版海报 + 剧照，约 117MB）。首次运行且离线缓存为空时自动载入，页面立刻有内容；配置自己的媒体库并扫描后自动让位。

## 女优名册与示例数据（运行时资源）

- **女优名册 `actresses.json`**（约 16MB，**不入 git**）：本地部署目录存在则直接使用；缺失时 `server.js` 自动写入空 `[]`，各读取点不会崩溃。
- **开箱即有完整名册**：把 `actresses.json` 放到项目/部署目录，或设置环境变量 `ROSTER_URL` 指向可访问的名册文件，首次启动时自动拉取；容器里还有每日自动同步（`GET/POST /api/roster/sync`，带防回退安全阀）。
- **示例数据 `sample-cache/`**（118 部 / 约 117MB）：**随仓库分发**，Docker 构建时由 `COPY sample-cache` 打进镜像；这正是「没挂媒体也能立刻看到内容」的来源，也是 `docker build` 的硬前提 —— 该目录不存在会导致构建直接失败。

## 主要功能

- 番号识别（横杠/无横杠/日期式无码），扫库增量执行，失败自动进待处理列表
- 扫描后自动刮削新番号、每日定时重扫（设置 → 刮削与整理，可关）
- MissAV 应用内播放：导航站线路发现 + 镜像健康度 + HLS 中转重写（hls.js）
- 演员聚合页、系列、榜单（每日自动更新）、收藏/订阅/隐藏
- 搜索：1~2 字符短关键词只搜番号与演员名，3 字符起全文
- 115 网盘挂载目录直接作媒体库；代理可视化配置
- server-config.json 一键备份/恢复（含白名单字段）

## 相关文件

- `rules/mdc-ng/` 刮削规则引擎的规则集
- `tools/` 演员资料/别名同步等辅助脚本
- `tags-zh.json`、`name-map.json`、`rankings.json` 内置中文标签映射与榜单种子数据
