import Foundation
import AppKit
@preconcurrency import ApplicationServices
import ImageIO
import Vision
import Darwin
import CoreText
import CryptoKit

struct AXIdentity: Hashable {
    let element: AXUIElement

    init(_ element: AXUIElement) { self.element = element }

    static func == (lhs: AXIdentity, rhs: AXIdentity) -> Bool { CFEqual(lhs.element, rhs.element) }

    func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}

func uniqueAXElements(_ elements: [AXUIElement]) -> [AXUIElement] {
    var seen: Set<AXIdentity> = []
    return elements.filter { seen.insert(AXIdentity($0)).inserted }
}

// One Chrome process, one visible window, and one disposable AX snapshot per helper.
struct BrowserError: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) -> BrowserError {
    BrowserError(code: code, message: message)
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "c": 8, "v": 9, "g": 5,
    "enter": 36, "return": 36, "tab": 48, "esc": 53, "escape": 53,
    "home": 115, "end": 119, "left": 123, "right": 124, "down": 125, "up": 126,
]

struct Request {
    let id: Any
    let command: String
    let fields: [String: Any]
    let pid: pid_t?

    init(_ object: Any) throws {
        guard let fields = object as? [String: Any], let id = fields["id"], Request.validID(id),
              let command = fields["command"] as? String else {
            throw fail("INVALID_REQUEST", "Expected a request ID and command.")
        }
        let allowed: [String: Set<String>] = [
            "status": [], "requestPermission": [], "requestScreenPermission": [], "locateFlow": [], "focusFlow": ["pid"],
            "snapshot": ["pid"], "activateAccessibility": ["pid"],
            "press": ["pid", "nodeId"], "focus": ["pid", "nodeId"], "readLabel": ["pid", "nodeId"], "setValue": ["pid", "nodeId", "value"],
            "key": ["pid", "key", "modifiers"], "text": ["pid", "text"],
            "chooseFile": ["pid", "path", "sha256"], "readIngredientFingerprint": ["pid", "nodeId"],
        ]
        guard let arguments = allowed[command], Set(fields.keys).isSubset(of: arguments.union(["id", "command"])) else {
            throw fail("INVALID_REQUEST", "Unsupported command or argument.")
        }
        var targetPID: pid_t?
        if arguments.contains("pid") {
            guard let number = fields["pid"] as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
                  number.doubleValue.rounded() == number.doubleValue,
                  number.int64Value > 0, number.int64Value <= Int32.max else {
                throw fail("INVALID_REQUEST", "Expected a valid Chrome process ID.")
            }
            targetPID = pid_t(number.int32Value)
        }
        for name in arguments.intersection(["nodeId", "value", "text", "key"]) {
            guard let value = fields[name] as? String else {
                throw fail("INVALID_REQUEST", "Expected a string argument.")
            }
            let maximum = name == "nodeId" ? 256 : name == "key" ? 16 : 20_000
            guard value.utf16.count <= maximum, !value.contains("\0"), name != "nodeId" || !value.isEmpty else {
                throw fail("INVALID_REQUEST", "String argument exceeds its allowed bounds.")
            }
        }
        if command == "key" {
            let key = fields["key"] as! String
            let modifiers: [String]
            if let value = fields["modifiers"] {
                guard let list = value as? [String] else { throw fail("INVALID_REQUEST", "Invalid key modifiers.") }
                modifiers = list
            } else {
                modifiers = []
            }
            let flags = Set(modifiers)
            let navigation: Set<String> = ["tab", "esc", "escape", "enter", "return", "left", "right", "up", "down", "home", "end"]
            let shiftKeys: Set<String> = ["tab", "left", "right", "up", "down", "home", "end"]
            let permitted = (flags.isEmpty && navigation.contains(key))
                || (flags == ["shift"] && shiftKeys.contains(key))
                || (flags == ["command"] && ["a", "c", "v"].contains(key))
                || (flags == ["command", "shift"] && key == "g")
            guard flags.count == modifiers.count, permitted, keyCodes[key] != nil else {
                throw fail("INVALID_REQUEST", "Key combination is not allowed.")
            }
        }
        if command == "chooseFile" {
            guard let path = fields["path"] as? String, let digest = fields["sha256"] as? String,
                  validReferencePath(path), validSHA256(digest) else {
                throw fail("INVALID_REQUEST", "Expected an absolute supported image path and SHA-256 digest.")
            }
        }
        self.id = id
        self.command = command
        self.fields = fields
        self.pid = targetPID
    }

    static func validID(_ value: Any) -> Bool {
        if let string = value as? String { return !string.isEmpty && string.utf8.count <= 256 }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue.isFinite && number.doubleValue.rounded() == number.doubleValue
            && abs(number.doubleValue) <= 9_007_199_254_740_991
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if let url = value as? URL { return url.absoluteString }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func numberAttribute(_ element: AXUIElement, _ name: String) -> Double? {
    guard let value = attribute(element, name) as? NSNumber,
          CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
    return value.doubleValue
}

func sliderValue(_ text: String, _ minimum: Double?, _ maximum: Double?) throws -> NSNumber {
    guard text.utf8.count <= 64,
          text.range(of: #"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$"#, options: .regularExpression) != nil,
          let value = Double(text), value.isFinite, let minimum, let maximum,
          minimum.isFinite, maximum.isFinite, minimum <= maximum, value >= minimum, value <= maximum else {
        throw fail("INVALID_VALUE", "Slider value must be a finite decimal within its accessible bounds.")
    }
    return NSNumber(value: value)
}

func isProtected(_ element: AXUIElement) -> Bool {
    let role = stringAttribute(element, "AXRole") ?? ""
    let subrole = stringAttribute(element, "AXSubrole") ?? ""
    return role == "AXSecureTextField" || subrole == "AXSecureTextField"
        || (attribute(element, "AXProtectedContent") as? Bool == true)
        || (attribute(element, "AXIsProtected") as? Bool == true)
}

func isSensitiveInput(_ element: AXUIElement) -> Bool {
    if isProtected(element) { return true }
    let role = stringAttribute(element, "AXRole") ?? ""
    guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) else { return false }
    let label = ["AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp"]
        .compactMap { stringAttribute(element, $0) }.joined(separator: " ").lowercased()
    return ["password", "passcode", "verification code", "one-time code", "api key", "secret key", "access token", "парол", "код подтверждения"]
        .contains { label.contains($0) }
}

func protectedAncestor(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0...48 {
        guard let candidate = current else { break }
        if isSensitiveInput(candidate) || credentialURL(stringAttribute(candidate, "AXURL"))
            || credentialURL(stringAttribute(candidate, "AXDocument")) { return true }
        if stringAttribute(candidate, "AXRole") == "AXWindow" { break }
        current = elementAttribute(candidate, "AXParent")
    }
    return false
}

func screenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return (session["CGSSessionScreenIsLocked"] as? Bool == true)
        || (session[kCGSessionOnConsoleKey as String] as? Bool == false)
}

func credentialURL(_ value: String?) -> Bool {
    guard let value, let url = URL(string: value) else { return false }
    let host = (url.host ?? "").lowercased()
    return host == "passwords.google.com" || (url.scheme == "chrome" && (
        host == "password-manager" || (host == "settings" && url.path.lowercased().contains("password"))
    ))
}

func flowURL(_ value: String?) -> Bool {
    guard let value, let url = URLComponents(string: value) else { return false }
    return url.scheme?.lowercased() == "https" && url.host?.lowercased() == "flow.google.com"
        && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
}

func validSHA256(_ value: String) -> Bool {
    value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
}

func validReferencePath(_ value: String) -> Bool {
    value.hasPrefix("/") && value.utf8.count <= 4_096 && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
        && URL(fileURLWithPath: value).standardizedFileURL.path == value
        && ["png", "jpg", "jpeg", "webp", "gif"].contains(URL(fileURLWithPath: value).pathExtension.lowercased())
}

func selectedReferencePaths(_ paths: Set<String>, _ path: String) -> Bool {
    paths.contains(path) && paths.allSatisfy { $0 == path || path.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }
}

func referenceDigest(_ path: String) throws -> String {
    guard validReferencePath(path) else { throw fail("REFERENCE_INVALID", "The image reference path is invalid.") }
    let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard descriptor >= 0 else { throw fail("REFERENCE_INVALID", "The image reference is unavailable or is a symbolic link.") }
    defer { Darwin.close(descriptor) }
    var before = stat()
    guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
          before.st_size > 0, before.st_size <= 20 * 1_024 * 1_024 else {
        throw fail("REFERENCE_INVALID", "The image reference must be a regular image file no larger than 20 MiB.")
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count == 0 { break }
        guard count > 0, data.count + count <= 20 * 1_024 * 1_024 else {
            throw fail("REFERENCE_INVALID", "The image reference could not be read within its allowed bounds.")
        }
        data.append(contentsOf: buffer.prefix(count))
    }
    var after = stat()
    guard fstat(descriptor, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino,
          before.st_size == after.st_size, data.count == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
          let type = CGImageSourceGetType(source) as String?,
          ["public.png", "public.jpeg", "com.compuserve.gif", "org.webmproject.webp", "public.webp"].contains(type) else {
        throw fail("REFERENCE_INVALID", "The image reference changed or is not a supported image.")
    }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func nativeImageIdentity(_ value: String?) -> String? {
    guard let value, let url = URLComponents(string: value), url.scheme?.lowercased() == "https",
          url.host?.lowercased() == "flow-content.google", url.user == nil, url.password == nil,
          url.port == nil || url.port == 443,
          url.percentEncodedPath.range(of: #"^/image/[A-Za-z0-9_-]{1,256}$"#, options: .regularExpression) != nil else { return nil }
    return "https://flow-content.google\(url.percentEncodedPath)"
}

func imageFingerprint(_ image: CGImage) throws -> String {
    var pixels = [UInt8](repeating: 0, count: 64 * 64 * 4)
    let made = pixels.withUnsafeMutableBytes { bytes -> Bool in
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: bytes.baseAddress, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 64 * 4,
                                      space: space, bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: 64, height: 64))
        return true
    }
    guard made else { throw fail("REFERENCE_UNVERIFIABLE", "The visible ingredient could not be fingerprinted.") }
    return SHA256.hash(data: Data(pixels)).map { String(format: "%02x", $0) }.joined()
}

struct ChooserSession {
    let pid: pid_t
    let window: AXUIElement
    let document: String
    let expires: TimeInterval
}

func matchesOpenPanel(_ role: String?, _ identifier: String?, _ owner: pid_t, _ pid: pid_t, _ depth: Int) -> Bool {
    owner == pid && depth >= 0 && depth <= 6 && role == "AXSheet" && identifier == "open-panel"
}

func matchesGoToWindow(_ role: String?, _ identifier: String?, _ owner: pid_t, _ pid: pid_t, _ origin: Bool) -> Bool {
    owner == pid && origin && role == "AXSheet" && identifier == "GoToWindow"
}

func geometry(_ element: AXUIElement) -> [String: Any] {
    var result: [String: Any] = [:]
    if let value = attribute(element, "AXPosition"), CFGetTypeID(value) == AXValueGetTypeID() {
        var point = CGPoint.zero
        if AXValueGetValue(value as! AXValue, .cgPoint, &point), point.x.isFinite, point.y.isFinite {
            result["position"] = ["x": point.x, "y": point.y]
        }
    }
    if let value = attribute(element, "AXSize"), CFGetTypeID(value) == AXValueGetTypeID() {
        var size = CGSize.zero
        if AXValueGetValue(value as! AXValue, .cgSize, &size), size.width.isFinite, size.height.isFinite {
            result["size"] = ["width": size.width, "height": size.height]
        }
    }
    return result
}

func rectangle(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, "AXPosition"), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(element, "AXSize"), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
          point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite,
          dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}

func labelCrop(_ rect: CGRect, _ window: CGRect) throws -> CGRect {
    guard rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite, rect.height.isFinite,
          rect.width >= 1, rect.height >= 1, rect.width <= 1_000, rect.height <= 100,
          window.contains(rect), window.contains(rect.integral) else {
        throw fail("LABEL_BOUNDS_INVALID", "The label must fit within a small visible Flow control.")
    }
    return rect.integral
}

func systemLabelImage(_ crop: CGRect) throws -> CGImage {
    let files = FileManager.default
    let directory = files.temporaryDirectory.appendingPathComponent("flow-label-\(UUID().uuidString)", isDirectory: true)
    try files.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(at: directory) }
    let destination = directory.appendingPathComponent("label.png")
    guard files.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw fail("LABEL_CAPTURE_FAILED", "The private label capture could not be prepared.")
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-t", "png", "-R", "\(Int(crop.minX)),\(Int(crop.minY)),\(Int(crop.width)),\(Int(crop.height))", destination.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let deadline = ProcessInfo.processInfo.systemUptime + 4
    while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline && !Task.isCancelled { Thread.sleep(forTimeInterval: 0.01) }
    guard !process.isRunning else {
        process.terminate()
        let terminationDeadline = ProcessInfo.processInfo.systemUptime + 0.2
        while process.isRunning && ProcessInfo.processInfo.systemUptime < terminationDeadline { Thread.sleep(forTimeInterval: 0.01) }
        if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        throw fail("LABEL_CAPTURE_FAILED", "The private label capture timed out.")
    }
    guard process.terminationStatus == 0, !Task.isCancelled else {
        throw fail("LABEL_CAPTURE_FAILED", "The visible Flow label could not be captured.")
    }
    try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    let attributes = try files.attributesOfItem(atPath: destination.path)
    guard let length = attributes[.size] as? NSNumber, length.intValue > 0, length.intValue <= 8_388_608 else {
        throw fail("LABEL_CAPTURE_FAILED", "The private label image exceeds its allowed bounds.")
    }
    let data = try Data(contentsOf: destination, options: .mappedIfSafe)
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
          image.width <= 4_000, image.height <= 400 else {
        throw fail("LABEL_CAPTURE_FAILED", "The private label image is unavailable or exceeds its allowed bounds.")
    }
    try files.removeItem(at: destination)
    return image
}

enum LabelPhase: String {
    case captureStart = "capture_start"
    case captureDone = "capture_done"
    case ocrStart = "ocr_start"
    case ocrDone = "ocr_done"
}

final class LabelCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<[String], Error>?
    private var phase = LabelPhase.captureStart
    private var request: VNRecognizeTextRequest?

    init(_ continuation: CheckedContinuation<[String], Error>) { self.continuation = continuation }

    func mark(_ phase: LabelPhase, request: VNRecognizeTextRequest? = nil) {
        lock.lock()
        self.phase = phase
        if let request { self.request = request }
        lock.unlock()
    }

    func failure(_ error: BrowserError) {
        lock.lock()
        let phase = self.phase
        lock.unlock()
        finish(.failure(fail(error.code, "\(error.message) (phase: \(phase.rawValue))")))
    }

    func timeout() {
        lock.lock()
        let pending = continuation
        continuation = nil
        let phase = self.phase
        let request = self.request
        lock.unlock()
        guard let pending else { return }
        pending.resume(throwing: fail("LABEL_CAPTURE_FAILED", "The visible Flow label read timed out. (phase: \(phase.rawValue))"))
        request?.cancel()
    }

    func finish(_ result: Result<[String], BrowserError>) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        guard let pending else { return }
        switch result {
        case .success(let texts): pending.resume(returning: texts)
        case .failure(let error): pending.resume(throwing: error)
        }
    }
}

func recognizeLabel(_ image: CGImage, capture: LabelCapture? = nil) throws -> [String] {
    let request = VNRecognizeTextRequest()
    request.revision = VNRecognizeTextRequestRevision1
    request.recognitionLevel = .fast
    request.usesCPUOnly = true
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    capture?.mark(.ocrStart, request: request)
    do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch {
        throw fail("LABEL_UNAVAILABLE", "The visible Flow label could not be recognized.")
    }
    capture?.mark(.ocrDone)
    var budget = 512
    var texts: [String] = []
    for observation in (request.results ?? []).prefix(8) {
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.5 else { continue }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= budget else {
            throw fail("LABEL_UNAVAILABLE", "The visible Flow label exceeds its allowed bounds.")
        }
        budget -= text.utf16.count
        texts.append(text)
    }
    guard !texts.isEmpty else { throw fail("LABEL_UNAVAILABLE", "The visible Flow label could not be recognized.") }
    return texts
}

func ocrSelfTest() async throws -> [String: Any] {
    guard let context = CGContext(data: nil, width: 640, height: 112, bitsPerComponent: 8, bytesPerRow: 640 * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw fail("SELF_TEST_FAILED", "The synthetic label bitmap could not be created.")
    }
    context.scaleBy(x: 2, y: 2)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 320, height: 56))
    let attributes = [kCTFontAttributeName: CTFontCreateWithName("HelveticaNeue" as CFString, 24, nil),
                      kCTForegroundColorAttributeName: CGColor(gray: 0, alpha: 1)] as CFDictionary
    let text = CFAttributedStringCreate(nil, "Omni 1.2 Flash" as CFString, attributes)!
    context.textPosition = CGPoint(x: 8, y: 17)
    CTLineDraw(CTLineCreateWithAttributedString(text), context)
    guard let image = context.makeImage() else { throw fail("SELF_TEST_FAILED", "The synthetic label image could not be created.") }
    let texts = try await Task.detached(priority: .userInitiated) { try recognizeLabel(image) }.value
    guard texts.count == 1, texts[0].filter({ !$0.isWhitespace }) == "Omni1.2Flash" else {
        throw fail("SELF_TEST_FAILED", "The synthetic label was not recognized correctly.")
    }
    return ["ocrSelfTest": "ok", "texts": texts]
}

@MainActor
final class Browser {
    var nodes: [String: AXUIElement] = [:]
    var snapshotPID: pid_t?
    var snapshotWindow: AXUIElement?
    var snapshotTime = Date.distantPast
    var chooserSession: ChooserSession?
    var chooserPanelCounts = (sheets: 0, childPanels: 0, ownerMismatch: 0)
    var chooserPathEvidence = ""

    func invalidate() {
        nodes.removeAll()
        snapshotPID = nil
        snapshotWindow = nil
    }

    func application(_ pid: pid_t) throws -> AXUIElement {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == "com.google.Chrome" else {
            throw fail("TARGET_NOT_ALLOWED", "Target must be a running Google Chrome process.")
        }
        guard AXIsProcessTrusted() else { throw fail("ACCESSIBILITY_REQUIRED", "Accessibility permission is required.") }
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 1)
        return element
    }

    func window(_ application: AXUIElement) throws -> AXUIElement {
        if let window = elementAttribute(application, "AXFocusedWindow") ?? elementAttribute(application, "AXMainWindow") {
            return window
        }
        if let windows = attribute(application, "AXWindows") as? [AXUIElement], let first = windows.first { return first }
        throw fail("WINDOW_UNAVAILABLE", "Chrome has no accessible window.")
    }

    func flowDocument(_ window: AXUIElement) throws -> String {
        func checked(_ value: String) throws -> String {
            guard flowURL(value) else {
                throw fail("TARGET_CHANGED", "The Chrome window is no longer showing Flow.")
            }
            return value
        }
        let document = stringAttribute(window, "AXDocument")
        if let document, flowURL(document) { return document }
        if credentialURL(document) { throw fail("PROTECTED_CONTENT", "Credential manager windows are excluded.") }
        var owner: pid_t = 0
        guard AXUIElementGetPid(window, &owner) == .success else {
            throw fail("FLOW_WINDOW_UNAVAILABLE", "The Flow window is unavailable.")
        }
        let role = stringAttribute(window, "AXRole") ?? ""
        let subrole = stringAttribute(window, "AXSubrole") ?? ""
        if role == "AXSheet" || role == "AXDialog" || subrole == "AXDialog" || subrole == "AXSystemDialog" {
            var parent = elementAttribute(window, "AXParent")
            for _ in 0..<4 {
                guard let candidate = parent else { break }
                var parentOwner: pid_t = 0
                guard AXUIElementGetPid(candidate, &parentOwner) == .success, parentOwner == owner else { break }
                if stringAttribute(candidate, "AXRole") == "AXWindow",
                   let value = stringAttribute(candidate, "AXDocument"), !value.isEmpty { return try checked(value) }
                parent = elementAttribute(candidate, "AXParent")
            }
        }
        if let document, !document.isEmpty { return try checked(document) }
        // Inspect structure and document URLs only until Flow is proved; no unrelated page text.
        var queue: [(AXUIElement, Int)] = [(window, 0)]
        var visited: Set<AXIdentity> = []
        var offset = 0
        let deadline = Date().addingTimeInterval(1.5)
        while offset < queue.count && offset < 512 && Date() < deadline {
            let (element, depth) = queue[offset]
            offset += 1
            var elementOwner: pid_t = 0
            guard AXUIElementGetPid(element, &elementOwner) == .success, elementOwner == owner,
                  visited.insert(AXIdentity(element)).inserted else { continue }
            if stringAttribute(element, "AXRole") == "AXWebArea" {
                guard let value = stringAttribute(element, "AXURL") ?? stringAttribute(element, "AXDocument"), !value.isEmpty else { break }
                return try checked(value)
            }
            if depth < 16, let children = attribute(element, "AXChildren") as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(max(0, 512 - queue.count)).map { ($0, depth + 1) })
            }
        }
        throw fail("FLOW_WINDOW_UNAVAILABLE", "The Chrome window does not expose a verified Flow document.")
    }

    @discardableResult
    func checkWindow(_ window: AXUIElement) throws -> String {
        let document = try flowDocument(window)
        let title = (stringAttribute(window, "AXTitle") ?? "").lowercased()
        guard !title.contains("google password manager"), !title.contains("менеджер паролей") else {
            throw fail("PROTECTED_CONTENT", "Credential manager windows are excluded.")
        }
        return document
    }

    func flowWindows(_ application: AXUIElement) throws -> (windows: [(AXUIElement, String)], checked: Int, duplicates: Int) {
        let windows = attribute(application, "AXWindows") as? [AXUIElement] ?? []
        guard windows.count <= 128 else { throw fail("WINDOW_LIMIT", "Chrome has too many windows to inspect safely.") }
        let distinctWindows = uniqueAXElements(windows)
        var owner: pid_t = 0
        guard AXUIElementGetPid(application, &owner) == .success else { throw fail("WINDOW_UNAVAILABLE", "Chrome windows are unavailable.") }
        var matches: [(AXUIElement, String)] = []
        for window in distinctWindows {
            var windowOwner: pid_t = 0
            guard AXUIElementGetPid(window, &windowOwner) == .success, windowOwner == owner else { continue }
            if let url = stringAttribute(window, "AXDocument"), flowURL(url) { matches.append((window, url)) }
        }
        return (matches, windows.count, windows.count - distinctWindows.count)
    }

    func locateFlow() throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw fail("ACCESSIBILITY_REQUIRED", "Accessibility permission is required.") }
        guard !screenLocked() else { throw fail("SCREEN_LOCKED", "Unlock the screen before locating Flow.") }
        let applications = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated && $0.bundleIdentifier == "com.google.Chrome" }
        guard applications.count <= 16 else { throw fail("WINDOW_LIMIT", "Too many Chrome processes are running to inspect safely.") }
        var candidates: [[String: Any]] = []
        var checked = 0
        var duplicateWindowEntries = 0
        for running in applications {
            let (windows, count, duplicates) = try flowWindows(application(running.processIdentifier))
            checked += count
            duplicateWindowEntries += duplicates
            guard checked <= 128 else { throw fail("WINDOW_LIMIT", "Too many Chrome windows are open to inspect safely.") }
            for (window, url) in windows {
                guard flowURL(stringAttribute(window, "AXDocument")) else {
                    throw fail("TARGET_CHANGED", "A Flow window changed while it was being located.")
                }
                let title = String((stringAttribute(window, "AXTitle") ?? "").prefix(1_000))
                guard flowURL(stringAttribute(window, "AXDocument")) else {
                    throw fail("TARGET_CHANGED", "A Flow window changed while it was being located.")
                }
                candidates.append([
                    "pid": running.processIdentifier,
                    "title": title,
                    "documentURL": String(url.prefix(4_000)),
                ])
            }
        }
        return ["candidates": candidates, "chromeProcesses": applications.count, "windowsChecked": checked,
                "duplicateWindowEntries": duplicateWindowEntries]
    }

    func focusFlow(_ pid: pid_t) async throws -> [String: Any] {
        chooserSession = nil
        invalidate()
        let application = try application(pid)
        guard !screenLocked() else { throw fail("SCREEN_LOCKED", "Unlock the screen before focusing Flow.") }
        let (matches, _, _) = try flowWindows(application)
        guard matches.count < 2 else { throw fail("WINDOW_AMBIGUOUS", "More than one Flow window is open in this Chrome process.") }
        guard let (target, _) = matches.first else { throw fail("FLOW_WINDOW_UNAVAILABLE", "No accessible Flow window is open in this Chrome process.") }
        guard flowURL(stringAttribute(target, "AXDocument")), !screenLocked(),
              let running = NSRunningApplication(processIdentifier: pid), running.bundleIdentifier == "com.google.Chrome" else {
            throw fail("FOCUS_CHANGED", "The Flow window changed before it could be focused.")
        }
        for name in ["AXMain", "AXFocused"] {
            var settable = DarwinBoolean(false)
            if AXUIElementIsAttributeSettable(target, name as CFString, &settable) == .success, settable.boolValue {
                guard !screenLocked(), flowURL(stringAttribute(target, "AXDocument")),
                      AXUIElementSetAttributeValue(target, name as CFString, kCFBooleanTrue) == .success else {
                    throw fail("FOCUS_FAILED", "Chrome could not select its verified Flow window.")
                }
            }
        }
        guard AXUIElementPerformAction(target, "AXRaise" as CFString) == .success,
              running.activate(options: []) else { throw fail("FOCUS_FAILED", "Chrome could not focus its Flow window.") }
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        repeat {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
               let focused = elementAttribute(application, "AXFocusedWindow"), CFEqual(focused, target),
               flowURL(stringAttribute(focused, "AXDocument")) { return ["focused": true] }
            try await Task.sleep(for: .milliseconds(50))
        } while ProcessInfo.processInfo.systemUptime < deadline
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw fail("FRONTMOST_NOT_CONFIRMED", "Chrome did not confirm that it became the frontmost application.")
        }
        throw fail("FOCUSED_WINDOW_CHANGED", "Chrome did not confirm the selected Flow window as focused.")
    }

    func mutationTarget(_ pid: pid_t) throws -> (AXUIElement, AXUIElement) {
        let application = try application(pid)
        guard !screenLocked() else { throw fail("SCREEN_LOCKED", "Unlock the screen before controlling Chrome.") }
        guard let frontmost = NSWorkspace.shared.frontmostApplication, frontmost.processIdentifier == pid,
              frontmost.bundleIdentifier == "com.google.Chrome" else {
            throw fail("FOCUS_CHANGED", "Google Chrome must remain the frontmost target application.")
        }
        let activeWindow = try window(application)
        try checkWindow(activeWindow)
        if let focused = elementAttribute(application, "AXFocusedUIElement"), protectedAncestor(focused) {
            throw fail("PROTECTED_CONTENT", "Protected input fields are excluded.")
        }
        return (application, activeWindow)
    }

    func snapshot(_ pid: pid_t) throws -> [String: Any] {
        invalidate()
        let application = try application(pid)
        guard !screenLocked() else { throw fail("SCREEN_LOCKED", "Unlock the screen before reading Chrome.") }
        let activeWindow = try window(application)
        let verifiedDocument = try checkWindow(activeWindow)
        let prefix = UUID().uuidString
        let deadline = Date().addingTimeInterval(5)
        var textBudget = 1_048_576
        var output: [[String: Any]] = []
        var visited: Set<AXIdentity> = []
        var truncated = false
        var attempted = 0, maxDepthAttempted = 0, maxDepthEmitted = 0, limitSkips = 0
        var ownerErrors = 0, ownerMismatches = 0, sensitiveSkips = 0
        var hashRepeats = 0, equalRepeats = 0, unequalHashCollisions = 0, hashComparisonsOmitted = 0
        var hashBuckets: [CFHashCode: [AXUIElement]] = [:]
        var hashVisitCounts: [CFHashCode: Int] = [:]
        var hashElementsStored = 0
        var ownerErrorCodes: [String: Int] = [:], childrenErrorCodes: [String: Int] = [:]
        var childrenErrors = 0, childrenTypeMismatches = 0, webareaCount = 0
        var webareas: [[String: Any]] = []

        func countError(_ error: AXError, _ counts: inout [String: Int]) {
            let key = String(error.rawValue)
            counts[counts[key] != nil || counts.count < 16 ? key : "other", default: 0] += 1
        }

        func clipped(_ text: String) -> String? {
            guard textBudget > 0 else { truncated = true; return nil }
            let maximum = min(4_000, textBudget)
            let value = String(decoding: text.utf8.prefix(maximum), as: UTF8.self)
            if text.utf8.count > maximum { truncated = true }
            textBudget -= value.utf8.count
            return value.isEmpty ? nil : value
        }
        // Numeric outcomes: 0 emitted, 1 limit, 2 owner error, 3 owner mismatch, 4 equal identity, 5 sensitive.
        func visit(_ element: AXUIElement, _ parent: String?, _ depth: Int) throws -> Int {
            attempted += 1
            maxDepthAttempted = max(maxDepthAttempted, depth)
            guard output.count < 4_000, depth <= 48, Date() < deadline else {
                truncated = true; limitSkips += 1; return 1
            }
            var owner: pid_t = 0
            let ownerResult = AXUIElementGetPid(element, &owner)
            guard ownerResult == .success else {
                ownerErrors += 1; countError(ownerResult, &ownerErrorCodes); return 2
            }
            guard owner == pid else { ownerMismatches += 1; return 3 }
            let hash = CFHash(element)
            let bucket = hashBuckets[hash] ?? []
            let repeated = !visited.insert(AXIdentity(element)).inserted
            if hashVisitCounts[hash, default: 0] > 0 {
                hashRepeats += 1
                if bucket.isEmpty { hashComparisonsOmitted += 1 }
                else if bucket.contains(where: { CFEqual($0, element) }) { equalRepeats += 1 }
                else { unequalHashCollisions += 1 }
            }
            hashVisitCounts[hash, default: 0] += 1
            if hashElementsStored < 4_096, bucket.count < 8, !bucket.contains(where: { CFEqual($0, element) }) {
                hashBuckets[hash, default: []].append(element)
                hashElementsStored += 1
            }
            // Hash collisions remain diagnostic; only CFEqual identity suppresses traversal.
            guard !repeated else { return 4 }
            let role = stringAttribute(element, "AXRole") ?? "AXUnknown"
            if role == "AXWebArea" { webareaCount += 1 }
            if role == "AXWebArea", let url = stringAttribute(element, "AXURL") ?? stringAttribute(element, "AXDocument") {
                guard flowURL(url) else { throw fail("TARGET_CHANGED", "The accessible Chrome document is no longer Flow.") }
            }
            guard !isSensitiveInput(element) else { sensitiveSkips += 1; return 5 }
            let id = "\(prefix):\(output.count)"
            let sensitiveInput = isSensitiveInput(element)
            var node: [String: Any] = ["id": id, "role": role, "enabled": attribute(element, "AXEnabled") as? Bool ?? false]
            if let parent { node["parent"] = parent }
            for (attributeName, name) in [("AXTitle", "title"), ("AXDescription", "description"), ("AXValue", "value"), ("AXValueDescription", "valueDescription")] {
                if !(name == "value" && sensitiveInput), let raw = stringAttribute(element, attributeName), let value = clipped(raw) {
                    node[name] = value
                }
            }
            if let selected = attribute(element, "AXSelected"), CFGetTypeID(selected) == CFBooleanGetTypeID() {
                node["selected"] = CFBooleanGetValue((selected as! CFBoolean))
            }
            if role == "AXMenuItem", let mark = stringAttribute(element, "AXMenuItemMarkChar"),
               let value = clipped(String(mark.prefix(8))) { node["mark"] = value }
            if role == "AXLink", let url = stringAttribute(element, "AXURL"), flowURL(url),
               let value = clipped(url) { node["url"] = value }
            if role == "AXImage", let identity = nativeImageIdentity(stringAttribute(element, "AXURL")) {
                node["imageURL"] = identity
            }
            if role == "AXSlider" {
                if let minimum = numberAttribute(element, "AXMinValue") { node["minValue"] = minimum }
                if let maximum = numberAttribute(element, "AXMaxValue") { node["maxValue"] = maximum }
            }
            var actionNames: CFArray?
            if AXUIElementCopyActionNames(element, &actionNames) == .success {
                node["actions"] = actionNames as? [String] ?? []
            } else { node["actions"] = [String]() }
            var settable = DarwinBoolean(false)
            node["settable"] = AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable) == .success
                && settable.boolValue && !sensitiveInput
            node.merge(geometry(element)) { _, new in new }
            nodes[id] = element
            output.append(node)
            maxDepthEmitted = max(maxDepthEmitted, depth)
            var childrenValue: CFTypeRef?
            let childrenResult = AXUIElementCopyAttributeValue(element, "AXChildren" as CFString, &childrenValue)
            let children = childrenResult == .success ? childrenValue as? [AXUIElement] : nil
            if childrenResult != .success { childrenErrors += 1; countError(childrenResult, &childrenErrorCodes) }
            let childrenTypeMismatch = childrenResult == .success && children == nil
            if childrenTypeMismatch { childrenTypeMismatches += 1 }
            let webareaIndex: Int?
            if role == "AXWebArea", webareas.count < 4 {
                webareaIndex = webareas.count
                webareas.append(["depth": depth, "directChildCount": children?.count ?? -1,
                                 "childrenErrorCode": childrenResult.rawValue, "childrenTypeMismatch": childrenTypeMismatch,
                                 "directChildren": [[String: Int]]()])
            } else { webareaIndex = nil }
            var directChildren: [[String: Int]] = []
            if let children {
                for (index, child) in children.enumerated() {
                    if output.count >= 4_000 || Date() >= deadline { truncated = true; break }
                    let before = output.count
                    let outcome = try visit(child, id, depth + 1)
                    if webareaIndex != nil, directChildren.count < 32 {
                        directChildren.append(["index": index, "outcome": outcome, "emitted": output.count - before])
                    }
                }
            }
            if let webareaIndex { webareas[webareaIndex]["directChildren"] = directChildren }
            return 0
        }
        do {
            _ = try visit(activeWindow, nil, 0)
            try checkWindow(activeWindow)
        } catch { invalidate(); throw error }
        snapshotPID = pid
        snapshotWindow = activeWindow
        snapshotTime = Date()
        var windowSummary = geometry(activeWindow)
        windowSummary["title"] = clipped(stringAttribute(activeWindow, "AXTitle") ?? "") ?? ""
        windowSummary["role"] = "AXWindow"
        if let id = output.first?["id"] { windowSummary["id"] = id }
        var result: [String: Any] = ["pid": pid, "window": windowSummary, "nodes": output, "truncated": truncated]
        result["diagnostics"] = [
            "attempted": attempted, "emitted": output.count, "maxDepthAttempted": maxDepthAttempted,
            "maxDepthEmitted": maxDepthEmitted, "limitSkips": limitSkips,
            "ownerErrors": ownerErrors, "ownerErrorCodes": ownerErrorCodes, "ownerMismatches": ownerMismatches,
            "hashRepeats": hashRepeats, "equalRepeats": equalRepeats, "unequalHashCollisions": unequalHashCollisions,
            "hashComparisonsOmitted": hashComparisonsOmitted, "hashElementsStored": hashElementsStored,
            "sensitiveSkips": sensitiveSkips, "childrenErrors": childrenErrors,
            "childrenErrorCodes": childrenErrorCodes, "childrenTypeMismatches": childrenTypeMismatches,
            "webareaCount": webareaCount, "webareas": webareas,
        ]
        if let url = clipped(verifiedDocument) { result["documentURL"] = url }
        do { try checkWindow(activeWindow) } catch { invalidate(); throw error }
        return result
    }

    func node(_ id: String, _ pid: pid_t, _ activeWindow: AXUIElement) throws -> AXUIElement {
        guard snapshotPID == pid, let recordedWindow = snapshotWindow, CFEqual(recordedWindow, activeWindow),
              Date().timeIntervalSince(snapshotTime) < 60, let element = nodes[id] else {
            throw fail("STALE_NODE", "Take a fresh snapshot before using this node.")
        }
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid, !protectedAncestor(element) else {
            throw fail("PROTECTED_CONTENT", "Protected or unavailable nodes are excluded.")
        }
        var ancestor: AXUIElement? = element
        var contained = false
        for _ in 0...48 {
            guard let candidate = ancestor else { break }
            if CFEqual(candidate, activeWindow) { contained = true; break }
            ancestor = elementAttribute(candidate, "AXParent")
        }
        guard contained else { throw fail("STALE_NODE", "Take a fresh snapshot before using this node.") }
        return element
    }

    func chooserContext(_ session: ChooserSession) throws -> AXUIElement {
        guard ProcessInfo.processInfo.systemUptime < session.expires else { throw fail("CHOOSER_EXPIRED", "The file chooser request expired.") }
        let app = try application(session.pid)
        guard !screenLocked(), NSWorkspace.shared.frontmostApplication?.processIdentifier == session.pid else {
            throw fail("FOCUS_CHANGED", "Google Chrome must remain frontmost while choosing the reference.")
        }
        var owner: pid_t = 0
        guard AXUIElementGetPid(session.window, &owner) == .success, owner == session.pid,
              stringAttribute(session.window, "AXDocument") == session.document, flowURL(session.document),
              let windows = attribute(app, "AXWindows") as? [AXUIElement], windows.contains(where: { CFEqual($0, session.window) }) else {
            throw fail("TARGET_CHANGED", "The originating Flow window changed while choosing the reference.")
        }
        return app
    }

    func ownedTree(_ root: AXUIElement, _ pid: pid_t, limit: Int = 512, depth: Int = 16) -> [AXUIElement] {
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var visited: Set<AXIdentity> = []
        var output: [AXUIElement] = []
        var index = 0
        while index < queue.count && output.count < limit {
            let (element, level) = queue[index]
            index += 1
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
                  visited.insert(AXIdentity(element)).inserted, !isProtected(element) else { continue }
            output.append(element)
            if level < depth {
                for name in ["AXChildren", "AXSheets"] {
                    if let children = attribute(element, name) as? [AXUIElement] {
                        queue.append(contentsOf: children.prefix(max(0, limit - queue.count)).map { ($0, level + 1) })
                    }
                }
            }
        }
        return output
    }

    func openPanel(_ session: ChooserSession) throws -> AXUIElement? {
        _ = try chooserContext(session)
        let sheets = attribute(session.window, "AXSheets") as? [AXUIElement] ?? []
        var matches: [AXUIElement] = []
        var mismatches = 0
        var childPanels = 0
        func consider(_ element: AXUIElement, _ depth: Int) -> Bool {
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == session.pid else {
                mismatches += 1
                return false
            }
            if matchesOpenPanel(stringAttribute(element, "AXRole"), stringAttribute(element, "AXIdentifier"), owner, session.pid, depth),
               !matches.contains(where: { CFEqual($0, element) }) { matches.append(element) }
            return true
        }
        for sheet in sheets.prefix(128) { _ = consider(sheet, 1) }
        var queue: [(AXUIElement, Int)] = [(session.window, 0)]
        var visited: Set<AXIdentity> = []
        var index = 0
        while index < queue.count && index < 128 {
            let (element, depth) = queue[index]
            index += 1
            guard visited.insert(AXIdentity(element)).inserted, consider(element, depth) else { continue }
            if depth > 0, stringAttribute(element, "AXRole") == "AXSheet", stringAttribute(element, "AXIdentifier") == "open-panel" { childPanels += 1 }
            if depth < 6, let children = attribute(element, "AXChildren") as? [AXUIElement] {
                queue.append(contentsOf: children.prefix(max(0, 128 - queue.count)).map { ($0, depth + 1) })
            }
        }
        chooserPanelCounts = (sheets.count, childPanels, mismatches)
        guard matches.count <= 1 else { throw fail("CHOOSER_AMBIGUOUS", "More than one reference chooser is open.") }
        return matches.first
    }

    func unavailableChooser(_ session: ChooserSession) throws -> BrowserError {
        let app = try chooserContext(session)
        let windows = attribute(app, "AXWindows") as? [AXUIElement] ?? []
        let panels = windows.prefix(128).filter { element in
            var owner: pid_t = 0
            return AXUIElementGetPid(element, &owner) == .success && owner == session.pid
                && stringAttribute(element, "AXIdentifier") == "open-panel"
        }
        let mainMatches = elementAttribute(app, "AXMainWindow").map { CFEqual($0, session.window) } ?? false
        let focused = elementAttribute(app, "AXFocusedWindow")
        let safeRoles: Set<String> = ["AXWindow", "AXSheet", "AXDialog", "AXApplication", "AXGroup", "AXUnknown"]
        func safeRole(_ element: AXUIElement?) -> String {
            guard let element, let role = stringAttribute(element, "AXRole"), safeRoles.contains(role) else { return "AXOther" }
            return role
        }
        var chain: [String] = []
        var current = panels.first ?? focused
        var origin = false
        for _ in 0..<6 {
            guard let element = current else { break }
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == session.pid else { chain.append("AXOther/other"); break }
            let id = stringAttribute(element, "AXIdentifier") ?? ""
            chain.append("\(safeRole(element))/\(id == "open-panel" || id == "GoToWindow" ? id : "other")")
            if CFEqual(element, session.window) { origin = true; break }
            current = elementAttribute(element, "AXParent")
        }
        let counts = chooserPanelCounts
        return fail("CHOOSER_UNAVAILABLE", "The verified Flow file chooser is unavailable. (sheets:\(counts.sheets), childPanels:\(counts.childPanels), appPanels:\(panels.count), ownerMismatch:\(counts.ownerMismatch), mainMatches:\(mainMatches), focusedRole:\(safeRole(focused)), parentChain:\(chain.joined(separator: ">")), origin:\(origin))")
    }

    func chooserKey(_ code: CGKeyCode, _ flags: CGEventFlags, _ session: ChooserSession) throws {
        guard (code == keyCodes["g"] && flags == [.maskCommand, .maskShift]) || (code == keyCodes["enter"] && flags.isEmpty) else {
            throw fail("INVALID_REQUEST", "The reference chooser shortcut is not allowed.")
        }
        func verifiedPanel() throws -> AXUIElement {
            let app = try chooserContext(session)
            guard let panel = try openPanel(session) else { throw fail("CHOOSER_UNAVAILABLE", "The verified reference chooser is unavailable.") }
            if let focused = elementAttribute(app, "AXFocusedUIElement"), protectedAncestor(focused) {
                throw fail("PROTECTED_CONTENT", "Protected chooser inputs are excluded.")
            }
            return panel
        }
        let panel = try verifiedPanel()
        if code == keyCodes["g"] {
            var settable = DarwinBoolean(false)
            if AXUIElementIsAttributeSettable(panel, "AXFocused" as CFString, &settable) == .success, settable.boolValue {
                guard AXUIElementSetAttributeValue(panel, "AXFocused" as CFString, kCFBooleanTrue) == .success else {
                    throw fail("FOCUS_FAILED", "Chrome could not focus its verified reference chooser.")
                }
            }
        }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw fail("ACTION_FAILED", "The reference chooser keyboard events are unavailable.")
        }
        down.flags = flags
        up.flags = []
        _ = try verifiedPanel()
        down.post(tap: .cghidEventTap)
        do { _ = try verifiedPanel() } catch {
            up.post(tap: .cghidEventTap)
            throw error
        }
        up.post(tap: .cghidEventTap)
    }

    func chooserAncestry(_ element: AXUIElement, _ session: ChooserSession, _ panel: AXUIElement) -> (origin: Bool, goTo: AXUIElement?, chain: String) {
        var current: AXUIElement? = element
        var goTo: AXUIElement?
        var chain: [String] = []
        let roles: Set<String> = ["AXSheet", "AXWindow", "AXApplication", "AXGroup", "AXTextField", "AXComboBox"]
        for _ in 0..<12 {
            guard let candidate = current else { break }
            var owner: pid_t = 0
            guard AXUIElementGetPid(candidate, &owner) == .success, owner == session.pid else { chain.append("AXOther/other"); break }
            let role = stringAttribute(candidate, "AXRole") ?? ""
            let identifier = stringAttribute(candidate, "AXIdentifier") ?? ""
            let safeID = ["open-panel", "GoToWindow", "PathTextField"].contains(identifier) ? identifier : "other"
            chain.append("\(roles.contains(role) ? role : "AXOther")/\(safeID)")
            if role == "AXSheet", identifier == "GoToWindow" { goTo = candidate }
            if CFEqual(candidate, panel) || CFEqual(candidate, session.window) { return (true, goTo, chain.joined(separator: ">")) }
            current = elementAttribute(candidate, "AXParent")
        }
        return (false, goTo, chain.joined(separator: ">"))
    }

    func chooserPathField(_ session: ChooserSession, _ panel: AXUIElement) throws -> AXUIElement? {
        let app = try chooserContext(session)
        var candidates: [AXUIElement] = []
        var rootedGoTo = 0
        var appGoTo = 0
        var appProved = 0
        var focusedPath = false
        var focusedOrigin = false
        var focusedChain = ""
        func addSheet(_ sheet: AXUIElement, origin: Bool) {
            var owner: pid_t = 0
            guard AXUIElementGetPid(sheet, &owner) == .success,
                  matchesGoToWindow(stringAttribute(sheet, "AXRole"), stringAttribute(sheet, "AXIdentifier"), owner, session.pid, origin) else { return }
            for field in ownedTree(sheet, session.pid, limit: 128, depth: 8) {
                if stringAttribute(field, "AXIdentifier") == "PathTextField", stringAttribute(field, "AXRole") == "AXTextField",
                   !candidates.contains(where: { CFEqual($0, field) }) { candidates.append(field) }
            }
        }
        var seen: [AXUIElement] = []
        for root in [panel, session.window] {
            for element in ownedTree(root, session.pid, limit: 128, depth: 6) {
                if stringAttribute(element, "AXRole") == "AXSheet", stringAttribute(element, "AXIdentifier") == "GoToWindow",
                   !seen.contains(where: { CFEqual($0, element) }) {
                    seen.append(element)
                    rootedGoTo += 1
                    addSheet(element, origin: true)
                }
            }
        }
        for element in (attribute(app, "AXWindows") as? [AXUIElement] ?? []).prefix(128) {
            var owner: pid_t = 0
            guard AXUIElementGetPid(element, &owner) == .success, owner == session.pid,
                  stringAttribute(element, "AXIdentifier") == "GoToWindow" else { continue }
            appGoTo += 1
            let proof = chooserAncestry(element, session, panel)
            if proof.origin { appProved += 1; addSheet(element, origin: true) }
        }
        if let focused = elementAttribute(app, "AXFocusedUIElement"), stringAttribute(focused, "AXIdentifier") == "PathTextField",
           stringAttribute(focused, "AXRole") == "AXTextField" {
            focusedPath = true
            let proof = chooserAncestry(focused, session, panel)
            focusedOrigin = proof.origin && proof.goTo != nil
            focusedChain = proof.chain
            if focusedOrigin, !candidates.contains(where: { CFEqual($0, focused) }) { candidates.append(focused) }
        }
        chooserPathEvidence = "rootedGoTo:\(rootedGoTo), appGoTo:\(appGoTo), appProved:\(appProved), fields:\(candidates.count), focusedPath:\(focusedPath), focusedOrigin:\(focusedOrigin), parentChain:\(focusedChain)"
        guard candidates.count <= 1 else { throw fail("CHOOSER_AMBIGUOUS", "More than one verified chooser path field is available.") }
        return candidates.first
    }

    func selectedReference(_ panel: AXUIElement, _ session: ChooserSession, _ path: String) -> Bool {
        var selected: [AXUIElement] = []
        for element in ownedTree(panel, session.pid) {
            if attribute(element, "AXSelected") as? Bool == true { selected.append(element) }
            for name in ["AXSelectedChildren", "AXSelectedRows", "AXSelectedCells"] {
                if let values = attribute(element, name) as? [AXUIElement] { selected.append(contentsOf: values.prefix(32)) }
            }
        }
        var paths: Set<String> = []
        for root in selected.prefix(64) {
            for element in ownedTree(root, session.pid, limit: 32, depth: 4) {
                for name in ["AXURL", "AXDocument"] {
                    guard let text = stringAttribute(element, name), let url = URLComponents(string: text),
                          url.scheme == "file", url.host == nil || url.host == "" || url.host == "localhost",
                          url.query == nil, url.fragment == nil, let file = url.url else { continue }
                    paths.insert(file.standardizedFileURL.path)
                }
                if let value = attribute(element, "AXValue"), CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL, url.isFileURL {
                    paths.insert(url.standardizedFileURL.path)
                }
            }
        }
        return selectedReferencePaths(paths, path)
    }

    func chooseFile(_ pid: pid_t, _ path: String, _ digest: String) async throws -> [String: Any] {
        guard let session = chooserSession, session.pid == pid else { throw fail("CHOOSER_NOT_ARMED", "Open the observed Flow upload control before choosing a reference.") }
        chooserSession = nil
        defer { invalidate() }
        _ = try chooserContext(session)
        guard try referenceDigest(path) == digest else { throw fail("REFERENCE_CHANGED", "The image reference no longer matches its verified digest.") }
        var initialPanel = try openPanel(session)
        let panelDeadline = ProcessInfo.processInfo.systemUptime + 3
        while initialPanel == nil && ProcessInfo.processInfo.systemUptime < panelDeadline {
            try await Task.sleep(for: .milliseconds(50))
            initialPanel = try openPanel(session)
        }
        guard initialPanel != nil else { throw try unavailableChooser(session) }
        try chooserKey(keyCodes["g"]!, [.maskCommand, .maskShift], session)
        var pathField: AXUIElement?
        let goToDeadline = ProcessInfo.processInfo.systemUptime + 3
        repeat {
            guard let panel = try openPanel(session) else { throw fail("CHOOSER_UNAVAILABLE", "The reference chooser closed before the path could be entered.") }
            pathField = try chooserPathField(session, panel)
            if pathField != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        } while ProcessInfo.processInfo.systemUptime < goToDeadline
        guard let field = pathField else {
            throw fail("CHOOSER_PATH_UNAVAILABLE", "The reference chooser did not expose its exact path field. (\(chooserPathEvidence))")
        }
        let app = try chooserContext(session)
        var settable = DarwinBoolean(false)
        guard !isSensitiveInput(field), AXUIElementIsAttributeSettable(field, "AXValue" as CFString, &settable) == .success,
              settable.boolValue, AXUIElementSetAttributeValue(field, "AXValue" as CFString, path as CFString) == .success,
              stringAttribute(field, "AXValue") == path else { throw fail("CHOOSER_PATH_UNAVAILABLE", "The reference chooser could not confirm its exact path.") }
        if let focused = elementAttribute(app, "AXFocusedUIElement"), !CFEqual(focused, field) {
            guard AXUIElementSetAttributeValue(field, "AXFocused" as CFString, kCFBooleanTrue) == .success else {
                throw fail("CHOOSER_PATH_UNAVAILABLE", "The reference chooser could not focus its path field.")
            }
        }
        guard let focused = elementAttribute(app, "AXFocusedUIElement"), CFEqual(focused, field) else {
            throw fail("CHOOSER_PATH_UNAVAILABLE", "The reference chooser did not confirm path field focus.")
        }
        try chooserKey(keyCodes["enter"]!, [], session)
        var confirmedPanel: AXUIElement?
        var openButton: AXUIElement?
        let selectedDeadline = ProcessInfo.processInfo.systemUptime + 4
        repeat {
            guard let panel = try openPanel(session) else { throw fail("CHOOSER_UNAVAILABLE", "The reference chooser closed before selection was verified.") }
            let tree = ownedTree(panel, pid)
            if !tree.contains(where: { stringAttribute($0, "AXIdentifier") == "GoToWindow" }), selectedReference(panel, session, path),
               let button = tree.first(where: { stringAttribute($0, "AXIdentifier") == "OKButton" && stringAttribute($0, "AXRole") == "AXButton" }),
               attribute(button, "AXEnabled") as? Bool == true {
                confirmedPanel = panel
                openButton = button
                break
            }
            try await Task.sleep(for: .milliseconds(50))
        } while ProcessInfo.processInfo.systemUptime < selectedDeadline
        guard let panel = confirmedPanel, let button = openButton else {
            throw fail("CHOOSER_SELECTION_UNVERIFIABLE", "The chooser did not expose the exact selected reference URL.")
        }
        _ = try chooserContext(session)
        guard let current = try openPanel(session), CFEqual(current, panel), selectedReference(current, session, path),
              try referenceDigest(path) == digest, AXUIElementPerformAction(button, "AXPress" as CFString) == .success else {
            throw fail("REFERENCE_CHANGED", "The verified reference selection changed before it could be opened.")
        }
        let closedDeadline = ProcessInfo.processInfo.systemUptime + 3
        repeat {
            if try openPanel(session) == nil {
                guard try referenceDigest(path) == digest else { throw fail("REFERENCE_CHANGED", "The image reference changed while it was being opened.") }
                return ["chosen": true, "sha256": digest]
            }
            try await Task.sleep(for: .milliseconds(50))
        } while ProcessInfo.processInfo.systemUptime < closedDeadline
        throw fail("CHOOSER_DID_NOT_CLOSE", "The chooser did not confirm opening the verified reference.")
    }

    func ingredientFingerprint(_ element: AXUIElement, _ pid: pid_t, _ activeWindow: AXUIElement) async throws -> [String: Any] {
        guard stringAttribute(element, "AXRole") == "AXButton", stringAttribute(element, "AXTitle") == "Ингредиент",
              let bounds = rectangle(element), let windowBounds = rectangle(activeWindow) else {
            throw fail("REFERENCE_UNVERIFIABLE", "The observed Flow ingredient is unavailable.")
        }
        for child in ownedTree(element, pid, limit: 32, depth: 4) {
            if let identity = nativeImageIdentity(stringAttribute(child, "AXURL")) {
                let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
                try checkFrontmost(pid)
                guard CFEqual(try window(application(pid)), activeWindow), rectangle(element) == bounds else {
                    throw fail("REFERENCE_UNVERIFIABLE", "The Flow ingredient changed while it was being read.")
                }
                return ["fingerprint": digest, "method": "native-image"]
            }
        }
        guard CGPreflightScreenCaptureAccess(), bounds.width > 12, bounds.height > 12,
              bounds.width <= 112, bounds.height <= 112 else { throw fail("REFERENCE_UNVERIFIABLE", "The ingredient thumbnail cannot be read within its allowed bounds.") }
        let crop = try labelCrop(bounds.insetBy(dx: 6, dy: 6), windowBounds)
        guard crop.width <= 100, crop.height <= 100 else { throw fail("REFERENCE_UNVERIFIABLE", "The ingredient thumbnail exceeds its allowed bounds.") }
        try checkFrontmost(pid)
        let fingerprint = try await Task.detached(priority: .userInitiated) { try imageFingerprint(systemLabelImage(crop)) }.value
        try checkFrontmost(pid)
        guard CFEqual(try window(application(pid)), activeWindow), rectangle(element) == bounds, rectangle(activeWindow) == windowBounds else {
            throw fail("REFERENCE_UNVERIFIABLE", "The Flow ingredient changed while it was being read.")
        }
        return ["fingerprint": fingerprint, "method": "screen"]
    }

    func readLabel(_ element: AXUIElement, _ pid: pid_t, _ activeWindow: AXUIElement) async throws -> [String: Any] {
        guard CGPreflightScreenCaptureAccess() else { throw fail("SCREEN_CAPTURE_REQUIRED", "Screen Recording permission is required to read the visible label.") }
        guard stringAttribute(element, "AXRole") == "AXPopUpButton",
              let bounds = rectangle(element), let windowBounds = rectangle(activeWindow) else {
            throw fail("LABEL_UNAVAILABLE", "The observed popup label is unavailable.")
        }
        let crop = try labelCrop(bounds, windowBounds)
        try checkFrontmost(pid)
        guard CFEqual(try window(application(pid)), activeWindow) else {
            throw fail("FOCUS_CHANGED", "The Flow window changed before reading its label.")
        }
        let texts: [String] = try await withCheckedThrowingContinuation { continuation in
            let capture = LabelCapture(continuation)
            let task = Task.detached(priority: .userInitiated) {
            do {
                capture.mark(.captureStart)
                let image = try systemLabelImage(crop)
                capture.mark(.captureDone)
                guard !Task.isCancelled else { return }
                let texts = try recognizeLabel(image, capture: capture)
                guard !Task.isCancelled else { return }
                capture.finish(.success(texts))
            } catch let error as BrowserError {
                capture.failure(error)
            } catch {
                capture.failure(fail("LABEL_CAPTURE_FAILED", "The visible Flow label could not be captured."))
            }
            }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 30) {
                task.cancel()
                capture.timeout()
            }
        }
        try checkFrontmost(pid)
        guard CFEqual(try window(application(pid)), activeWindow), rectangle(element) == bounds, rectangle(activeWindow) == windowBounds else {
            throw fail("FOCUS_CHANGED", "The Flow label changed while it was being read.")
        }
        return ["texts": texts, "method": "vision", "capture": "system"]
    }

    func execute(_ request: Request) async throws -> [String: Any] {
        if request.command == "status" {
            let frontmost = NSWorkspace.shared.frontmostApplication
            var result: [String: Any] = ["trusted": AXIsProcessTrusted(), "locked": screenLocked(),
                                         "screenCaptureTrusted": CGPreflightScreenCaptureAccess(),
                                         "frontmostChrome": frontmost?.bundleIdentifier == "com.google.Chrome"]
            if let frontmost { result["frontmostPID"] = frontmost.processIdentifier }
            return result
        }
        if request.command == "requestPermission" {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            return ["trusted": AXIsProcessTrustedWithOptions(options)]
        }
        if request.command == "requestScreenPermission" { return ["screenCaptureTrusted": CGRequestScreenCaptureAccess()] }
        if request.command == "locateFlow" { return try locateFlow() }
        let pid = request.pid!
        if request.command == "focusFlow" { return try await focusFlow(pid) }
        if request.command == "snapshot" { return try snapshot(pid) }
        if request.command == "chooseFile" {
            return try await chooseFile(pid, request.fields["path"] as! String, request.fields["sha256"] as! String)
        }
        let (appElement, activeWindow) = try mutationTarget(pid)
        if request.command == "readIngredientFingerprint" {
            return try await ingredientFingerprint(node(request.fields["nodeId"] as! String, pid, activeWindow), pid, activeWindow)
        }
        if request.command != "press" { chooserSession = nil }
        defer { invalidate() }
        switch request.command {
        case "readLabel":
            return try await readLabel(node(request.fields["nodeId"] as! String, pid, activeWindow), pid, activeWindow)
        case "activateAccessibility":
            try checkFrontmost(pid)
            let manual = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            if manual == .success { return ["activated": true, "method": "AXManualAccessibility"] }
            if manual == .attributeUnsupported {
                try checkFrontmost(pid)
                if AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) == .success {
                    return ["activated": true, "method": "AXEnhancedUserInterface"]
                }
            }
            throw fail("ACCESSIBILITY_ACTIVATION_FAILED", "Chrome could not enable its native accessibility tree.")
        case "press":
            chooserSession = nil
            let element = try node(request.fields["nodeId"] as! String, pid, activeWindow)
            guard attribute(element, "AXEnabled") as? Bool != false else {
                throw fail("ACTION_FAILED", "Chrome could not press this node.")
            }
            let upload = stringAttribute(element, "AXRole") == "AXButton" && stringAttribute(element, "AXTitle") == "Загрузить"
            let document = upload ? try checkWindow(activeWindow) : ""
            try checkFrontmost(pid)
            guard AXUIElementPerformAction(element, "AXPress" as CFString) == .success else {
                throw fail("ACTION_FAILED", "Chrome could not press this node.")
            }
            if upload {
                chooserSession = ChooserSession(pid: pid, window: activeWindow, document: document,
                                                expires: ProcessInfo.processInfo.systemUptime + 30)
            }
        case "focus":
            let element = try node(request.fields["nodeId"] as! String, pid, activeWindow)
            var settable = DarwinBoolean(false)
            guard attribute(element, "AXEnabled") as? Bool != false,
                  AXUIElementIsAttributeSettable(element, "AXFocused" as CFString, &settable) == .success, settable.boolValue else {
                throw fail("FOCUS_FAILED", "Chrome cannot focus this node.")
            }
            try checkFrontmost(pid)
            guard AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue) == .success,
                  let focused = elementAttribute(appElement, "AXFocusedUIElement"), CFEqual(focused, element) else {
                throw fail("FOCUS_FAILED", "Chrome did not confirm focus on this node.")
            }
            try checkFrontmost(pid)
        case "setValue":
            let element = try node(request.fields["nodeId"] as! String, pid, activeWindow)
            var settable = DarwinBoolean(false)
            guard attribute(element, "AXEnabled") as? Bool != false,
                  AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable) == .success, settable.boolValue else {
                throw fail("ACTION_FAILED", "Chrome could not set this node's value.")
            }
            let value: CFTypeRef
            if stringAttribute(element, "AXRole") == "AXSlider" {
                value = try sliderValue(request.fields["value"] as! String,
                                        numberAttribute(element, "AXMinValue"), numberAttribute(element, "AXMaxValue"))
            } else { value = request.fields["value"] as! CFString }
            try checkFrontmost(pid)
            guard AXUIElementSetAttributeValue(element, "AXValue" as CFString, value) == .success else {
                throw fail("ACTION_FAILED", "Chrome could not set this node's value.")
            }
        case "key":
            let key = request.fields["key"] as! String
            let modifiers = request.fields["modifiers"] as? [String] ?? []
            var flags: CGEventFlags = []
            if modifiers.contains("command") { flags.insert(.maskCommand) }
            if modifiers.contains("shift") { flags.insert(.maskShift) }
            try postKey(keyCodes[key]!, flags, pid)
        case "text":
            let application = try application(pid)
            guard let focused = elementAttribute(application, "AXFocusedUIElement"), !protectedAncestor(focused),
                  ["AXTextField", "AXTextArea", "AXComboBox"].contains(stringAttribute(focused, "AXRole") ?? "") else {
                throw fail("INPUT_UNAVAILABLE", "Focus an editable, unprotected Chrome field before typing.")
            }
            let units = Array((request.fields["text"] as! String).utf16)
            // ponytail: direct Unicode key events; no clipboard or browser scripting dependency.
            var offset = 0
            while offset < units.count {
                var end = min(offset + 64, units.count)
                if end < units.count && (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
                try checkFrontmost(pid)
                guard let current = elementAttribute(application, "AXFocusedUIElement"), CFEqual(current, focused),
                      !protectedAncestor(current) else {
                    throw fail("FOCUS_CHANGED", "The editable Chrome field changed while typing.")
                }
                try checkFrontmost(pid)
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                    throw fail("ACTION_FAILED", "Keyboard events are unavailable.")
                }
                let chunk = Array(units[offset..<end])
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                down.postToPid(pid)
                up.postToPid(pid)
                offset = end
            }
        default: throw fail("INVALID_REQUEST", "Unsupported command.")
        }
        return ["performed": true]
    }

    func checkFrontmost(_ pid: pid_t) throws {
        guard !screenLocked(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw fail("FOCUS_CHANGED", "Google Chrome must remain the frontmost target application.")
        }
        try checkWindow(window(application(pid)))
    }

    func postKey(_ code: CGKeyCode, _ flags: CGEventFlags, _ pid: pid_t) throws {
        try checkFrontmost(pid)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw fail("ACTION_FAILED", "Keyboard events are unavailable.")
        }
        down.flags = flags
        up.flags = flags
        down.postToPid(pid)
        up.postToPid(pid)
    }
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), data.count <= 8 * 1_048_576 else {
        FileHandle.standardOutput.write(Data("{\"id\":null,\"error\":{\"code\":\"RESPONSE_TOO_LARGE\",\"message\":\"Response exceeds allowed bounds.\"}}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func selfTest() throws {
    var checks = 0
    func expect(_ object: Any, _ accepted: Bool) throws {
        do {
            _ = try Request(object)
            guard accepted else { throw fail("SELF_TEST_FAILED", "Invalid request was accepted.") }
        } catch let error as BrowserError {
            if accepted || error.code == "SELF_TEST_FAILED" { throw fail("SELF_TEST_FAILED", "Protocol validation check failed.") }
        }
        checks += 1
    }
    try expect(["id": "test", "command": "status"], true)
    // Constructors and CF identity checks are local; no accessibility messaging.
    let fixtureURL = "https://flow.google.com/project/window-fixture"
    let windowFixtures = [(AXUIElementCreateApplication(42), fixtureURL),
                          (AXUIElementCreateApplication(42), fixtureURL),
                          (AXUIElementCreateApplication(43), fixtureURL)]
    guard uniqueAXElements(Array(windowFixtures.prefix(2)).map { $0.0 }).count == 1,
          uniqueAXElements(windowFixtures.map { $0.0 }).count == 2 else {
        throw fail("SELF_TEST_FAILED", "Window identity deduplication merged distinct same-URL entries or kept duplicates.")
    }
    checks += 1
    guard matchesOpenPanel("AXSheet", "open-panel", 42, 42, 1),
          matchesOpenPanel("AXSheet", "open-panel", 42, 42, 6),
          !matchesOpenPanel("AXSheet", "open-panel", 99, 42, 1),
          !matchesOpenPanel("AXWindow", "open-panel", 42, 42, 1),
          !matchesOpenPanel("AXSheet", "other", 42, 42, 1),
          !matchesOpenPanel("AXSheet", "open-panel", 42, 42, 7) else {
        throw fail("SELF_TEST_FAILED", "Pinned reference chooser matching boundaries failed.")
    }
    checks += 1
    guard matchesGoToWindow("AXSheet", "GoToWindow", 42, 42, true),
          !matchesGoToWindow("AXSheet", "GoToWindow", 42, 42, false),
          !matchesGoToWindow("AXSheet", "GoToWindow", 99, 42, true),
          !matchesGoToWindow("AXWindow", "GoToWindow", 42, 42, true),
          !matchesGoToWindow("AXSheet", "other", 42, 42, true) else {
        throw fail("SELF_TEST_FAILED", "Pinned chooser path field matching boundaries failed.")
    }
    checks += 1
    try expect(["id": "test", "command": "chooseFile", "pid": 42, "path": "/tmp/reference.png", "sha256": String(repeating: "a", count: 64)], true)
    try expect(["id": "test", "command": "chooseFile", "pid": 42, "path": "relative.png", "sha256": String(repeating: "a", count: 64)], false)
    try expect(["id": "test", "command": "chooseFile", "pid": 42, "path": "/tmp/reference.txt", "sha256": String(repeating: "a", count: 64)], false)
    try expect(["id": "test", "command": "chooseFile", "pid": 42, "path": "/tmp/reference.png", "sha256": "invalid"], false)
    try expect(["id": "test", "command": "chooseFile", "pid": 42, "path": "/tmp/reference.png", "sha256": String(repeating: "a", count: 64), "skipVerify": true], false)
    try expect(["id": "test", "command": "readIngredientFingerprint", "pid": 42, "nodeId": "snapshot:0"], true)
    try expect(["id": "test", "command": "readIngredientFingerprint", "pid": 42], false)
    guard validReferencePath("/tmp/референс 1.PNG"), !validReferencePath("/tmp/../reference.png"),
          !validReferencePath("/tmp/reference\n.png"), validSHA256(String(repeating: "f", count: 64)),
          !validSHA256(String(repeating: "F", count: 64)),
          nativeImageIdentity("https://flow-content.google/image/media_123?signature=private") == "https://flow-content.google/image/media_123",
          nativeImageIdentity("https://flow-content.google.evil.example/image/media_123") == nil,
          nativeImageIdentity("https://flow-content.google/image/%2Fprivate") == nil,
          selectedReferencePaths(["/tmp/reference.png", "/tmp"], "/tmp/reference.png"),
          !selectedReferencePaths(["/tmp/other.png"], "/tmp/reference.png"),
          !selectedReferencePaths(["/tmp/reference.png", "/tmp/other.png"], "/tmp/reference.png") else {
        throw fail("SELF_TEST_FAILED", "Reference path, identity, or selection boundaries failed.")
    }
    checks += 1
    let fixtureDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("flow-reference-self-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: fixtureDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: fixtureDirectory) }
    let fixture = fixtureDirectory.appendingPathComponent("reference.png")
    let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=")!
    try png.write(to: fixture)
    let expectedDigest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
    guard try referenceDigest(fixture.path) == expectedDigest else { throw fail("SELF_TEST_FAILED", "Reference digest check failed.") }
    checks += 1
    let symbolic = fixtureDirectory.appendingPathComponent("symlink.png")
    try FileManager.default.createSymbolicLink(atPath: symbolic.path, withDestinationPath: fixture.path)
    do {
        _ = try referenceDigest(symbolic.path)
        throw fail("SELF_TEST_FAILED", "Symbolic reference was accepted.")
    } catch let error as BrowserError { if error.code != "REFERENCE_INVALID" { throw error } }
    checks += 1
    let invalidImage = fixtureDirectory.appendingPathComponent("invalid.png")
    try Data("not an image".utf8).write(to: invalidImage)
    do {
        _ = try referenceDigest(invalidImage.path)
        throw fail("SELF_TEST_FAILED", "Invalid image reference was accepted.")
    } catch let error as BrowserError { if error.code != "REFERENCE_INVALID" { throw error } }
    checks += 1
    try expect(["id": "test", "command": "requestScreenPermission"], true)
    try expect(["id": "test", "command": "requestScreenPermission", "pid": 42], false)
    try expect(["id": "test", "command": "readLabel", "pid": 42, "nodeId": "snapshot:0"], true)
    try expect(["id": "test", "command": "readLabel", "pid": 42], false)
    try expect(["id": "test", "command": "locateFlow"], true)
    try expect(["id": "test", "command": "locateFlow", "pid": 42], false)
    try expect(["id": "test", "command": "focusFlow", "pid": 42], true)
    try expect(["id": "test", "command": "focusFlow"], false)
    try expect(["id": "test", "command": "focus", "pid": 42, "nodeId": "snapshot:0"], true)
    try expect(["id": "test", "command": "focus", "pid": 42], false)
    try expect(["id": 1, "command": "snapshot", "pid": 42], true)
    try expect(["id": "test", "command": "activateAccessibility", "pid": 42], true)
    try expect(["id": "test", "command": "activateAccessibility"], false)
    try expect(["id": "test", "command": "activateAccessibility", "pid": 42, "attribute": "AXEnhancedUserInterface"], false)
    try expect(["id": true, "command": "status"], false)
    try expect(["id": "test", "command": "snapshot", "pid": true], false)
    try expect(["id": "test", "command": "snapshot", "pid": 1.5], false)
    try expect(["id": "test", "command": "snapshot", "pid": -1], false)
    try expect(["id": "test", "command": "unknown"], false)
    try expect(["id": "test", "command": "status", "extra": true], false)
    try expect(["id": "test", "command": "press", "pid": 42, "nodeId": ""], false)
    try expect(["id": "test", "command": "key", "pid": 42, "key": "a", "modifiers": ["command"]], true)
    try expect(["id": "test", "command": "key", "pid": 42, "key": "g", "modifiers": ["command", "shift"]], true)
    try expect(["id": "test", "command": "key", "pid": 42, "key": "q", "modifiers": ["command"]], false)
    try expect(["id": "test", "command": "key", "pid": 42, "key": "tab", "modifiers": ["shift", "shift"]], false)
    try expect(["id": "test", "command": "text", "pid": 42, "text": String(repeating: "x", count: 20_001)], false)
    guard credentialURL("chrome://password-manager/passwords"), credentialURL("https://passwords.google.com/"),
          !credentialURL("https://labs.google/fx/tools/flow") else { throw fail("SELF_TEST_FAILED", "Protected URL check failed.") }
    checks += 1
    let cropWindow = CGRect(x: 0, y: 0, width: 1_200, height: 800)
    _ = try labelCrop(CGRect(x: 20, y: 20, width: 300, height: 40), cropWindow)
    checks += 1
    for rect in [CGRect(x: 0, y: 0, width: 1_001, height: 40), CGRect(x: 0, y: 0, width: 300, height: 101),
                 CGRect(x: -1, y: 0, width: 300, height: 40), CGRect(x: 20, y: 20, width: 0, height: 40)] {
        do {
            _ = try labelCrop(rect, cropWindow)
            throw fail("SELF_TEST_FAILED", "Invalid label crop was accepted.")
        } catch let error as BrowserError {
            if error.code != "LABEL_BOUNDS_INVALID" { throw error }
        }
        checks += 1
    }
    for text in ["0", "1.5", "100", "-0.5"] {
        _ = try sliderValue(text, -1, 100)
        checks += 1
    }
    for text in ["NaN", "Infinity", "1e2", "01", "+1", " 1", "1 ", "101", "-2"] {
        do {
            _ = try sliderValue(text, -1, 100)
            throw fail("SELF_TEST_FAILED", "Invalid slider value was accepted.")
        } catch let error as BrowserError {
            if error.code != "INVALID_VALUE" { throw error }
        }
        checks += 1
    }
    do {
        _ = try sliderValue("1", nil, 100)
        throw fail("SELF_TEST_FAILED", "Slider with unknown bounds was accepted.")
    } catch let error as BrowserError {
        if error.code != "INVALID_VALUE" { throw error }
    }
    checks += 1
    guard flowURL("https://flow.google.com/"), flowURL("https://flow.google.com:443/project/test"),
          !flowURL("http://flow.google.com/"), !flowURL("https://flow.google.com.evil.example/"),
          !flowURL("https://yandex.ru/"), !flowURL("https://flow.google.com@evil.example/"),
          !flowURL("https://user:secret@flow.google.com/"), !flowURL("https://flow.google.com:8080/"),
          !flowURL("chrome://password-manager/") else { throw fail("SELF_TEST_FAILED", "Flow URL boundary check failed.") }
    checks += 1
    emit(["selfTest": "ok", "checks": checks])
}

func readProtocolLine() async -> String? {
    await Task.detached(priority: .userInitiated) { readLine() }.value
}

if CommandLine.arguments.dropFirst() == ["--self-test"] {
    do { try selfTest() } catch { emit(["selfTest": "failed"]); exit(1) }
} else if CommandLine.arguments.dropFirst() == ["--ocr-self-test"] {
    do { emit(try await ocrSelfTest()) } catch let error as BrowserError {
        emit(["ocrSelfTest": "failed", "error": ["code": error.code, "message": error.message]])
        exit(1)
    } catch { emit(["ocrSelfTest": "failed"]); exit(1) }
} else if CommandLine.arguments.count != 1 {
    FileHandle.standardError.write(Data("Usage: flow-browser [--self-test|--ocr-self-test]\n".utf8))
    exit(64)
} else {
    let browser = Browser()
    while let line = await readProtocolLine() {
        var id: Any = NSNull()
        do {
            guard line.utf8.count <= 65_536, let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) else {
                throw fail("INVALID_REQUEST", "Expected a bounded JSON request line.")
            }
            if let object = object as? [String: Any], let candidate = object["id"], Request.validID(candidate) { id = candidate }
            let request = try Request(object)
            emit(["id": request.id, "result": try await browser.execute(request)])
        } catch let error as BrowserError {
            emit(["id": id, "error": ["code": error.code, "message": error.message]])
        } catch {
            emit(["id": id, "error": ["code": "REQUEST_FAILED", "message": "The native browser request failed."]])
        }
    }
}
