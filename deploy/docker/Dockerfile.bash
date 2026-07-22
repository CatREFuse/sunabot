ARG BASH_BASE_IMAGE=docker.io/library/node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${BASH_BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/workbench \
    PATH=/usr/local/bin:/usr/bin:/bin \
    TMPDIR=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        diffutils \
        file \
        grep \
    && rm -rf /var/lib/apt/lists/* \
    && for executable in \
        /bin/bash \
        /usr/bin/env /usr/bin/test \
        /usr/bin/base64 /usr/bin/basename /usr/bin/cat /usr/bin/cksum /usr/bin/cmp /usr/bin/cp \
        /usr/bin/curl /usr/bin/diff /usr/bin/dirname /usr/bin/du /usr/bin/echo /usr/bin/false \
        /usr/bin/file /usr/bin/grep /usr/bin/head /usr/bin/ls /usr/bin/md5sum /usr/bin/mkdir \
        /usr/bin/mv /usr/bin/printf /usr/bin/pwd /usr/bin/readlink /usr/bin/realpath /usr/bin/rm \
        /usr/bin/rmdir /usr/bin/sha1sum /usr/bin/sha224sum /usr/bin/sha256sum /usr/bin/sha384sum \
        /usr/bin/sha512sum /usr/bin/stat /usr/bin/tail /usr/bin/touch /usr/bin/true /usr/bin/wc; \
       do test -x "$executable"; done

WORKDIR /workbench
USER 65534:65534
ENTRYPOINT []
CMD ["/usr/bin/true"]
