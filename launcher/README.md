# Gemini Web Bridge launcher

Run `npm ci` from the bridge repository, then run `./build.sh "/path/to/output directory"` from this directory with a Swift 6 toolchain. Open `Gemini Web Bridge.app` in the requested directory. The build targets macOS 14 or later on the build machine's architecture. Use a fresh output directory or move the existing app before rebuilding.

The bundle includes the bridge and Playwright. Node and Chrome are installed separately.

Install Node 22 or later. The launcher checks the absolute executable path in `BRIDGE_NODE`, its inherited `PATH`, then common macOS install locations. For a custom Node installation, run the app executable from a terminal with `BRIDGE_NODE` set, for example:

```sh
BRIDGE_NODE="/absolute/path/to/node" "/path/to/Gemini Web Bridge.app/Contents/MacOS/GeminiWebBridge"
```

The launcher runs one script at a time and shows its process state and exit result. It discards standard output and standard error. Stop and Quit signal the Node process so it can clean up. If Node stays alive for ten seconds, the launcher force-stops it. Cleanup of any child apps or browser sessions then depends on the script.
