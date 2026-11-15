# Gemini Web for Antigravity

Gemini Web Bridge connects the signed-in Gemini website to Antigravity for 4 Argon and 4 Hydrogen. A local adapter translates a Web tool request into a function call for Antigravity to handle under its own permissions. The next request sends the result back to Gemini Web with the conversation history. There is no Gemini Developer API key or metered API backend.

## Native macOS launcher

Install Node.js 22+, Chrome, Antigravity Desktop and the Xcode command-line tools. In the repository run `npm ci` and `./launcher/build.sh dist`. Open `dist/Gemini Web Bridge.app`. Choose **Sign In** to open the dedicated Chrome profile, sign in to Gemini, and close that window. Choose **Verify Web tools** to run the two-model file test or **Start Antigravity** to start a Gateway session. Quit any existing Antigravity session first. See [launcher setup](launcher/README.md) for Node discovery and build details.

## Desktop app integration under test

On macOS, close the Antigravity desktop app and any Chrome window using the dedicated Argon profile. From this directory run `npm ci` and `npm run desktop`. The launcher starts a loopback HTTPS Gateway, starts Antigravity with Gateway settings for that process, and stops the bridge when Antigravity exits. It issues a temporary local bearer token and trusts the temporary TLS certificate only in the launched app. Google documents [Gateway routing with native tool execution](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools/connect-enterprise-gateway#workstation_security_and_local_sandboxing).

The desktop connection and model picker still need a live acceptance test. In a disposable workspace, check for **Connected: Enterprise Gateway**, select the desired Web model from the picker, and request an exact read of a test file. Verify the file tool and the follow-up answer in Antigravity. Quit and reopen Antigravity normally to return to Google account sign-in.

## CLI option

Requires Node.js 22+, Google Chrome, [Antigravity CLI](https://antigravity.google/docs/cli/install/), and a Gemini Web account that can select 4 Argon. Close any Chrome window already using the dedicated Argon profile.

In this directory, run:

```sh
npm install
export ARGON_BRIDGE_TOKEN="$(openssl rand -hex 32)"
export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:50006
export GEMINI_API_KEY="$ARGON_BRIDGE_TOKEN"
node server.mjs &
bridge_pid=$!
```

Wait for the bridge to print its listening address. If Gemini Web asks for sign-in, sign in normally in the Chrome window the bridge opened. By default the bridge uses the existing `~/.gemini/argon-chrome-profile` directory. Set `ARGON_CHROME_PROFILE` to use a different dedicated Chrome profile.

Merge the following into `~/.gemini/antigravity-cli/settings.json`, preserving existing settings and custom models:

```json
{
  "modelProvider": "gemini",
  "customModelsConfig": {
    "customModels": [
      {
        "modelName": "gemini-api://http://127.0.0.1:50006/models/gemini-4-argon-web",
        "label": "Gemini 4 Argon (Web)"
      },
      {
        "modelName": "gemini-api://http://127.0.0.1:50006/models/gemini-4-hydrogen-web",
        "label": "Gemini 4 Hydrogen (Web)"
      }
    ]
  }
}
```

Run `agy` from a disposable project in the same shell. Select **Gemini 4 Argon (Web)** with `/model`. Ask it to read a test text file and repeat its contents. A successful smoke test shows the tool call in Antigravity, followed by the answer containing the file contents. Project context and tool results included in the request are sent to Gemini Web and can appear in the Google account's chat history.

Stop the bridge with `kill "$bridge_pid"`. Remove the added provider setting and custom model entry to restore the prior CLI setup.

## Verification and limits

`npm test` checks the model catalog, HTTPS Gateway authentication, the tool round trip, and rejection of an undeclared tool. Run `node verify-web.mjs` to test both signed-in Web models through the bridge with a synthetic local file. The test driver runs the file read, so this check measures the Web model and bridge independently of Antigravity. The separate standalone Antigravity IDE has no integration in this package.

The browser worker requires the mode picker to confirm the requested model before sending. The current build replays text history in a fresh browser chat for each turn and returns one completed SSE event, so the first visible text can arrive later than with a native streaming model. Tool calls are prompted JSON and are limited to one declared local function per turn. Attachments, provider-side tools and native model controls are outside this prototype. Token counting is an estimate for the local harness.

Large harness requests are sent to Gemini Web as a text attachment. Review the workspace and tools you make available to the session. Model prompts, enabled tool descriptions, and tool results can be included in the Google account's chats. The bridge keeps sign-in state in the dedicated Chrome profile and does not export cookies.

The browser-backed transport and separation of model inference from local tools were inspired by [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md).
