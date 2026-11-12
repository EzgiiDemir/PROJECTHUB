# Optional operator-provisioned Flutter toolchain, NOT a new global worker image.
# Build context must contain flutter-sdk.tar made from an installed official 3.47.2 SDK:
# exclude bin/cache, .git/config, .git/hooks, .git/logs, examples and dev.
# Never include project source, credentials, host caches or personal files.
# docker build -f <this-file> -t projecthub/build:campus-flutter3.47.2 <sdk-context>
FROM projecthub/build:php8.4-node22
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils zip libglu1-mesa && rm -rf /var/lib/apt/lists/*
ADD flutter-sdk.tar /opt/flutter/
# Normalize only the image copy: Windows-installed SDK shell scripts can have CRLF.
RUN find /opt/flutter/bin -type f \( -name '*.sh' -o -name '*.version' -o -name flutter -o -name dart \) -exec sed -i 's/\r$//' {} + && chmod +x /opt/flutter/bin/flutter /opt/flutter/bin/dart /opt/flutter/bin/internal/*.sh && chown -R 1000:1000 /opt/flutter
ENV FLUTTER_ROOT=/opt/flutter PATH=/opt/flutter/bin:$PATH CI=true FLUTTER_SUPPRESS_ANALYTICS=true PUB_ENVIRONMENT=projecthub-preview
USER 1000:1000
RUN flutter config --no-analytics && flutter precache --web --no-android --no-ios --no-linux --no-windows --no-macos --no-fuchsia && flutter --version --machine
