# OkHttp ships its own consumer rules; these keep R8 quiet about optional TLS providers.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

# The accessibility service and FGS are referenced from the manifest (kept by AAPT rules).
# Keep line numbers so crash reports stay readable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
