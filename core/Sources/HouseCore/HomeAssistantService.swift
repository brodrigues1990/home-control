import Foundation

/// A Home Assistant server on the local network (or anywhere it is reachable), through its
/// REST API with a long-lived access token. Lights and switches become lamps, `climate`
/// entities become air conditioners and temperature sensors can stand in for an AC's room
/// reading. A WebSocket subscription tells the hub the moment something changes.
@MainActor
public final class HomeAssistantService: DeviceService {
    public let id = "homeassistant"
    public let title = "Home Assistant"
    public var onChange: (() -> Void)?

    struct Config: Codable {
        var url: String
        var token: String
        var name: String?
        var version: String?
    }

    private let vault: SecretStore
    private var config: Config?
    private let session: URLSession
    private var socket: URLSessionWebSocketTask?
    private var socketRetry: Task<Void, Never>?
    /// Each climate entity's own names for the panel's fan speeds, modes and swing, from the last read.
    private var fanNames: [String: [String: String]] = [:]
    private var modeNames: [String: [String: String]] = [:]
    private var swingNames: [String: [String]] = [:]
    /// The entities linked in the plan: only their changes are worth a read.
    private var watched: Set<String> = []
    private var changePending = false
    /// Entities the island's dashboard shows (fan, AC remote, media players, status): their
    /// changes are reported through `onDashboardChange` rather than as device changes.
    public var dashboardEntities: Set<String> = []
    public var onDashboardChange: (() -> Void)?
    /// Every new state of a dashboard entity as it arrives: (entity id, state).
    public var onDashboardState: ((String, String) -> Void)?
    private var dashboardPending = false

    public init(vault: SecretStore) {
        self.vault = vault
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        session = URLSession(configuration: configuration)
        config = vault.read().flatMap { try? JSONDecoder().decode(Config.self, from: $0) }
        if config != nil { listen() }
    }

    public var isConnected: Bool { config != nil }

    public var info: [String: Any] {
        guard let config else { return ["connected": false] }
        return ["connected": true, "url": config.url, "name": config.name ?? "Home Assistant", "version": config.version ?? ""]
    }

    /// For the iPhone: the Mac shares its connection over the paired, encrypted sync.
    public var shareable: [String: Any]? {
        guard let config else { return nil }
        return ["url": Self.phoneURL() ?? config.url, "token": config.token, "name": config.name ?? "", "version": config.version ?? ""]
    }

    // MARK: - Connecting

    /// Checks the address and the token, then keeps them.
    public func connect(url raw: String, token: String) async throws {
        let url = try Self.normalize(raw)
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw ServiceFailure("Paste a long-lived access token (your profile in Home Assistant → Security).") }
        var candidate = Config(url: url, token: token)
        let about = try await request("GET", "/api/config", config: candidate) as? [String: Any] ?? [:]
        candidate.name = about["location_name"] as? String
        candidate.version = about["version"] as? String
        config = candidate
        vault.write(try? JSONEncoder().encode(candidate))
        listen()
    }

    /// Takes a connection shared by the Mac; nil removes it.
    public func adopt(_ shared: [String: Any]?) {
        guard let shared, let url = shared["url"] as? String, let token = shared["token"] as? String else {
            if config != nil { disconnect() }
            return
        }
        let name = (shared["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        guard config?.url != url || config?.token != token || config?.name != name else { return }
        config = Config(url: url, token: token, name: name, version: shared["version"] as? String)
        vault.write(try? JSONEncoder().encode(config))
        listen()
    }

    public func watch(_ ids: Set<String>) { watched = ids }

    public func disconnect() {
        config = nil
        vault.write(nil)
        socketRetry?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    /// "homeassistant.local:8123" → "http://homeassistant.local:8123".
    static func normalize(_ raw: String) throws -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw ServiceFailure("Enter the address of your Home Assistant, for example http://homeassistant.local:8123") }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil, ["http", "https"].contains(url.scheme ?? "") else {
            throw ServiceFailure("“\(raw)” is not a web address")
        }
        if url.port == nil, url.scheme == "http", (url.host ?? "").hasSuffix(".local") || url.host == "homeassistant" {
            s += ":8123" // Home Assistant's default port, which people leave out
        }
        return s
    }

    // MARK: - Devices

    /// Entities that must never be listed or switched, e.g. the plug that powers this Mac or the
    /// router: `homeassistant-blocked.json` in the data folder, a JSON array of entity ids.
    /// Read on every use, so editing the file takes effect without restarting.
    private static var dataDirectory: URL {
        if let custom = ProcessInfo.processInfo.environment["HOUSE_DATA_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("HouseControl", isDirectory: true)
    }

    /// The address the iPhone should use, when the Mac's own (a tunnel on 127.0.0.1) is not
    /// reachable from it: `homeassistant-phone.json` in the data folder, `{"url": "http://…"}`.
    static func phoneURL() -> String? {
        guard let data = try? Data(contentsOf: dataDirectory.appendingPathComponent("homeassistant-phone.json")),
              let url = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["url"] as? String,
              let clean = try? normalize(url) else { return nil }
        return clean
    }

    static func blockedEntities() -> Set<String> {
        let directory = dataDirectory
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("homeassistant-blocked.json")),
              let ids = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
        return Set(ids)
    }

    public func devices() async throws -> [ServiceDevice] {
        let blocked = Self.blockedEntities()
        let states = (try await request("GET", "/api/states") as? [[String: Any]] ?? [])
            .filter { !blocked.contains($0["entity_id"] as? String ?? "") }
        let areas = (try? await areaNames(for: states.compactMap { $0["entity_id"] as? String })) ?? [:]
        return states.compactMap { state in
            guard var device = Self.device(from: state) else { return nil }
            device.room = areas[device.id]
            return device
        }.sorted { ($0.kind.rawValue, $0.name) < ($1.kind.rawValue, $1.name) }
    }

    /// Area of every entity, in one template request (the REST API has no area endpoint).
    private func areaNames(for ids: [String]) async throws -> [String: String] {
        let template = "{% for e in states %}{{ e.entity_id }}\t{{ area_name(e.entity_id) or '' }}\n{% endfor %}"
        guard let text = try await request("POST", "/api/template", body: ["template": template], raw: true) as? String else { return [:] }
        var out: [String: String] = [:]
        for line in text.split(separator: "\n") {
            let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
            if parts.count == 2, !parts[1].isEmpty, parts[1] != "None" { out[parts[0]] = parts[1] }
        }
        return out
    }

    public func read(_ ids: Set<String>) async throws -> [String: DeviceReading] {
        guard !ids.isEmpty else { return [:] }
        let states = try await request("GET", "/api/states") as? [[String: Any]] ?? []
        var out: [String: DeviceReading] = [:]
        for state in states {
            guard let id = state["entity_id"] as? String, ids.contains(id) else { continue }
            let attributes = state["attributes"] as? [String: Any] ?? [:]
            if id.hasPrefix("climate.") {
                fanNames[id] = FanNames.table(attributes["fan_modes"] as? [String] ?? [])
                modeNames[id] = Self.modeTable(attributes["hvac_modes"] as? [String] ?? [])
                swingNames[id] = attributes["swing_modes"] as? [String] ?? []
            }
            out[id] = Self.reading(from: state)
        }
        return out
    }

    /// The raw state of each of `ids` (blocked entities left out): `{state, attributes}`.
    public func states(_ ids: Set<String>) async throws -> [String: [String: Any]] {
        guard !ids.isEmpty else { return [:] }
        let blocked = Self.blockedEntities()
        let states = try await request("GET", "/api/states") as? [[String: Any]] ?? []
        var out: [String: [String: Any]] = [:]
        for state in states {
            guard let id = state["entity_id"] as? String, ids.contains(id), !blocked.contains(id) else { continue }
            out[id] = ["state": state["state"] ?? "", "attributes": state["attributes"] ?? [:],
                       "last_changed": state["last_changed"] ?? ""]
        }
        return out
    }

    /// The numeric history of each of `ids` over the last `hours`: `[[epoch ms, value]]`,
    /// oldest first. Readings that are not numbers ("unavailable") are left out.
    public func history(_ ids: Set<String>, hours: Double) async throws -> [String: [[Double]]] {
        let blocked = Self.blockedEntities()
        let wanted = ids.subtracting(blocked).sorted()
        guard !wanted.isEmpty else { return [:] }
        let start = Date().addingTimeInterval(-hours * 3600)
        let stamp = ISO8601DateFormatter().string(from: start)
        let path = "/api/history/period/\(stamp)?filter_entity_id=\(wanted.joined(separator: ","))&minimal_response&no_attributes"
        let series = try await request("GET", path) as? [[[String: Any]]] ?? []
        let parse = ISO8601DateFormatter()
        parse.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        var out: [String: [[Double]]] = [:]
        for points in series {
            guard let id = points.first?["entity_id"] as? String else { continue }
            out[id] = points.compactMap { point in
                guard let text = point["state"] as? String, let value = Double(text),
                      let when = point["last_changed"] as? String,
                      let date = parse.date(from: when) ?? plain.date(from: when) else { return nil }
                return [date.timeIntervalSince1970 * 1000, value]
            }
        }
        return out
    }

    /// The long-term statistics of each of `ids` from `start` on, hour by hour:
    /// `[[epoch ms, change, state]]`, oldest first. Home Assistant keeps them for good, where the
    /// state history behind `history` is purged after days; only sensors with a state class have them.
    public func statistics(_ ids: Set<String>, since start: Date) async throws -> [String: [[Double]]] {
        let wanted = ids.subtracting(Self.blockedEntities()).sorted()
        guard !wanted.isEmpty else { return [:] }
        let result = try await socketRequest([
            "type": "recorder/statistics_during_period", "start_time": ISO8601DateFormatter().string(from: start),
            "statistic_ids": wanted, "period": "hour", "types": ["change", "state"],
        ]) as? [String: [[String: Any]]] ?? [:]
        return result.mapValues { rows in
            rows.compactMap { row in
                guard let start = row["start"] as? Double, let change = row["change"] as? Double,
                      let state = row["state"] as? Double else { return nil }
                return [start, change, state]
            }
        }
    }

    /// The state of one entity (nil when unknown or blocked).
    public func state(of id: String) async throws -> String? {
        guard !Self.blockedEntities().contains(id) else { return nil }
        return (try await request("GET", "/api/states/\(id)") as? [String: Any])?["state"] as? String
    }

    /// Calls a service. The caller decides what may be called; blocked entities never are.
    public func callService(domain: String, service: String, data: [String: Any]) async throws {
        let target = data["entity_id"] as? String ?? (domain == "script" ? "script.\(service)" : "")
        guard !Self.blockedEntities().contains(target) else {
            throw ServiceFailure("\(target) is blocked in homeassistant-blocked.json")
        }
        try await request("POST", "/api/services/\(domain)/\(service)", body: data)
    }

    public func send(kind: DeviceKind, id: String, patch: [String: Any], state: [String: Any]) async throws {
        guard !Self.blockedEntities().contains(id) else {
            throw ServiceFailure("\(id) is blocked in homeassistant-blocked.json")
        }
        for call in Self.calls(for: id, patch: patch, state: state,
                               fans: fanNames[id] ?? [:], modes: modeNames[id] ?? [:], swings: swingNames[id] ?? []) {
            _ = try await request("POST", "/api/services/\(call.domain)/\(call.service)", body: call.data)
        }
    }

    // MARK: - Mapping (static, so the tests can run it without a server)

    static func device(from state: [String: Any]) -> ServiceDevice? {
        guard let id = state["entity_id"] as? String else { return nil }
        let attributes = state["attributes"] as? [String: Any] ?? [:]
        let name = attributes["friendly_name"] as? String ?? id
        let domain = id.split(separator: ".").first.map(String.init) ?? ""
        var device: ServiceDevice
        switch domain {
        case "light":
            device = ServiceDevice(id: id, name: name, kind: .light)
            let modes = attributes["supported_color_modes"] as? [String] ?? []
            device.capabilities = lightCapabilities(modes)
            device.detail = "light · " + (modes.isEmpty ? "on/off" : modes.joined(separator: ", "))
        case "switch":
            device = ServiceDevice(id: id, name: name, kind: .light)
            device.detail = "switch · on/off"
        case "climate":
            device = ServiceDevice(id: id, name: name, kind: .ac)
            if let lo = attributes.double("min_temp"), let hi = attributes.double("max_temp") {
                device.range = (max(lo, 10), min(hi, 32))
            }
            device.detail = "climate · " + (attributes["hvac_modes"] as? [String] ?? []).joined(separator: ", ")
        case "sensor":
            guard isTemperature(attributes) else { return nil }
            device = ServiceDevice(id: id, name: name, kind: .sensor)
            device.detail = "temperature sensor"
        default:
            return nil
        }
        device.online = !["unavailable", "unknown"].contains(state["state"] as? String ?? "")
        return device
    }

    static func lightCapabilities(_ modes: [String]) -> [String] {
        var caps: [String] = []
        if modes.contains(where: { $0 != "onoff" }) { caps.append("brightness") }
        if modes.contains("color_temp") { caps.append("temp") }
        if modes.contains(where: { ["hs", "xy", "rgb", "rgbw", "rgbww"].contains($0) }) { caps.append("color") }
        return caps
    }

    static func isTemperature(_ attributes: [String: Any]) -> Bool {
        (attributes["device_class"] as? String) == "temperature"
            || ["°C", "°F"].contains(attributes["unit_of_measurement"] as? String ?? "")
    }

    /// The panel's AC modes and the climate entity's names for them.
    static func modeTable(_ hvacModes: [String]) -> [String: String] {
        var out: [String: String] = [:]
        for (panel, names) in [("cool", ["cool"]), ("heat", ["heat"]), ("dry", ["dry"]),
                               ("fan", ["fan_only"]), ("auto", ["auto", "heat_cool"])] {
            if let name = names.first(where: hvacModes.contains) { out[panel] = name }
        }
        return out
    }

    static func reading(from state: [String: Any]) -> DeviceReading {
        let id = state["entity_id"] as? String ?? ""
        let value = state["state"] as? String ?? ""
        let attributes = state["attributes"] as? [String: Any] ?? [:]
        var reading = DeviceReading(online: !["unavailable", "unknown"].contains(value))
        guard reading.online else { return reading }

        if id.hasPrefix("light.") || id.hasPrefix("switch.") {
            var light: [String: Any] = ["on": value == "on"]
            if value == "on", let b = attributes.double("brightness") { light["brightness"] = max(0.05, min(1, b / 255)) }
            switch attributes["color_mode"] as? String {
            case "color_temp":
                if let k = attributes.double("color_temp_kelvin") { light["temp"] = max(2200, min(6500, k)); light["color"] = NSNull() }
            case "hs", "xy", "rgb", "rgbw", "rgbww":
                if let rgb = attributes["rgb_color"] as? [Any], rgb.count == 3 {
                    let c = rgb.compactMap { ($0 as? NSNumber)?.doubleValue }
                    if c.count == 3 { light["color"] = ColorMath.hex(r: c[0] / 255, g: c[1] / 255, b: c[2] / 255) }
                }
            default: break
            }
            reading.light = light
        } else if id.hasPrefix("climate.") {
            let modes = modeTable(attributes["hvac_modes"] as? [String] ?? [])
            var ac: [String: Any] = ["on": value != "off"]
            if let mode = modes.first(where: { $0.value == value })?.key { ac["mode"] = mode }
            if let t = attributes.double("temperature") {
                ac["target"] = t
            } else if let lo = attributes.double("target_temp_low"), let hi = attributes.double("target_temp_high") {
                ac["target"] = ((lo + hi) / 2).rounded()
            }
            if let room = attributes.double("current_temperature") { ac["roomTemp"] = room }
            let fans = FanNames.table(attributes["fan_modes"] as? [String] ?? [])
            if let current = attributes["fan_mode"] as? String,
               let fan = fans.first(where: { $0.value == current })?.key ?? FanNames.panel(current), fans[fan] != nil { ac["fan"] = fan }
            let swings = attributes["swing_modes"] as? [String] ?? []
            if let swing = attributes["swing_mode"] as? String, !swings.isEmpty { ac["swing"] = swing == "off" ? "off" : "swing" }
            let presets = attributes["preset_modes"] as? [String] ?? []
            let preset = attributes["preset_mode"] as? String ?? ""
            if presets.contains("sleep") { ac["sleep"] = preset == "sleep" }
            if presets.contains("eco") { ac["eco"] = preset == "eco" }
            reading.ac = ac
            reading.features = [
                "modes": ["cool", "heat", "dry", "fan", "auto"].filter { modes[$0] != nil },
                "fans": FanNames.order.filter { fans[$0] != nil },
                "swing": swings.contains("off") && swings.count > 1,
                "sleep": presets.contains("sleep"), "eco": presets.contains("eco"),
            ]
        } else if id.hasPrefix("sensor."), let t = Double(value) {
            reading.temperature = (attributes["unit_of_measurement"] as? String) == "°F" ? (t - 32) * 5 / 9 : t
        }
        return reading
    }

    struct Call {
        var domain: String
        var service: String
        var data: [String: Any]
    }

    /// The entity's name for "swinging": "on" where it has one, else one of its directions
    /// (a Midea split lists only off, vertical, horizontal and both).
    static func swingOn(_ swingModes: [String]) -> String {
        ["on", "vertical", "both"].first(where: swingModes.contains) ?? swingModes.first { $0 != "off" } ?? "on"
    }

    static func calls(for id: String, patch: [String: Any], state: [String: Any],
                      fans: [String: String], modes: [String: String], swings: [String] = []) -> [Call] {
        let domain = id.split(separator: ".").first.map(String.init) ?? ""
        let target: [String: Any] = ["entity_id": id]
        func call(_ service: String, _ data: [String: Any] = [:], domain d: String = domain) -> Call {
            Call(domain: d, service: service, data: target.merging(data) { $1 })
        }

        if domain == "switch" {
            guard let on = patch["on"] as? Bool else { return [] }
            return [call(on ? "turn_on" : "turn_off")]
        }
        if domain == "light" {
            if patch["on"] as? Bool == false { return [call("turn_off")] }
            var data: [String: Any] = [:]
            if let b = patch["brightness"] as? Double { data["brightness_pct"] = Int((b * 100).rounded()) }
            if let k = patch["temp"] as? Double { data["color_temp_kelvin"] = Int(k) }
            if let hex = patch["color"] as? String, let (r, g, b) = ColorMath.rgb(hex) {
                data["rgb_color"] = [Int(r * 255), Int(g * 255), Int(b * 255)]
            }
            guard !data.isEmpty || patch["on"] as? Bool == true else { return [] }
            return [call("turn_on", data)]
        }
        guard domain == "climate" else { return [] }

        var out: [Call] = []
        let on = patch["on"] as? Bool
        if on == false { return [call("set_hvac_mode", ["hvac_mode": "off"])] }
        // Picking a mode is what switches a climate entity on.
        if on == true || patch["mode"] != nil {
            let mode = (patch["mode"] as? String) ?? (state["mode"] as? String) ?? "cool"
            if let name = modes[mode] ?? modes.values.first { out.append(call("set_hvac_mode", ["hvac_mode": name])) }
        }
        if let t = patch["target"] as? Double {
            out.append(call("set_temperature", ["temperature": t]))
        }
        if let fan = patch["fan"] as? String, let name = fans[fan] {
            out.append(call("set_fan_mode", ["fan_mode": name]))
        }
        if let swing = patch["swing"] as? String {
            out.append(call("set_swing_mode", ["swing_mode": swing == "off" ? "off" : swingOn(swings)]))
        }
        for preset in ["sleep", "eco"] {
            if let enabled = patch[preset] as? Bool {
                out.append(call("set_preset_mode", ["preset_mode": enabled ? preset : "none"]))
            }
        }
        return out
    }

    // MARK: - HTTP

    @discardableResult
    private func request(_ method: String, _ path: String, body: [String: Any]? = nil,
                         raw: Bool = false, config: Config? = nil) async throws -> Any? {
        guard let config = config ?? self.config, let url = URL(string: config.url + path) else {
            throw ServiceFailure("Connect Home Assistant first")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ServiceFailure("Home Assistant at \(config.url) did not answer: \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200..<300: break
        case 401, 403: throw ServiceFailure("Home Assistant refused the token. Create a new long-lived access token and connect again.")
        case 404: throw ServiceFailure("Home Assistant does not know \(path). Is the API enabled?")
        default:
            let text = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
            throw ServiceFailure("Home Assistant answered \(status) \(text)")
        }
        if raw { return String(data: data, encoding: .utf8) }
        return data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)
    }

    /// One command of the WebSocket API, for what the REST API lacks (statistics), on a socket of
    /// its own: connect, authenticate, ask, close. Its `result`.
    private func socketRequest(_ command: [String: Any]) async throws -> Any? {
        guard let config, var parts = URLComponents(string: config.url + "/api/websocket") else {
            throw ServiceFailure("Connect Home Assistant first")
        }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        guard let url = parts.url else { throw ServiceFailure("Connect Home Assistant first") }
        let task = session.webSocketTask(with: url)
        task.resume()
        defer { task.cancel(with: .normalClosure, reason: nil) }
        func receive() async throws -> [String: Any] {
            guard case .string(let text) = try await task.receive() else { return [:] }
            return (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]) ?? [:]
        }
        do {
            _ = try await receive() // auth_required
            try await task.send(.string(Self.json(["type": "auth", "access_token": config.token])))
            guard try await receive()["type"] as? String == "auth_ok" else {
                throw ServiceFailure("Home Assistant refused the token. Create a new long-lived access token and connect again.")
            }
            var message = command
            message["id"] = 1
            try await task.send(.string(Self.json(message)))
            while true {
                let reply = try await receive()
                guard reply["id"] as? Int == 1 else { continue }
                if reply["success"] as? Bool == true { return reply["result"] }
                let reason = (reply["error"] as? [String: Any])?["message"] as? String ?? "failed"
                throw ServiceFailure("Home Assistant: \(command["type"] ?? "") \(reason)")
            }
        } catch let failure as ServiceFailure {
            throw failure
        } catch {
            throw ServiceFailure("Home Assistant at \(config.url) did not answer: \(error.localizedDescription)")
        }
    }

    // MARK: - Live updates

    /// Subscribes to state changes of the entities the hub cares about, and says so through
    /// `onChange`. Reconnects by itself; polling covers the gaps.
    private func listen() {
        socketRetry?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        guard let config, var parts = URLComponents(string: config.url + "/api/websocket") else { return }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        guard let url = parts.url else { return }
        let task = session.webSocketTask(with: url)
        socket = task
        task.resume()
        Task { @MainActor [weak self] in
            await self?.run(task, token: config.token)
        }
    }

    private func run(_ task: URLSessionWebSocketTask, token: String) async {
        do {
            _ = try await task.receive() // auth_required
            try await task.send(.string(Self.json(["type": "auth", "access_token": token])))
            _ = try await task.receive() // auth_ok
            try await task.send(.string(Self.json(["id": 1, "type": "subscribe_events", "event_type": "state_changed"])))
            while task === socket {
                let message = try await task.receive()
                guard case .string(let text) = message,
                      let event = (try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])?["event"] as? [String: Any],
                      let entity = (event["data"] as? [String: Any])?["entity_id"] as? String else { continue }
                if dashboardEntities.contains(entity),
                   let state = ((event["data"] as? [String: Any])?["new_state"] as? [String: Any])?["state"] as? String {
                    onDashboardState?(entity, state)
                }
                if dashboardEntities.contains(entity), !dashboardPending {
                    dashboardPending = true
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        self?.dashboardPending = false
                        self?.onDashboardChange?()
                    }
                }
                guard watched.contains(entity), !changePending else { continue }
                // A burst of changes (a scene) becomes one read.
                changePending = true
                Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    self?.changePending = false
                    self?.onChange?()
                }
            }
        } catch {
            guard task === socket, config != nil else { return }
            socketRetry = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { return }
                self?.listen()
            }
        }
    }

    private static func json(_ object: [String: Any]) -> String {
        (try? JSONSerialization.data(withJSONObject: object)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}
