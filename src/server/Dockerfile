
FROM oven/bun:1.4.4-debian

WORKDIR /app

# Cài công cụ hệ thống trong quá trình build Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    p7zip-full \
    libarchive-tools \
    cpio \
    gzip \
    procps \
    iproute2 \
    adb \
    qemu-utils \
    && rm -rf /var/lib/apt/lists/*

# Cài dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Sao chép mã nguồn
COPY . .

# Cấp quyền thực thi cho QEMU đi kèm dự án
RUN chmod +x bin/qemu-system-x86_64 bin/qemu-img

# Build giao diện web
RUN bun run build

ENV NODE_ENV=production
ENV LD_LIBRARY_PATH=/app/lib
ENV PORT=10000

EXPOSE 10000

CMD ["bun", "run", "start"]
