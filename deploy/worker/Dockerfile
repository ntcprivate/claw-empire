FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
LABEL claw-empire.worker="v1" claw-empire.worker-protocol="phase4-v1" claw-empire.worker-runner="remotion-shot-v1" claw-empire.worker-authoring="shotcraft-v1"
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /opt/claw-empire && npm install --prefix /opt/claw-empire --omit=dev --no-audit --no-fund @remotion/cli@4.0.429 remotion@4.0.429 react@19.2.0 react-dom@19.2.0 typescript@5.9.3 @types/react@19.2.0 three@0.180.0 @types/three@0.180.0 @react-three/fiber@9.4.0 @remotion/three@4.0.429 @remotion/motion-blur@4.0.429 zod@4.3.6
ADD --checksum=sha256:3b09abdbe2e2cb34400c0bc9aeca6f34cbfa0f4730afcb137b9e8704c9922cd1 https://codeload.github.com/Vincentwei1021/video-shotcraft/tar.gz/55eb60d155d703b0267a46a0507f6e268a053ad1 /tmp/shotcraft.tar.gz
RUN mkdir -p /opt/skills/video-shotcraft && tar -xzf /tmp/shotcraft.tar.gz --strip-components=1 -C /opt/skills/video-shotcraft && rm /tmp/shotcraft.tar.gz && chmod -R a+rX /opt/skills/video-shotcraft
COPY worker-runner.mjs authoring-tools.mjs worker-platform.mjs /opt/claw-empire/
ENV PATH="/opt/claw-empire/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["node", "/opt/claw-empire/worker-runner.mjs"]
