ARG BASH_BASE_IMAGE=docker.io/library/node:24.18.0-bookworm-slim@sha256:0778d035a13f3f3833b7f2cb750e0df6cbce45583e84fd822f499f0c902a6c74

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
