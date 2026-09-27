# Freesia Android build image: JDK 21 + Android cmdline-tools + SDK 37 + Gradle.
# Nothing Android-related is installed on the host; everything lives here.
FROM eclipse-temurin:21-jdk-noble

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_HOME=/opt/gradle \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl ca-certificates git ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Android command-line tools (latest published build as of Sept 2026)
ARG CMDLINE_TOOLS_BUILD=16111833
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
 && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip" -o /tmp/ct.zip \
 && unzip -q /tmp/ct.zip -d /tmp/ct \
 && mv /tmp/ct/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
 && rm -rf /tmp/ct /tmp/ct.zip

ENV PATH=${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/37.0.0:/opt/gradle/bin

# Android 17 (API 37) platform and build tools
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" > /dev/null \
 && chmod -R a+rwX ${ANDROID_HOME}

# A system Gradle only to (re)generate the wrapper; builds use ./gradlew
ARG GRADLE_VERSION=9.8.0
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/g.zip \
 && unzip -q /tmp/g.zip -d /opt \
 && mv /opt/gradle-${GRADLE_VERSION} /opt/gradle \
 && rm /tmp/g.zip

WORKDIR /work
