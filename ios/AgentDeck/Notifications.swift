import Foundation
import UserNotifications

@MainActor
final class NotificationManager: NSObject, ObservableObject {
    static let shared = NotificationManager()

    private var authorized = false

    /// The session currently visible on screen (if any) and whether the app is foreground.
    var openSessionId: String?
    var isForeground = true

    func requestAuthorizationIfNeeded() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined || settings.authorizationStatus == .authorized else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                Task { @MainActor in self.authorized = granted }
            }
        }
    }

    /// Decide whether an incoming event warrants a local notification, and fire it.
    func handle(sessionId: String, stored: StoredEvent, session: SessionInfo?) {
        let shouldNotify: Bool
        var body: String

        switch stored.event {
        case .turnEnd(let result, let isError, _, _):
            shouldNotify = true
            body = isError ? "Turn ended with an error." : (result ?? "Agent finished — needs input.")
        case .permissionDenied(let toolName, let detail):
            shouldNotify = true
            body = "Blocked: \(toolName)" + (detail.map { " — \($0)" } ?? "")
        case .status(let state):
            shouldNotify = (state == .error || state == .exited)
            body = "Session \(state.label.lowercased())."
        default:
            shouldNotify = false
            body = ""
        }

        guard shouldNotify else { return }

        // Skip if app is foreground AND that session is currently open.
        if isForeground && openSessionId == sessionId { return }

        let platform = session?.platform.displayName ?? "Agent"
        let title = session?.title ?? "Session"

        fire(title: "\(platform) · \(title)", body: snippet(body))
    }

    private func snippet(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 140 { return trimmed }
        return String(trimmed.prefix(140)) + "…"
    }

    private func fire(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
