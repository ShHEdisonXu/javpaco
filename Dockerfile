# JAVPACO 迷你媒体服务 —— 零构建依赖，直接用官方 Node 镜像
# 精简版：头像库不进镜像（server.js 头像在线兜底按需抓取，落盘 cache/actors/）；
# cache/ 单层整拷（多目录 COPY 会拍平互相覆盖，见下）。
FROM node:22-alpine

# ffmpeg/ffprobe：进度条缩略图抽帧用
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 只拷贝需要的文件（媒体目录通过卷挂载，不进镜像）
COPY index.html server.js mdcng.js hls.light.min.js package.json package-lock.json ./
COPY rules ./rules
COPY covers ./covers
COPY manifest.webmanifest sw.js icon-192.png icon-512.png apple-touch-icon.png favicon.ico ./

# 刮削规则引擎的 npm 依赖（js-yaml/jsdom/xpath/jpeg-js，见 package.json）
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# 女优名册 actresses.json（约 16MB）已移出 git 与镜像：运行时缺失则由 server.js 写入空 []，
# 可通过 ROSTER_URL 环境变量在首次启动时拉取（见 README）。其余女优相关元数据仍随镜像分发。
COPY name-map.json name-alias.json rankings.json tags-zh.json actresses-extra.json ./

# 头像库（actresses/，957MB）已改为在线按需抓取，不再 COPY 进镜像。
# 示例影片包（sample-cache/movies/<番号>/：meta.json + 竖版海报，~8MB，118 部）：
# 首次运行且离线缓存为空时自动播种（server.js seedSamples），没挂媒体也能看到内容。
COPY sample-cache ./sample-cache
# 个人数据（server-config.json / watch.json / userdata.json / media-path.txt）已被 .dockerignore 排除。

ENV PORT=8090
# 离线数据文件夹挂载点：用户把任意宿主文件夹挂到 /app/cache，
# 缓存自动建在其下 cache/ 子目录（宿主机上是 <挂载文件夹>/cache/），无需手动创建
ENV JP_CACHE=/app/cache
EXPOSE 8090

# 媒体目录可选：不挂载也能跑（展示示例/离线缓存条目），要用时再挂任意路径并在网页里添加媒体库
VOLUME ["/media", "/app/cache"]

# 容器内媒体固定挂载在 /media
CMD ["node", "server.js", "/media", "8090"]
