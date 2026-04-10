FROM node:20-slim

# 安装必要工具 (git, zip, unzip, curl)
RUN apt-get update && apt-get install -y \
    git \
    zip \
    unzip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 拷贝依赖配置并安装
COPY package*.json ./
RUN npm install --production

# 拷贝源代码 (排除 .git, node_modules 等已在 .dockerignore 处理)
COPY . .

# 创建持久化目录
RUN mkdir -p data/prototypes

# 暴露端口
EXPOSE 4000

# 环境变量默认值 (生产模式)
ENV NODE_ENV=production
ENV PORT=4000

# 运行服务
CMD ["npm", "start"]
