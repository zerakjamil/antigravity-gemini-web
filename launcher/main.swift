import AppKit

private enum Action: Int, CaseIterable {
    case signIn, desktop, verify

    var title: String {
        switch self {
        case .signIn: "Sign In"
        case .desktop: "Start Antigravity"
        case .verify: "Verify Web tools"
        }
    }

    var script: String {
        switch self {
        case .signIn: "browser-login.mjs"
        case .desktop: "desktop.mjs"
        case .verify: "verify-web.mjs"
        }
    }
}

@MainActor
private final class Launcher: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let status = NSTextField(labelWithString: "Ready")
    private var actionButtons: [NSButton] = []
    private var stopButton: NSButton!
    private var process: Process?
    private var stopping = false
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Gemini Web Bridge",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        NSApp.mainMenu = menu

        actionButtons = Action.allCases.map { action in
            let button = NSButton(title: action.title, target: self, action: #selector(start(_:)))
            button.tag = action.rawValue
            return button
        }
        stopButton = NSButton(title: "Stop", target: self, action: #selector(stop))
        stopButton.isEnabled = false

        let buttons = NSStackView(views: actionButtons + [stopButton])
        buttons.orientation = .horizontal
        buttons.spacing = 8
        status.setAccessibilityLabel("Process status")
        let content = NSStackView(views: [buttons, status])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)

        window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable],
                          backing: .buffered, defer: false)
        window.title = "Gemini Web Bridge"
        window.contentView = content
        let size = content.fittingSize
        window.setContentSize(NSSize(width: max(440, size.width), height: size.height))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard process != nil else { return .terminateNow }
        quitting = true
        stop()
        return .terminateLater
    }

    private func repoDirectory() -> URL? {
        let bundle = Bundle.main
        let candidates = [
            bundle.resourceURL?.appendingPathComponent("gemini-web-bridge", isDirectory: true),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        ].compactMap { $0 }
        return candidates.first { directory in
            [Action.desktop, .verify].allSatisfy {
                FileManager.default.isReadableFile(atPath: directory.appendingPathComponent($0.script).path)
            }
        }
    }

    @objc private func start(_ sender: NSButton) {
        guard process == nil, let action = Action(rawValue: sender.tag) else { return }
        guard let repo = repoDirectory() else {
            status.stringValue = "Bridge repository not found."
            return
        }
        let script = repo.appendingPathComponent(action.script)
        guard FileManager.default.isReadableFile(atPath: script.path) else {
            status.stringValue = "Missing \(action.script)."
            return
        }

        var environment = ProcessInfo.processInfo.environment
        let localTools = FileManager.default.homeDirectoryForCurrentUser.path
        let commonPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin",
                           localTools + "/.local/share/vite-plus/bin", "/usr/bin", "/bin"]
        let paths = (environment["PATH"] ?? "").split(separator: ":")
            .map(String.init).filter { $0.hasPrefix("/") } + commonPaths
        let candidates = [environment["BRIDGE_NODE"]].compactMap { $0 } + paths.map { $0 + "/node" }
        guard let node = candidates.first(where: {
            $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0)
        }) else {
            status.stringValue = "Node not found. Set BRIDGE_NODE or install Node."
            return
        }
        let nodeURL = URL(fileURLWithPath: node)
        environment["PATH"] = ([nodeURL.deletingLastPathComponent().path] + paths).joined(separator: ":")

        let child = Process()
        child.executableURL = nodeURL
        child.arguments = [action.script]
        child.currentDirectoryURL = repo
        child.environment = environment
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] finished in
            let code = finished.terminationStatus
            let exited = finished.terminationReason == .exit
            Task { @MainActor in
                self?.finished(action, code: code, exited: exited)
            }
        }

        do {
            try child.run()
            process = child
            status.stringValue = "\(action.title) is running…"
            setRunning(true)
        } catch {
            status.stringValue = "Could not launch \(action.script)."
        }
    }

    @objc private func stop() {
        guard let process, process.isRunning, !stopping else { return }
        stopping = true
        status.stringValue = "Stopping…"
        stopButton.isEnabled = false
        process.terminate()
        // Give desktop.mjs time to shut down Antigravity and close its browser.
        Task { @MainActor [weak self, weak process] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, let process, self.process === process, process.isRunning else { return }
            if kill(process.processIdentifier, SIGKILL) != 0 {
                self.status.stringValue = "Could not stop Node. Try Stop again."
                self.stopping = false
                self.stopButton.isEnabled = true
                if self.quitting {
                    self.quitting = false
                    NSApp.reply(toApplicationShouldTerminate: false)
                }
            }
        }
    }

    private func finished(_ action: Action, code: Int32, exited: Bool) {
        if stopping && !exited && code == SIGKILL {
            status.stringValue = "Node did not respond and was force-stopped."
        } else if stopping {
            status.stringValue = "\(action.title) stopped."
        } else if exited && code == 0 {
            status.stringValue = "\(action.title) finished."
        } else {
            let reason = exited ? "exit code" : "signal"
            status.stringValue = "\(action.title) ended (\(reason) \(code))."
        }
        process = nil
        stopping = false
        setRunning(false)
        if quitting {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
    }

    private func setRunning(_ running: Bool) {
        actionButtons.forEach { $0.isEnabled = !running }
        stopButton.isEnabled = running
    }
}

let app = NSApplication.shared
private let launcher = Launcher()
app.setActivationPolicy(.regular)
app.delegate = launcher
app.run()
