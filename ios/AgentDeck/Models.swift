import Foundation
import SwiftUI

// MARK: - Platform

enum Platform: String, Codable, CaseIterable, Identifiable {
    case claude
    case cursor
    case codex

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .cursor: return "Cursor"
        case .codex: return "Codex"
        }
    }

    var accent: Color {
        switch self {
        case .claude: return .orange
        case .cursor: return .blue
        case .codex: return .green
        }
    }
}

// MARK: - SessionState

enum SessionState: String, Codable {
    case starting
    case idle
    case working
    case error
    case exited
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionState(rawValue: raw) ?? .unknown
    }

    var label: String { rawValue.capitalized }

    var color: Color {
        switch self {
        case .starting: return .yellow
        case .idle: return .secondary
        case .working: return .green
        case .error: return .red
        case .exited: return .gray
        case .unknown: return .secondary
        }
    }

    var isBusy: Bool { self == .working || self == .starting }
}

// MARK: - PermissionMode

enum PermissionMode: String, Codable, CaseIterable, Identifiable {
    case acceptEdits
    case plan
    case bypassPermissions
    case manual

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .acceptEdits: return "Accept Edits"
        case .plan: return "Plan"
        case .bypassPermissions: return "Bypass Permissions"
        case .manual: return "Manual"
        }
    }
}

// MARK: - SessionInfo

struct SessionInfo: Codable, Identifiable, Equatable {
    let id: String
    let platform: Platform
    var title: String
    var cwd: String
    var state: SessionState
    var permissionMode: String
    var nativeSessionId: String?
    var createdAt: Double
    var updatedAt: Double
    var lastText: String?

    static func == (lhs: SessionInfo, rhs: SessionInfo) -> Bool {
        lhs.id == rhs.id
            && lhs.title == rhs.title
            && lhs.state == rhs.state
            && lhs.updatedAt == rhs.updatedAt
            && lhs.lastText == rhs.lastText
    }
}

// MARK: - AgentEvent

/// Normalized agent event. Decodes on the `kind` discriminator; unknown kinds
/// decode to `.unknown` rather than throwing.
enum AgentEvent: Equatable {
    case text(String)
    case thinking(String)
    case toolStart(toolUseId: String?, toolName: String, input: JSONValue?)
    case toolEnd(toolUseId: String?, output: String?, isError: Bool)
    case user(String)
    case turnEnd(result: String?, isError: Bool, costUsd: Double?, durationMs: Double?)
    case status(SessionState)
    case permissionDenied(toolName: String, detail: String?)
    case error(String)
    case unknown(String)

    private enum CodingKeys: String, CodingKey {
        case kind, text, toolUseId, toolName, input, output, isError
        case result, costUsd, durationMs, state, detail, message
    }
}

extension AgentEvent: Codable {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? c.decode(String.self, forKey: .kind)) ?? "unknown"
        switch kind {
        case "text":
            self = .text((try? c.decode(String.self, forKey: .text)) ?? "")
        case "thinking":
            self = .thinking((try? c.decode(String.self, forKey: .text)) ?? "")
        case "tool.start":
            self = .toolStart(
                toolUseId: try? c.decodeIfPresent(String.self, forKey: .toolUseId),
                toolName: (try? c.decode(String.self, forKey: .toolName)) ?? "tool",
                input: try? c.decodeIfPresent(JSONValue.self, forKey: .input)
            )
        case "tool.end":
            self = .toolEnd(
                toolUseId: try? c.decodeIfPresent(String.self, forKey: .toolUseId),
                output: try? c.decodeIfPresent(String.self, forKey: .output),
                isError: (try? c.decodeIfPresent(Bool.self, forKey: .isError)) ?? false
            )
        case "user":
            self = .user((try? c.decode(String.self, forKey: .text)) ?? "")
        case "turn.end":
            self = .turnEnd(
                result: try? c.decodeIfPresent(String.self, forKey: .result),
                isError: (try? c.decodeIfPresent(Bool.self, forKey: .isError)) ?? false,
                costUsd: try? c.decodeIfPresent(Double.self, forKey: .costUsd),
                durationMs: try? c.decodeIfPresent(Double.self, forKey: .durationMs)
            )
        case "status":
            let s = (try? c.decode(SessionState.self, forKey: .state)) ?? .unknown
            self = .status(s)
        case "permission.denied":
            self = .permissionDenied(
                toolName: (try? c.decode(String.self, forKey: .toolName)) ?? "tool",
                detail: try? c.decodeIfPresent(String.self, forKey: .detail)
            )
        case "error":
            self = .error((try? c.decode(String.self, forKey: .message)) ?? "")
        default:
            self = .unknown(kind)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let t):
            try c.encode("text", forKey: .kind); try c.encode(t, forKey: .text)
        case .thinking(let t):
            try c.encode("thinking", forKey: .kind); try c.encode(t, forKey: .text)
        case .toolStart(let id, let name, let input):
            try c.encode("tool.start", forKey: .kind)
            try c.encodeIfPresent(id, forKey: .toolUseId)
            try c.encode(name, forKey: .toolName)
            try c.encodeIfPresent(input, forKey: .input)
        case .toolEnd(let id, let output, let isError):
            try c.encode("tool.end", forKey: .kind)
            try c.encodeIfPresent(id, forKey: .toolUseId)
            try c.encodeIfPresent(output, forKey: .output)
            try c.encode(isError, forKey: .isError)
        case .user(let t):
            try c.encode("user", forKey: .kind); try c.encode(t, forKey: .text)
        case .turnEnd(let result, let isError, let cost, let dur):
            try c.encode("turn.end", forKey: .kind)
            try c.encodeIfPresent(result, forKey: .result)
            try c.encode(isError, forKey: .isError)
            try c.encodeIfPresent(cost, forKey: .costUsd)
            try c.encodeIfPresent(dur, forKey: .durationMs)
        case .status(let s):
            try c.encode("status", forKey: .kind); try c.encode(s.rawValue, forKey: .state)
        case .permissionDenied(let name, let detail):
            try c.encode("permission.denied", forKey: .kind)
            try c.encode(name, forKey: .toolName)
            try c.encodeIfPresent(detail, forKey: .detail)
        case .error(let m):
            try c.encode("error", forKey: .kind); try c.encode(m, forKey: .message)
        case .unknown(let kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

// MARK: - StoredEvent

struct StoredEvent: Codable, Identifiable, Equatable {
    let seq: Int
    let ts: Double
    let event: AgentEvent

    var id: Int { seq }
}

// MARK: - JSONValue (for arbitrary tool input)

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    /// Compact single-line rendering for transcript rows.
    var compact: String {
        switch self {
        case .string(let s): return s
        case .number(let n):
            return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        case .null: return "null"
        case .array(let a): return "[" + a.map { $0.compact }.joined(separator: ", ") + "]"
        case .object(let o):
            let parts = o.map { "\($0.key): \($0.value.compact)" }
            return "{" + parts.joined(separator: ", ") + "}"
        }
    }
}

// MARK: - Server messages

/// A single decoded server message. Envelope type is switched on `type`.
enum ServerMessage {
    case welcome(serverName: String, version: String, platforms: [String: PlatformAvailability], sessions: [SessionInfo])
    case sessions([SessionInfo])
    case sessionCreated(SessionInfo)
    case sessionUpdated(SessionInfo)
    case sessionRemoved(String)
    case event(sessionId: String, stored: StoredEvent)
    case history(sessionId: String, events: [StoredEvent])
    case dirs([String])
    case error(message: String, inReplyTo: String?)
    case pong
    case unknown(String)

    private struct Envelope: Decodable {
        let type: String
        let serverName: String?
        let version: String?
        let platforms: [String: PlatformAvailability]?
        let sessions: [SessionInfo]?
        let session: SessionInfo?
        let sessionId: String?
        let seq: Int?
        let ts: Double?
        let event: AgentEvent?
        let events: [StoredEvent]?
        let message: String?
        let inReplyTo: String?
        let dirs: [String]?
    }

    init(data: Data) throws {
        let e = try JSONDecoder().decode(Envelope.self, from: data)
        switch e.type {
        case "welcome":
            self = .welcome(
                serverName: e.serverName ?? "Bridge",
                version: e.version ?? "",
                platforms: e.platforms ?? [:],
                sessions: e.sessions ?? []
            )
        case "sessions":
            self = .sessions(e.sessions ?? [])
        case "session.created":
            if let s = e.session { self = .sessionCreated(s) } else { self = .unknown(e.type) }
        case "session.updated":
            if let s = e.session { self = .sessionUpdated(s) } else { self = .unknown(e.type) }
        case "session.removed":
            self = .sessionRemoved(e.sessionId ?? "")
        case "event":
            if let sid = e.sessionId, let seq = e.seq, let ev = e.event {
                self = .event(sessionId: sid, stored: StoredEvent(seq: seq, ts: e.ts ?? 0, event: ev))
            } else {
                self = .unknown(e.type)
            }
        case "history":
            self = .history(sessionId: e.sessionId ?? "", events: e.events ?? [])
        case "dirs":
            self = .dirs(e.dirs ?? [])
        case "error":
            self = .error(message: e.message ?? "unknown error", inReplyTo: e.inReplyTo)
        case "pong":
            self = .pong
        default:
            self = .unknown(e.type)
        }
    }
}

struct PlatformAvailability: Codable {
    let available: Bool
}
