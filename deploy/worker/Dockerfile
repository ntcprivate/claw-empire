# Dedicated empty workspace image. The pinned base is the locally available
# official Node image; this context contains no Claw-Empire source/configuration.
FROM node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

LABEL claw-empire.worker="v1"
WORKDIR /workspace
USER 65532:65532
CMD ["node", "-e", "process.stdin.resume()"]
