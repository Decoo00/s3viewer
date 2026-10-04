# bfres.zs → glb 변환 도구 이미지 (tools/cloud_toolkit 묶음을 ubuntu 24.04에 복원)
# build: docker build -t s3glb -f tools/convert/Dockerfile tools/cloud_toolkit
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends python3 xz-utils libicu74 && rm -rf /var/lib/apt/lists/*
COPY restore.sh s3tools.tar.xz.part* /toolkit/
RUN bash /toolkit/restore.sh /opt/s3tools && rm -rf /toolkit
